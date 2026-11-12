'use strict';

function validateOptions(o) {
  const integer = (name, value, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
  };
  const number = (name, value, min, max) => {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min} 到 ${max} 的数字`);
  };
  if (o.steps != null) integer('steps', o.steps, 2, 100);
  if (o.top != null) integer('top', o.top, 1, 10000);
  if (o.interval != null) number('interval', o.interval, 0, 86400);
  if (o.snapshotTimeout != null) integer('timeout', o.snapshotTimeout, 1, 3600000);
  if (o.maxSnapshotMB != null) number('max-snapshot-mb', o.maxSnapshotMB, 0, 100000);
  if (o.samplingSeconds != null) number('sampling-seconds', o.samplingSeconds, 0.001, 86400);
  if (o.samplingInterval != null) integer('sampling-interval', o.samplingInterval, 1, 1000000000);
  if (o.lineBase != null && ![0, 1].includes(o.lineBase)) throw new Error('line-base 必须是 0 或 1');
  if (o.mode != null && !['auto', 'snapshot', 'sampling'].includes(o.mode)) throw new Error('mode 必须是 auto、snapshot 或 sampling');
  if (o.algorithm != null && !['devtools', 'heapscope'].includes(o.algorithm)) throw new Error('algorithm 必须是 devtools 或 heapscope');
  if (o.platform != null && !['ios', 'android'].includes(o.platform)) throw new Error('platform 必须是 ios 或 android');
}
module.exports = { validateOptions };
