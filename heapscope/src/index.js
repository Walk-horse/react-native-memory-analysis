'use strict';
// Embeddable API for the RN dev tool / Electron host.
// const heapscope = require('heapscope');
//   await heapscope.takeHeapSnapshot(cdp, {})
//   heapscope.diffSnapshots(snaps)
//   await heapscope.resolveSites({ metro, sites, project })

module.exports = {
  ...require('./lib'),
  ...require('./capture'),
  ...require('./snapshot'),
  ...require('./sourcemap'),
  ...require('./symbolicate'),
  ...require('./report'),
  ...require('./pipeline'),
  ...require('./job'),
  watchman: require('./watchman'),
};
