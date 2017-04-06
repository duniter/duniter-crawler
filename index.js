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
      { value: '--nopeers',       desc: 'Do not retrieve peers during sync.'}
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
      name: 'crawl-lookup',
      desc: 'Make a full network scan and rebroadcast every WoT pending document (identity, certification, membership)',
      onDatabaseExecute: (server, conf, program, params) => co(function*() {
        const logger = server.logger;
        try {
          const Peer = server.lib.Peer;
          const peers = []//yield server.dal.peerDAL.query('SELECT * FROM peer WHERE status = ?', ['UP']);
          peers.unshift({ endpoints: ['BASIC_MERKLED_API g1.duniter.org 10901'] });
          // peers.unshift({ endpoints: ['BASIC_MERKLED_API wotex.cgeek.fr 63700'] });
          // const peers = [{ endpoints: ['BASIC_MERKLED_API cgeek.fr 10900'] }];
          const mss = {};
          const identities = {};
          const certs = {};
          const targetPeer = contacter('g1.cgeek.fr', 80, { timeout: 5000 });
          // Memberships
          for (const p of peers) {
            const peer = Peer.statics.fromJSON(p);
            const fromHost = peer.getHostPreferDNS();
            const fromPort = peer.getPort();
            logger.info('Looking at %s:%s...', fromHost, fromPort);
            try {
              const node = contacter(fromHost, fromPort, { timeout: 3000 });
              const pendings = (yield node.wotPending()).memberships;
              const members = (yield node.wotMembers()).results;
              for (const ms of pendings.concat(members)) {
                const id = [ms.pubkey, ms.uid].join('-');
                if (!mss[id]) {
                  mss[id] = ms;
                }
              }
            } catch (e) {
              logger.error(e);
            }
          }
          // Identities
          for (const p of peers) {
            const peer = Peer.statics.fromJSON(p);
            const fromHost = peer.getHostPreferDNS();
            const fromPort = peer.getPort();
            logger.info('Looking at %s:%s...', fromHost, fromPort);
            try {
              const node = contacter(fromHost, fromPort, { timeout: 6000 });
              const pending = Object.values(mss);
              for (const ms of pending) {
                try {
                  console.log('Lookup %s', ms.uid);
                  const lookup = yield node.getLookup(ms.uid);
                  for (const res of lookup.results) {
                    for (const uid of res.uids) {
                      const iid = [res.pubkey, uid.uid, uid.meta.timestamp].join('-');
                      if (!identities[iid]) {
                        console.log('New identity %s', uid.uid);
                        identities[iid] = uid;
                        try {
                          const rawIdty = common.rawer.getOfficialIdentity({
                            currency: 'g1',
                            issuer: res.pubkey,
                            uid: uid.uid,
                            buid: uid.meta.timestamp,
                            sig: uid.self
                          });
                          logger.info('Success idty %s', uid.uid);
                          yield targetPeer.postIdentity(rawIdty);
                        } catch (e) {
                          logger.warn(e);
                        }
                        // // + Membership
                        // const id = [ms.pubkey, ms.uid].join('-');
                        // const theMS = mss[id];
                        // if (theMS) {
                        //   console.log('New membership pending for %s', theMS.uid);
                        //   try {
                        //     const rawIdty = common.rawer.getMembership({
                        //       currency: 'g1',
                        //       issuer: theMS.pubkey,
                        //       block: [theMS.blockNumber, theMS.blockHash].join('-'),
                        //       membership: theMS.membership,
                        //       certts: uid.meta.timestamp,
                        //       signature: theMS.self
                        //     });
                        //     logger.info('Success ms idty %s', uid.uid);
                        //     yield targetPeer.postIdentity(rawIdty);
                        //   } catch (e) {
                        //     logger.warn(e);
                        //   }
                        // }
                      }
                      for (const received of uid.others) {
                        const cid = [received.pubkey, iid].join('-');
                        if (!certs[cid]) {
                          console.log('New cert %s -> %s', received.pubkey, uid.uid);
                          yield new Promise((res) => setTimeout(res, 300));
                          certs[cid] = received;
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
                            yield targetPeer.postCert(rawCert);
                            logger.info('Success cert %s -> %s', received.pubkey, uid.uid);
                          } catch (e) {
                            logger.warn(e);
                          }
                        }
                      }
                    }
                    // for (const signed of res.signed) {
                    //   const iid = [signed.pubkey, signed.uid, signed.meta.timestamp].join('-');
                    //   const cid = [res.pubkey, iid].join('-');
                    //   if (!certs[cid]) {
                    //     console.log('New cert2 %s -> %s', res.pubkey, signed.uid);
                    //     certs[cid] = signed;
                    //     // const rawCert = common.rawer.getOfficialCertification({
                    //     //   currency: 'g1',
                    //     //   issuer: res.pubkey,
                    //     //   idty_issuer: res.pubkey,
                    //     //   idty_uid: signed.uid,
                    //     //   idty_buid: signed.meta.timestamp,
                    //     //   idty_sig: signed.self,
                    //     //   buid: res.meta.timestamp,
                    //     //   sig: res.signature
                    //     // });
                    //     // yield targetPeer.postCert(rawCert);
                    //   }
                    // }
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
