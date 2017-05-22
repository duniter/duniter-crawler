"use strict";

const co = require('co')
const common = require('duniter-common')
const contacter = require('./contacter')

module.exports = (requirements, toHost, toPort, logger) => co(function*() {
  const mss = {};
  const identities = {};
  const certs = {};
  const targetPeer = contacter(toHost, parseInt(toPort), { timeout: 10000 });
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
          yield targetPeer.postIdentity(rawIdty);
          logger.info('Success idty %s', idty.uid);
        } catch (e) {
          logger.warn('Rejected idty %s...', idty.uid, e);
        }
      }
      for (const received of idty.pendingCerts) {
        const cid = [received.from, iid].join('-');
        if (!certs[cid]) {
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
          const rawCertNoSig = common.rawer.getOfficialCertification({
            currency: 'g1',
            issuer: received.from,
            idty_issuer: idty.pubkey,
            idty_uid: idty.uid,
            idty_buid: idty.meta.timestamp,
            idty_sig: idty.sig,
            buid: received.blockstamp
          });
          try {
            const chkSig = common.keyring.verify(rawCertNoSig, received.sig, received.from)
            if (!chkSig) {
              throw "Wrong signature for certification?!"
            }
            yield targetPeer.postCert(rawCert);
            logger.info('Success cert %s -> %s', received.from, idty.uid);
          } catch (e) {
            logger.warn('Rejected cert %s -> %s', received.from, idty.uid, received.blockstamp.substr(0,18), e);
          }
        }
      }
      for (const theMS of idty.pendingMemberships) {
        // + Membership
        const id = [idty.pubkey, idty.uid, theMS.blockstamp].join('-');
        if (!mss[id]) {
          mss[id] = theMS
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
            logger.warn('Rejected ms idty %s', idty.uid, e);
          }
        }
      }
    } catch (e) {
      logger.warn(e);
    }
  }
})