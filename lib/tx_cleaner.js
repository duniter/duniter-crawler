"use strict";

module.exports = (txs) =>

  // Remove unused signatories - see https://github.com/duniter/duniter/issues/494
  txs.forEach((tx) => {
    if (tx.signatories) {
      delete tx.signatories
    }
    return tx
  })
