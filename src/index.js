// @flow

import assert from 'assert'
import logger from 'log4jcore'
import EventEmitter from '@jcoreio/typed-event-emitter'

import {MessageClient} from 'socket-ipc'
import {VError} from 'verror'

const log = logger('spi-hub-client')

const SPI_HUB_SOCKET_PATH = '/tmp/socket-spi-hub'

const IPC_PROTO_VERSION = 2

// Commands that are valid both on the SPI bus and on the IPC socket
const SPI_HUB_CMD_MSG_TO_DEVICE = 1
const SPI_HUB_CMD_MSG_FROM_DEVICE = 2
// Commands that are only valid on the IPC socket
const SPI_HUB_CMD_DEVICES_LIST = 100

const IPC_MESSAGE_FROM_DEVICE_OVERHEAD = 7

const IPC_MESSAGES_TO_DEVICE_OVERHEAD = 4 // Overhead at the beginning = proto version + message type + 2 byte length
const IPC_OVERHEAD_PER_MESSAGE_TO_DEVICE = 8 // Overhead per message

const IPC_MESSAGE_TO_DEVICE_PREAMBLE = 0xA3

export const SPI_HUB_EVENT_MESSAGE = 'message'
export const SPI_HUB_EVENT_DEVICES_CHANGED = 'devicesChanged'

export type SPIHubClientOpts = {
  binary?: ?boolean,
}

export type MessageToSPI = {
  busId: number,
  deviceId: number,
  channel: number,
  deDupeId?: ?number,
  message: string | Buffer,
}

export type MessageFromSPI = {
  busId: number,
  deviceId: number,
  channel: number,
  message?: string,
  messageBuffer?: Buffer,
}

export type SPIDetectedDevice = {
  busId: number,
  deviceId: number,
  deviceInfo: {
    model: string,
    version: string,
  },
}

export type SPIDevicesChangedEvent = {
  devices: Array<SPIDetectedDevice>,
  serialNumber: string,
  accessCode: string,
}

export type SPIHubClientEmittedEvents = {
  message: [MessageFromSPI],
  devicesChanged: [SPIDevicesChangedEvent],
  error: [Error],
}

type MessageToSPIState = {
  txMessage: MessageToSPI,
  payload: Buffer,
}

export default class SPIHubClient extends EventEmitter<SPIHubClientEmittedEvents> {

  _binary: boolean
  _ipcClient: Object

  constructor(opts: SPIHubClientOpts = {}) {
    super()
    this._binary = !!opts.binary
    const ipcClient = this._ipcClient = new MessageClient(SPI_HUB_SOCKET_PATH, { binary: true })
    ipcClient.on('message', (message: Object) => this._onIPCMessage(message))
    ipcClient.on('error', (err: any) => this.emit('error', new VError(err, 'SPIHubClient socket error')))
  }

  start() {
    this._ipcClient.start()
  }

  send(txMessages: Array<MessageToSPI> | MessageToSPI) {
    assert(txMessages)
    const txMessagesArr: Array<MessageToSPI> = Array.isArray(txMessages) ? txMessages : [txMessages]

    // Encode payloads to binary buffers
    const messageStates: Array<MessageToSPIState> = txMessagesArr.map((txMessage: MessageToSPI) => {
      const {message} = txMessage
      return {
        txMessage,
        payload: typeof message === 'string' ? Buffer.from(message) : message
      }
    })

    // Calculate required size and allocate buffer
    const messagesLenTotal = messageStates.reduce((sum: number, entry: MessageToSPIState) =>
      sum + IPC_OVERHEAD_PER_MESSAGE_TO_DEVICE + entry.payload.length, 0)
    const ipcMsgBuf = Buffer.alloc(IPC_MESSAGES_TO_DEVICE_OVERHEAD + messagesLenTotal)

    // Write IPC message preamble
    let pos = 0
    ipcMsgBuf.writeUInt8(IPC_PROTO_VERSION, pos++)
    ipcMsgBuf.writeUInt8(SPI_HUB_CMD_MSG_TO_DEVICE, pos++)
    ipcMsgBuf.writeUInt16LE(messageStates.length, pos)
    pos += 2

    // Write messages to IPC message buffer
    for (const messageState: MessageToSPIState of messageStates) {
      const {txMessage: {busId, deviceId, channel, deDupeId}, payload} = messageState
      const deDupeIdFinal = deDupeId || 0
      validateUInt8(busId, 'busId')
      validateUInt8(deviceId, 'deviceId')
      validateUInt8(channel, 'channel')
      validateUInt16(deDupeIdFinal, 'deDupeId')

      ipcMsgBuf.writeUInt8(IPC_MESSAGE_TO_DEVICE_PREAMBLE, pos++)
      ipcMsgBuf.writeUInt8(busId, pos++)
      ipcMsgBuf.writeUInt8(deviceId, pos++)
      ipcMsgBuf.writeUInt8(channel, pos++)
      ipcMsgBuf.writeUInt16LE(deDupeIdFinal, pos)
      pos += 2
      ipcMsgBuf.writeUInt16LE(payload.length, pos)
      pos += 2
      payload.copy(ipcMsgBuf, pos)
      pos += payload.length
    }
    // Send the IPC message
    this._ipcClient.send(ipcMsgBuf)
  }

  _onIPCMessage(event: {data: Buffer}) {
    const ipcMsgBuf = event.data
    try {
      assert(ipcMsgBuf.length > 2, 'ipc message is too short')
      let pos = 0
      const version = ipcMsgBuf.readUInt8(pos++)
      const cmd = ipcMsgBuf.readUInt8(pos++)
      assert.strictEqual(version, IPC_PROTO_VERSION, 'unexpected protocol version')
      switch (cmd) {
      case SPI_HUB_CMD_DEVICES_LIST: {
        const strMessage = ipcMsgBuf.toString('utf8', pos)
        const {devices, serialNumber, accessCode} = JSON.parse(strMessage)
        this.emit(SPI_HUB_EVENT_DEVICES_CHANGED, {devices, serialNumber, accessCode})
      } break
      case SPI_HUB_CMD_MSG_FROM_DEVICE: {
        assert(ipcMsgBuf.length >= IPC_MESSAGE_FROM_DEVICE_OVERHEAD, 'message from device is too short')
        const busId = ipcMsgBuf.readUInt8(pos++)
        const deviceId = ipcMsgBuf.readUInt8(pos++)
        const channel = ipcMsgBuf.readUInt8(pos++)
        pos += 2 // Throw away the de-dupe ID
        const messageFromSPI: MessageFromSPI = {busId, deviceId, channel}
        if (this._binary) {
          const messageBuffer = messageFromSPI.messageBuffer = Buffer.alloc(ipcMsgBuf.length - pos)
          ipcMsgBuf.copy(messageBuffer, 0, pos)
        } else {
          messageFromSPI.message = ipcMsgBuf.toString('utf8', pos)
        }
        this.emit(SPI_HUB_EVENT_MESSAGE, messageFromSPI)
      } break
      default:
        throw Error('unexpected IPC message ID: ' + cmd)
      }
    } catch (err) {
      log.error('could not process an incoming IPC message', err)
    }
  }
}

function validateUInt8(val: number, fieldName: string) {
  validateUInt(val, fieldName, 255)
}

function validateUInt16(val: number, fieldName: string) {
  validateUInt(val, fieldName, 65535)
}

function validateUInt(val: number, fieldName: string, maxValue: number) {
  if (!Number.isInteger(val)) throw Error(`${fieldName} must be a valid integer`)
  if (val < 0) throw Error(`${fieldName} must be at least 0`)
  if (val > maxValue) throw Error(`${fieldName} must be ${maxValue} or less`)
}
