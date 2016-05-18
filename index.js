
'use strict'

const assert = require('assert')
const util = require('util')
const EventEmitter = require('events').EventEmitter

const _ = require('lodash')
const ipc = require('socket-ipc')

const SPI_HUB_SOCKET_PATH = '/tmp/socket-spi-hub'

const IPC_PROTO_VERSION = 1

const IPC_MSG_DEVICES_LIST        = 1
const IPC_MSG_MESSAGE_TO_DEVICE   = 2
const IPC_MSG_MESSAGE_FROM_DEVICE = 3

const IPC_DEVICE_MESSAGE_OVERHEAD = 5

const nodeVersion = process.version.split('.');
const isNode6 = nodeVersion.length >= 3 && nodeVersion[0] >= 6;

module.exports = SPIHubClient

function SPIHubClient(options) {
  EventEmitter.call(this)
  options = options || {}
  this._binary = !!options.binary
  this._ipcClient = new ipc.MessageClient(SPI_HUB_SOCKET_PATH, { binary: true })
  this._ipcClient.on('message', message => this._onIPCMessage(message))
  this._ipcClient.start()
}

util.inherits(SPIHubClient, EventEmitter)

SPIHubClient.prototype.send = function send(message) {
  if(message == undefined) throw new Error('message must be provided')
  let bus = 0
  let device = 0
  let channel = 0
  let data = undefined
  if(_.isObject(message)) {
    bus     = validateUInt8(message.bus, 'bus')
    device  = validateUInt8(message.bus, 'device')
    channel = validateUInt8(message.bus, 'channel')
    data = message.data
  } else {
    data = message
  }
  let dataBuffer = undefined
  if(_.isString(data)) {
    dataBuffer = stringToBuffer(data)
  } else if(_.isBuffer(data)) {
    dataBuffer = data
  } else {
    throw new Error('message data must be either a string or a Buffer')
  }

  const ipcMsgBuf = allocBuffer(dataBuffer.length + IPC_DEVICE_MESSAGE_OVERHEAD)
  ipcMsgBuf.writeUInt8(IPC_PROTO_VERSION, 0)
  ipcMsgBuf.writeUInt8(IPC_MSG_MESSAGE_TO_DEVICE, 1)
  ipcMsgBuf.writeUInt8(bus, 2)
  ipcMsgBuf.writeUInt8(device, 3)
  ipcMsgBuf.writeUInt8(channel, 4)
  dataBuffer.copy(ipcMsgBuf, 5)
  this._ipcClient.send(ipcMsgBuf)
}

SPIHubClient.prototype._onIPCMessage = function(event) {
  const message = event.data;
  try {
    assert(message.length > 2, 'message is too short')
    const version = message.readUInt8(0)
    const msg = message.readUInt8(1)
    assert(version === IPC_PROTO_VERSION, `unexpected protocol version: ${version}`)
    switch(msg) {
      case IPC_MSG_DEVICES_LIST:
        const strDevicesList = message.toString('utf8', 2)
        const devicesList = JSON.parse(strDevicesList)
        this.emit('devicesChanged', devicesList)
        break;
      case IPC_MSG_MESSAGE_FROM_DEVICE:
        assert(message.length >= IPC_DEVICE_MESSAGE_OVERHEAD, 'message from device is too short')
        const bus     = message.readUInt8(2)
        const device  = message.readUInt8(3)
        const channel = message.readUInt8(4)
        let data = undefined;
        if(this._binary) {
          data = allocBuffer(message.length - IPC_DEVICE_MESSAGE_OVERHEAD)
          message.copy(data, 0, IPC_DEVICE_MESSAGE_OVERHEAD)
        } else {
          data = message.toString('utf8', IPC_DEVICE_MESSAGE_OVERHEAD)
        }
        this.emit('message', { bus, device, channel, data });
        break;
      default:
        throw new Error(`unexpected IPC message ID: ${msg}`)
    }
  } catch (err) {
    console.error(`spi-hub-client could not process an incoming IPC message:`, err.stack);
  }
}

function validateUInt8(val, fieldName) {
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
  if(val > 255) {
    console.log(`warning: ${fieldName} must be less than or equal to 255`)
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

