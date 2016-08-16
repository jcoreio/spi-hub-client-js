
'use strict'

const assert = require('assert')
const util = require('util')
const EventEmitter = require('events').EventEmitter

const _ = require('lodash')
const ipc = require('socket-ipc')

const SPI_HUB_SOCKET_PATH = '/tmp/socket-spi-hub'

const IPC_PROTO_VERSION = 1

// Commands that are valid both on the SPI bus and on the IPC socket
const SPI_HUB_CMD_MSG_TO_DEVICE   = 1
const SPI_HUB_CMD_MSG_FROM_DEVICE = 2
// Commands that are only valid on the IPC socket
const SPI_HUB_CMD_DEVICES_LIST    = 100

const IPC_DEVICE_MESSAGE_OVERHEAD = 7

const nodeVersion = process.version.split('.');
const isNode6 = nodeVersion.length >= 3 && nodeVersion[0] >= 6;

module.exports = SPIHubClient

function SPIHubClient(options) {
  EventEmitter.call(this)
  options = options || {}
  this._binary = !!options.binary
  this._ipcClient = new ipc.MessageClient(SPI_HUB_SOCKET_PATH, { binary: true })
  var self = this
  this._ipcClient.on('message', function(message) { self._onIPCMessage(message) })
  this._ipcClient.start()
}

util.inherits(SPIHubClient, EventEmitter)

SPIHubClient.prototype.send = function send(opts) {
  if(opts == undefined) throw new Error('message must be provided')
  let bus = 0
  let device = 0
  let channel = 0
  let msgDeDupeId = 0
  let message = undefined
  if(_.isObject(opts)) {
    bus         = validateUInt8(opts.bus,          'bus')
    device      = validateUInt8(opts.device,       'device')
    channel     = validateUInt8(opts.channel,      'channel')
    msgDeDupeId = validateUInt16(opts.msgDeDupeId, 'msgDeDupeId')
    message = opts.message
  } else {
    message = opts
  }
  let msgPayloadBuffer = undefined
  if(_.isString(message)) {
    msgPayloadBuffer = stringToBuffer(message)
  } else if(_.isBuffer(message)) {
    msgPayloadBuffer = message
  } else {
    throw new Error('message data must be either a string or a Buffer')
  }

  const ipcMsgBuf = allocBuffer(msgPayloadBuffer.length + IPC_DEVICE_MESSAGE_OVERHEAD)
  let pos = 0
  ipcMsgBuf.writeUInt8(IPC_PROTO_VERSION, pos++)
  ipcMsgBuf.writeUInt8(SPI_HUB_CMD_MSG_TO_DEVICE, pos++)
  ipcMsgBuf.writeUInt8(bus, pos++)
  ipcMsgBuf.writeUInt8(device, pos++)
  ipcMsgBuf.writeUInt8(channel, pos++)
  ipcMsgBuf.writeUInt16LE(msgDeDupeId, pos)
  pos += 2
  msgPayloadBuffer.copy(ipcMsgBuf, pos)
  this._ipcClient.send(ipcMsgBuf)
}

SPIHubClient.prototype._onIPCMessage = function(event) {
  const ipcMsgBuf = event.data;
  try {
    assert(ipcMsgBuf.length > 2, 'ipc message is too short')
    let pos = 0
    const version = ipcMsgBuf.readUInt8(pos++)
    const cmd = ipcMsgBuf.readUInt8(pos++)
    assert(version === IPC_PROTO_VERSION, `unexpected protocol version: ${version}`)
    switch(cmd) {
      case SPI_HUB_CMD_DEVICES_LIST:
        const strDevicesList = ipcMsgBuf.toString('utf8', pos)
        const devicesList = JSON.parse(strDevicesList)
        this.emit('devicesChanged', devicesList)
        break;
      case SPI_HUB_CMD_MSG_FROM_DEVICE:
        assert(ipcMsgBuf.length >= IPC_DEVICE_MESSAGE_OVERHEAD, 'message from device is too short')
        const bus     = ipcMsgBuf.readUInt8(pos++)
        const device  = ipcMsgBuf.readUInt8(pos++)
        const channel = ipcMsgBuf.readUInt8(pos++)
        pos += 2 // Throw away the de-dupe ID
        let message = undefined;
        if(this._binary) {
          message = allocBuffer(ipcMsgBuf.length - pos)
          ipcMsgBuf.copy(message, 0, pos)
        } else {
          message = ipcMsgBuf.toString('utf8', pos)
        }
        this.emit('message', { bus, device, channel, message });
        break;
      default:
        throw new Error(`unexpected IPC message ID: ${cmd}`)
    }
  } catch (err) {
    console.error(`spi-hub-client could not process an incoming IPC message:`, err.stack);
  }
}

function validateUInt8(val, fieldName) {
  return validateUInt(val, fieldName, 255)
}

function validateUInt16(val, fieldName) {
  return validateUInt(val, fieldName, 65535)
}

function validateUInt(val, fieldName, maxValue) {
  if(val == undefined) {
    return 0;
  }
  if(!_.isInteger(val)) {
    console.log(`warning: ${fieldName} must be an integer`)
    return 0
  }
  if(val < 0) {
    console.log(`warning: ${fieldName} must be at least 0`)
    return 0
  }
  if(val > maxValue) {
    console.log(`warning: ${fieldName} must be less than or equal to ${maxValue}`)
    return 0
  }
  return val
}

function allocBuffer(len) {
  const buf = isNode6 ? Buffer.alloc(len) : new Buffer(len)
  if(!isNode6) buf.fill(0)
  return buf
}

function stringToBuffer(str) {
  return isNode6 ? Buffer.from(str) : new Buffer(str)
}

