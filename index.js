"use strict";

const co = require('co');
const Crawler = require('./lib/crawler');
const Synchroniser = require('./lib/sync');
const contacter = require('./lib/contacter');
const constants = require('./lib/constants');

module.exports = {
  duniter: {

    config: {
      onLoading: (conf) => co(function*() {
        conf.swichOnTimeAheadBy = constants.SWITCH_ON_BRANCH_AHEAD_BY_X_MINUTES;
      }),
      beforeSave: (conf) => co(function*() {
        delete conf.swichOnTimeAheadBy
      })
    },

    service: {
      neutral: (server, conf, logger) => new Crawler(server, conf, logger)
    },

    methods: {

      contacter: contacter,

      pullBlocks: (server, pubkey) => co(function*() {
        const crawler = new Crawler(server, server.conf, server.logger);
        return crawler.pullBlocks(server, pubkey);
      }),

      synchronize: (server, onHost, onPort, upTo, chunkLength) => {
        const remote = new Synchroniser(server, onHost, onPort, server.conf, false);
        const syncPromise = remote.sync(upTo, chunkLength, null, null, null);
        return {
          flow: remote,
          syncPromise: syncPromise
        };
      },

      testForSync: (server, onHost, onPort) => {
        const remote = new Synchroniser(server, onHost, onPort);
        return remote.test();
      }
    },

    cliOptions: [
      { value: '--nointeractive', desc: 'Disable interactive sync UI.'},
      { value: '--nocautious',    desc: 'Do not check blocks validity during sync.'},
      { value: '--cautious',      desc: 'Check blocks validity during sync (overrides --nocautious option).'},
      { value: '--nopeers',       desc: 'Do not retrieve peers during sync.'}
    ],

    cli: [{
      name: 'sync [host] [port] [to]',
      desc: 'Synchronize blockchain from a remote Duniter node',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const host = params[0];
        const port = params[1];
        const to   = params[2];
        if (!host) {
          throw 'Host is required.';
        }
        if (!port) {
          throw 'Port is required.';
        }
        let cautious;
        if (program.nocautious) {
          cautious = false;
        }
        if (program.cautious) {
          cautious = true;
        }
        const onHost = host;
        const onPort = port;
        const upTo = parseInt(to);
        const chunkLength = 0;
        const interactive = !program.nointeractive;
        const askedCautious = cautious;
        const nopeers = program.nopeers;
        const noShufflePeers = program.noshuffle;
        const remote = new Synchroniser(server, onHost, onPort, conf, interactive === true);
        return remote.sync(upTo, chunkLength, askedCautious, nopeers, noShufflePeers === true);
      })
    }, {
      name: 'peer [host] [port]',
      desc: 'Exchange peerings with another node',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const host = params[0];
        const port = params[1];
        const logger = server.logger;
        try {
          const ERASE_IF_ALREADY_RECORDED = true;
          const Peer = server.lib.Peer;
          logger.info('Fetching peering record at %s:%s...', host, port);
          let peering = yield contacter.statics.fetchPeer(host, port);
          logger.info('Apply peering ...');
          yield server.PeeringService.submitP(peering, ERASE_IF_ALREADY_RECORDED, !program.nocautious);
          logger.info('Applied');
          let selfPeer = yield server.dal.getPeer(server.PeeringService.pubkey);
          if (!selfPeer) {
            yield Q.nfcall(server.PeeringService.generateSelfPeer, server.conf, 0);
            selfPeer = yield server.dal.getPeer(server.PeeringService.pubkey);
          }
          logger.info('Send self peering ...');
          const p = Peer.statics.peerize(peering);
          const contact = contacter(p.getHostPreferDNS(), p.getPort(), opts);
          yield contact.postPeer(Peer.statics.peerize(selfPeer));
          logger.info('Sent.');
          yield server.disconnect();
        } catch(e) {
          logger.error(e.code || e.message || e);
          throw Error("Exiting");
        }
      })
    }]
  }
}
