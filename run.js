"use strict";

const co = require('co');
const stack = require('duniter').statics.autoStack([{
  name: 'duniter-crawler',
  required: require('./index')
}]);

co(function*() {
  yield stack.executeStack(process.argv);
  process.exit();
});
