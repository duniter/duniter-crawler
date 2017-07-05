"use strict";

const constants = require('./constants');
const contacter = require('./contacter');

const DEFAULT_HOST = 'localhost';

module.exports = connection

function connection(peer, timeout) {
  return Promise.resolve(contacter(peer.getDns() || peer.getIPv4() || peer.getIPv6() || DEFAULT_HOST, peer.getPort(), {
    timeout: timeout || constants.DEFAULT_TIMEOUT
  }))
}
