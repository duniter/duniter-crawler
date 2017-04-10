"use strict";

const co = require('co');
const Crawler = require('./lib/crawler');
const Synchroniser = require('./lib/sync');
const contacter = require('./lib/contacter');
const constants = require('./lib/constants');
const common = require('duniter-common');

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
        const remote = new Synchroniser(server, onHost, onPort, conf, interactive === true);
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
          const Peer = server.lib.Peer;
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
    }, {
      name: 'import-lookup [search] [fromhost] [fromport] [tohost] [toport]',
      desc: 'Exchange peerings with another node',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const search = params[0];
        const fromhost = params[1];
        const fromport = params[2];
        const tohost = params[3];
        const toport = params[4];
        const logger = server.logger;
        try {
          logger.info('Looking for "%s" at %s:%s...', search, fromhost, fromport);
          const sourcePeer = contacter(fromhost, fromport);
          const targetPeer = contacter(tohost, toport);
          const lookup = yield sourcePeer.getLookup(search);
          for (const res of lookup.results) {
            for (const uid of res.uids) {
              const rawIdty = common.rawer.getOfficialIdentity({
                currency: 'g1',
                issuer: res.pubkey,
                uid: uid.uid,
                buid: uid.meta.timestamp,
                sig: uid.self
              });
              logger.info('Success idty %s', uid.uid);
              try {
                yield targetPeer.postIdentity(rawIdty);
              } catch (e) {
                logger.error(e);
              }
              for (const received of uid.others) {
                const rawCert = common.rawer.getOfficialCertification({
                  currency: 'g1',
                  issuer: received.pubkey,
                  idty_issuer: res.pubkey,
                  idty_uid: uid.uid,
                  idty_buid: uid.meta.timestamp,
                  idty_sig: uid.self,
                  buid: common.buid.format.buid(received.meta.block_number, received.meta.block_hash),
                  sig: received.signature
                });
                try {
                  logger.info('Success idty %s', uid.uid);
                  yield targetPeer.postCert(rawCert);
                } catch (e) {
                  logger.error(e);
                }
              }
            }
          }
          logger.info('Sent.');
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
          const Peer = server.lib.Peer;
          const peers = fromHost && fromPort ? [{ endpoints: [['BASIC_MERKLED_API', fromHost, fromPort].join(' ')] }] : yield server.dal.peerDAL.query('SELECT * FROM peer WHERE status = ?', ['UP'])
          const mss = {};
          const identities = {};
          const certs = {};
          const targetPeer = contacter(toHost, parseInt(toPort), { timeout: 10000 });
          // Memberships
          for (const p of peers) {
            const peer = Peer.statics.fromJSON(p);
            const fromHost = peer.getHostPreferDNS();
            const fromPort = peer.getPort();
            logger.info('Looking at %s:%s...', fromHost, fromPort);
            try {
              const node = contacter(fromHost, fromPort, { timeout: 10000 });
              const requirements = yield node.getRequirementsPending(program.minsig || 5);
              // Identities
              for (const idty of requirements.identities) {
                try {
                  const iid = [idty.pubkey, idty.uid, idty.meta.timestamp].join('-');
                  if (!identities[iid]) {
                    logger.info('New identity %s', idty.uid);
                    identities[iid] = idty;
                    try {
                      const rawIdty = common.rawer.getOfficialIdentity({
                        currency: 'g1',
                        issuer: idty.pubkey,
                        uid: idty.uid,
                        buid: idty.meta.timestamp,
                        sig: idty.sig
                      });
                      logger.info('Posting idty %s...', idty.uid);
                      yield targetPeer.postIdentity(rawIdty);
                      logger.info('Success idty %s', idty.uid);
                    } catch (e) {
                      logger.warn(e);
                    }
                  }
                  for (const received of idty.pendingCerts) {
                    const cid = [received.from, iid].join('-');
                    if (!certs[cid]) {
                      logger.info('New cert %s -> %s', received.from, idty.uid);
                      yield new Promise((res) => setTimeout(res, 300));
                      certs[cid] = received;
                      const rawCert = common.rawer.getOfficialCertification({
                        currency: 'g1',
                        issuer: received.from,
                        idty_issuer: idty.pubkey,
                        idty_uid: idty.uid,
                        idty_buid: idty.meta.timestamp,
                        idty_sig: idty.sig,
                        buid: received.blockstamp,
                        sig: received.sig
                      });
                      try {
                        yield targetPeer.postCert(rawCert);
                        logger.info('Success cert %s -> %s', received.from, idty.uid);
                      } catch (e) {
                        logger.warn(e);
                      }
                    }
                  }
                  for (const theMS of idty.pendingMemberships) {
                    // + Membership
                    const id = [idty.pubkey, idty.uid, theMS.blockstamp].join('-');
                    if (!mss[id]) {
                      mss[id] = theMS
                      logger.info('New membership pending for %s', idty.uid);
                      try {
                        const rawMS = common.rawer.getMembership({
                          currency: 'g1',
                          issuer: idty.pubkey,
                          userid: idty.uid,
                          block: theMS.blockstamp,
                          membership: theMS.type,
                          certts: idty.meta.timestamp,
                          signature: theMS.sig
                        });
                        yield targetPeer.postRenew(rawMS);
                        logger.info('Success ms idty %s', idty.uid);
                      } catch (e) {
                        logger.warn(e);
                      }
                    }
                  }
                } catch (e) {
                  logger.warn(e);
                }
              }
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
