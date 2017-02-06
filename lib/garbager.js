"use strict";

const constants = require('./constants');
const co = require('co');

module.exports = {
  cleanLongDownPeers: (server, now) => co(function*() {
    const first_down_limit = now - constants.PEER_LONG_DOWN * 1000;
    yield server.dal.peerDAL.query('DELETE FROM peer WHERE first_down < ' + first_down_limit);
  })
}
