"use strict";

const co = require('co');
const querablep = require('querablep');
const contacter = require('./contacter');
const rawer = require('duniter-common').rawer;

module.exports = {

  pullSandbox: (currency, fromHost, fromPort, toHost, toPort, logger) => co(function*() {
    const from = contacter(fromHost, fromPort);
    const to = contacter(toHost, toPort);

    let res
    try {
      res = yield from.getRequirementsPending(1)
    } catch (e) {
      // Silent error
      logger && logger.trace('Sandbox pulling: could not fetch requirements on %s', [fromHost, fromPort].join(':'))
    }

    if (res) {

      for(const idty of res.identities) {
        const identity = rawer.getOfficialIdentity({
          currency,
          uid:      idty.uid,
          pubkey:   idty.pubkey,
          buid:     idty.meta.timestamp,
          sig:      idty.sig
        })
        try {
          yield to.postIdentity(identity)
          logger && logger.trace('Sandbox pulling: success with identity \'%s\'', idty.uid)
        } catch (e) {
          // Silent error
        }
        for (const cert of idty.pendingCerts) {
          const certification = rawer.getOfficialCertification({
            currency,
            idty_issuer: idty.pubkey,
            idty_uid:    idty.uid,
            idty_buid:   idty.meta.timestamp,
            idty_sig:    idty.sig,
            issuer:      cert.from,
            buid:        cert.blockstamp,
            sig:         cert.sig
          })
          try {
            yield to.postCert(certification)
            logger && logger.trace('Sandbox pulling: success with cert key %s => %s', cert.from.substr(0, 6), idty.uid)
          } catch (e) {
            // Silent error
          }
        }
        for (const ms of idty.pendingMemberships) {
          const membership = rawer.getMembership({
            currency,
            userid:     idty.uid,
            issuer:     idty.pubkey,
            certts:     idty.meta.timestamp,
            membership: ms.type,
            block:      ms.blockstamp,
            signature:  ms.sig
          })
          try {
            yield to.postRenew(membership)
            logger && logger.trace('Sandbox pulling: success with membership \'%s\'', idty.uid)
          } catch (e) {
            // Silent error
          }
        }
      }
    }
  })
}