"use strict";

const co = require('co');
const Crawler = require('./lib/crawler');
const Synchroniser = require('./lib/sync');
const contacter = require('./lib/contacter');
const constants = require('./lib/constants');
const req2fwd = require('./lib/req2fwd');
const common = require('duniter-common');
const Peer = common.document.Peer

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
      process: (server, conf, logger) => new Crawler(server, conf, logger)
    },

    methods: {

      contacter: contacter,

      pullBlocks: (server, pubkey) => co(function*() {
        const crawler = new Crawler(server, server.conf, server.logger);
        return crawler.pullBlocks(server, pubkey);
      }),

      pullSandbox: (server) => co(function*() {
        const crawler = new Crawler(server, server.conf, server.logger);
        return crawler.sandboxPull(server);
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
      { value: '--nopeers',       desc: 'Do not retrieve peers during sync.'},
      { value: '--slow',          desc: 'Download slowly the blokchcain (for low connnections).'},
      { value: '--minsig <minsig>', desc: 'Minimum pending signatures count for `crawl-lookup`. Default is 5.'}
    ],

    cli: [{
      name: 'sync [host] [port] [to]',
      desc: 'Synchronize blockchain from a remote Duniter node',
      preventIfRunning: true,
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
        const remote = new Synchroniser(server, onHost, onPort, conf, interactive === true, program.slow === true);
        return remote.sync(upTo, chunkLength, askedCautious, nopeers, noShufflePeers === true);
      })
    }, {
      name: 'peer [host] [port]',
      desc: 'Exchange peerings with another node',
      preventIfRunning: true,
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const host = params[0];
        const port = params[1];
        const logger = server.logger;
        try {
          const ERASE_IF_ALREADY_RECORDED = true;
          logger.info('Fetching peering record at %s:%s...', host, port);
          let peering = yield contacter.statics.fetchPeer(host, port);
          logger.info('Apply peering ...');
          yield server.PeeringService.submitP(peering, ERASE_IF_ALREADY_RECORDED, !program.nocautious);
          logger.info('Applied');
          let selfPeer = yield server.dal.getPeer(server.PeeringService.pubkey);
          if (!selfPeer) {
            yield server.PeeringService.generateSelfPeer(server.conf, 0)
            selfPeer = yield server.dal.getPeer(server.PeeringService.pubkey);
          }
          logger.info('Send self peering ...');
          const p = Peer.fromJSON(peering);
          const contact = contacter(p.getHostPreferDNS(), p.getPort(), opts);
          yield contact.postPeer(Peer.fromJSON(selfPeer));
          logger.info('Sent.');
          yield server.disconnect();
        } catch(e) {
          logger.error(e.code || e.message || e);
          throw Error("Exiting");
        }
      })
    }, {
      name: 'import <fromHost> <fromPort> <search> <toHost> <toPort>',
      desc: 'Import all pending data from matching <search>',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const fromHost = params[0];
        const fromPort = params[1];
        const search = params[2];
        const toHost = params[3];
        const toPort = params[4];
        const logger = server.logger;
        try {
          const peers = fromHost && fromPort ? [{ endpoints: [['BASIC_MERKLED_API', fromHost, fromPort].join(' ')] }] : yield server.dal.peerDAL.query('SELECT * FROM peer WHERE status = ?', ['UP'])
          // Memberships
          for (const p of peers) {
            const peer = Peer.fromJSON(p);
            const fromHost = peer.getHostPreferDNS();
            const fromPort = peer.getPort();
            logger.info('Looking at %s:%s...', fromHost, fromPort);
            try {
              const node = contacter(fromHost, fromPort, { timeout: 10000 });
              const requirements = yield node.getRequirements(search);
              yield req2fwd(requirements, toHost, toPort, logger)
            } catch (e) {
              logger.error(e);
            }
          }
          yield server.disconnect();
        } catch(e) {
          logger.error(e);
          throw Error("Exiting");
        }
      })
    }, {
      name: 'crawl-lookup <toHost> <toPort> [<fromHost> [<fromPort>]]',
      desc: 'Make a full network scan and rebroadcast every WoT pending document (identity, certification, membership)',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const toHost = params[0]
        const toPort = params[1]
        const fromHost = params[2]
        const fromPort = params[3]
        const logger = server.logger;
        try {
          const peers = fromHost && fromPort ? [{ endpoints: [['BASIC_MERKLED_API', fromHost, fromPort].join(' ')] }] : yield server.dal.peerDAL.query('SELECT * FROM peer WHERE status = ?', ['UP'])
          // Memberships
          for (const p of peers) {
            const peer = Peer.fromJSON(p);
            const fromHost = peer.getHostPreferDNS();
            const fromPort = peer.getPort();
            logger.info('Looking at %s:%s...', fromHost, fromPort);
            try {
              const node = contacter(fromHost, fromPort, { timeout: 10000 });
              const requirements = yield node.getRequirementsPending(program.minsig || 5);
              yield req2fwd(requirements, toHost, toPort, logger)
            } catch (e) {
              logger.error(e);
            }
          }
          yield server.disconnect();
        } catch(e) {
          logger.error(e);
          throw Error("Exiting");
        }
      })
    }, {
      name: 'fwd-pending-ms',
      desc: 'Forwards all the local pending memberships to target node',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const logger = server.logger;
        try {
          const pendingMSS = yield server.dal.msDAL.getPendingIN()
          const targetPeer = contacter('g1.cgeek.fr', 80, { timeout: 5000 });
          // Membership
          let rawMS
          for (const theMS of pendingMSS) {
            console.log('New membership pending for %s', theMS.uid);
            try {
              rawMS = common.rawer.getMembership({
                currency: 'g1',
                issuer: theMS.issuer,
                block: theMS.block,
                membership: theMS.membership,
                userid: theMS.userid,
                certts: theMS.certts,
                signature: theMS.signature
              });
              yield targetPeer.postRenew(rawMS);
              logger.info('Success ms idty %s', theMS.userid);
            } catch (e) {
              logger.warn(e);
            }
          }
          yield server.disconnect();
        } catch(e) {
          logger.error(e);
          throw Error("Exiting");
        }
      })
    }]
  }
}
