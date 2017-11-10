#!/usr/bin/env node

'use strict'

const LED_MSG_LEN = 12
const LED_MSG_TIMEOUT_ALLOWANCE = 5000

// Change to require('spi-hub-client') to run outside this project
const SPIHubClient = require('../index')

const spi = new SPIHubClient()

spi.on('devicesChanged', devices => {
  console.log('SPI devices changed', devices)
})

spi.on('message', message => {
  console.log('got SPI message', message)
})

//setTimeout(() => {spi.send({ bus: 0, device: 0, channel: 4, message: 'hello SPI' }), 1000)

setTimeout(() => {
  const buf = Buffer.alloc(LED_MSG_LEN * 2)
  encodeLEDMessage(buf, ledMessage('gg'), 0)
  encodeLEDMessage(buf, ledMessage('rrrr'), LED_MSG_LEN)
  spi.send({ bus: 0, device: 1, channel: 254, message: buf })
}, 1000)

function encodeColorAndCount(buf, colorCount, offset) {
  buf.writeUInt8(colorCount ? ('red' === colorCount.color ? 2 : 1) : 0, offset)
  buf.writeUInt8(colorCount ? colorCount.count : 0, offset + 1)
}

function encodeLEDMessage(buf, message, offset) {
  let pos = offset
  encodeColorAndCount(buf, message.colors[0], pos)
  pos += 2
  encodeColorAndCount(buf, message.colors[1], pos)
  pos += 2
  const flashRate = message.flashRate || 500
  const idleTime = message.idleTime || 3000
  buf.writeUInt16LE(flashRate, pos) // on time
  pos += 2
  buf.writeUInt16LE(flashRate, pos) // off time
  pos += 2
  buf.writeUInt32LE(idleTime + LED_MSG_TIMEOUT_ALLOWANCE, pos)
}

function ledMessage(pattern, idleTime = 2000) {
  const colors = []
  let curColorAndCount
  for (let pos = 0; pos < pattern.length; ++pos) {
    const ch = pattern.charAt(pos).toLowerCase()
    const color = 'g' === ch ? 'green' : 'red'
    if (curColorAndCount && curColorAndCount.color === color) {
      ++curColorAndCount.count
    } else {
      curColorAndCount = { color, count: 1 }
      colors.push(curColorAndCount)
    }
  }
  return { colors, flashRate: 400, idleTime }
}
