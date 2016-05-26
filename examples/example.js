#!/usr/bin/env node

'use strict'

// Change to require('spi-hub-client') to run outside this project
const SPIHubClient = require('../index')

const spi = new SPIHubClient()

spi.on('devicesChanged', devices => {
  console.log('SPI devices changed', devices)
})

spi.on('message', message => {
  console.log('got SPI message', message)
})

setTimeout(() => spi.send({ bus: 0, device: 0, channel: 4, message: 'hello SPI' }), 1000)