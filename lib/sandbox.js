"use strict";

const co = require('co');
const querablep = require('querablep');
const contacter = require('./contacter');
const rawer = require('duniter-common').rawer;
const parsers = require('duniter-common').parsers;

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
      const docs = getDocumentsTree(currency, res)
      for (const identity of docs.identities) {
        yield submitIdentity(identity, to)
      }
      for (const certification of docs.certifications) {
        yield submitCertification(certification, to)
      }
      for (const membership of docs.memberships) {
        yield submitMembership(membership, to)
      }
    }
  }),

  pullSandboxToLocalServer: (currency, fromHost, toServer, logger, watcher, nbCertsMin) => co(function*() {

    let res
    try {
      res = yield fromHost.getRequirementsPending(nbCertsMin || 1)
    } catch (e) {
      watcher && watcher.writeStatus('Sandbox pulling: could not fetch requirements on %s', [fromHost.host, fromHost.port].join(':'))
    }

    if (res) {
      const docs = getDocumentsTree(currency, res)

      for (let i = 0; i < docs.identities.length; i++) {
        const idty = docs.identities[i];
        watcher && watcher.writeStatus('Identity ' + (i+1) + '/' + docs.identities.length)
        yield submitIdentityToServer(idty, toServer, logger)
      }

      for (let i = 0; i < docs.certifications.length; i++) {
        const cert = docs.certifications[i];
        watcher && watcher.writeStatus('Certification ' + (i+1) + '/' + docs.certifications.length)
        yield submitCertificationToServer(cert, toServer, logger)
      }

      for (let i = 0; i < docs.memberships.length; i++) {
        const ms = docs.memberships[i];
        watcher && watcher.writeStatus('Membership ' + (i+1) + '/' + docs.memberships.length)
        yield submitMembershipToServer(ms, toServer, logger)
      }
    }
  })
}

function getDocumentsTree(currency, res) {
  const documents = {
    identities: [],
    certifications: [],
    memberships: []
  }
  for(const idty of res.identities) {
    const identity = rawer.getOfficialIdentity({
      currency,
      uid:      idty.uid,
      pubkey:   idty.pubkey,
      buid:     idty.meta.timestamp,
      sig:      idty.sig
    })
    documents.identities.push(identity)
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
      documents.certifications.push(certification)
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
      documents.memberships.push(membership)
    }
  }
  return documents
}

function submitIdentity(idty, to, logger) {
  return co(function*() {
    try {
      yield to.postIdentity(idty)
      logger && logger.trace('Sandbox pulling: success with identity \'%s\'', idty.uid)
    } catch (e) {
      // Silent error
    }
  })
}

function submitCertification(cert, to, logger) {
  return co(function*() {
    try {
      yield to.postCert(cert)
      logger && logger.trace('Sandbox pulling: success with cert key %s => %s', cert.from.substr(0, 6), cert.idty_uid)
    } catch (e) {
      // Silent error
    }
  })
}

function submitMembership(ms, to, logger) {
  return co(function*() {
    try {
      yield to.postRenew(ms)
      logger && logger.trace('Sandbox pulling: success with membership \'%s\'', ms.uid)
    } catch (e) {
      // Silent error
    }
  })
}

function submitIdentityToServer(idty, toServer, logger) {
  return co(function*() {
    try {
      const obj = parsers.parseIdentity.syncWrite(idty)
      obj.documentType = 'identity'
      yield toServer.singleWritePromise(obj)
      logger && logger.trace('Sandbox pulling: success with identity \'%s\'', idty.uid)
    } catch (e) {
      // Silent error
    }
  })
}

function submitCertificationToServer(cert, toServer, logger) {
  return co(function*() {
    try {
      const obj = parsers.parseCertification.syncWrite(cert)
      obj.documentType = 'certification'
      yield toServer.singleWritePromise(obj)
      logger && logger.trace('Sandbox pulling: success with cert key %s => %s', cert.from.substr(0, 6), cert.idty_uid)
    } catch (e) {
      // Silent error
    }
  })
}

function submitMembershipToServer(ms, toServer, logger) {
  return co(function*() {
    try {
      const obj = parsers.parseMembership.syncWrite(ms)
      obj.documentType = 'membership'
      yield toServer.singleWritePromise(obj)
      logger && logger.trace('Sandbox pulling: success with membership \'%s\'', ms.uid)
    } catch (e) {
      // Silent error
    }
  })
}
