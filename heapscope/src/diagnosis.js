'use strict';

// Human-readable interpretation of a growth candidate. This is intentionally
// phrased as a clue, not a leak verdict: heap diffs need manual verification.
function diagnose(c = {}) {
  const trend = Array.isArray(c.trend) ? c.trend : [];
  const deltas = trend.slice(1).map((n, i) => Number(n) - Number(trend[i]));
  const positive = deltas.length > 0 && deltas.every(n => n > 0);
  const hasDrop = deltas.some(n => n < 0);
  const d1 = deltas[0] || 0;
  const lastDelta = deltas[deltas.length - 1] || 0;
  const ratio = d1 > 0 ? lastDelta / d1 : null;
  const bytes = Number(c.totalBytes) || 0;
  const focus = c.focus || 'low';
  const name = `${c.type || ''} ${c.name || ''}`;
  const engine = /^(native|code|synthetic|hidden)$/i.test(c.type || '')
    || /HiddenClass|CodeBlock|DictPropertyMap|PropertyAccessor|DescriptorArray|FeedbackVector|ScopeInfo/i.test(name);
  const primitive = c.type === 'string' || c.type === 'number' || /^<(string|number)/i.test(c.name || '');
  const dependency = /node_modules/i.test(c.sourceDetail?.file || c.allocDetail?.file || '');
  const noSource = !c.sourceDetail || /^script#/i.test(c.sourceDetail.file || '');
  const monotonic = positive && (trend.length < 3 || ratio == null || ratio >= 0.7);
  const plateau = positive && trend.length >= 3 && ratio != null && ratio <= 0.35;
  const signals = [];
  let severity = focus === 'high' ? 'high' : focus === 'watch' ? 'watch' : 'low';

  if (engine) {
    severity = 'low';
    signals.push('引擎内部对象');
  } else if (primitive) {
    severity = severity === 'high' ? 'watch' : 'low';
    signals.push('基础值增长，缺少可靠分配点');
  }
  if (monotonic) signals.push('多轮持续增长');
  else if (plateau) signals.push('增长趋平，可能是一次性预热');
  else if (hasDrop) signals.push('趋势有回落，证据不稳定');
  else if (trend.length < 3) signals.push('快照轮次不足，无法判断趋势');
  if (c.globalHolder) signals.push('存在全局/事件/定时器持有链');
  if (noSource) signals.push('缺少业务源码定位');
  else if (dependency) signals.push('分配点位于依赖代码');
  if (c.siteVia && /关联位置/.test(c.siteVia)) signals.push('当前位置是关联位置，不是实际分配点');

  let label = '暂未发现明显问题';
  let summary = '当前增长证据不足，建议结合持有链和重复实验确认。';
  let advice = '继续重复相同场景，并在 GC 后检查对象是否持续存活。';
  if (severity === 'high') {
    label = '可能存在问题';
    summary = monotonic ? '对象在多轮复现后持续增长，疑似未释放。' : '对象增长量较大或被长期持有，需要优先排查。';
    advice = c.globalHolder ? '优先检查 effect、事件监听、定时器、单例缓存是否在卸载时清理。' : '查看源码位置和 GC root 持有链，确认是否存在未解除的引用。';
  } else if (severity === 'watch') {
    label = '潜在问题';
    summary = plateau ? '对象增长后趋于稳定，更像缓存预热，但仍需复测。' : '发现增长信号，但当前证据不足以确认泄漏。';
    advice = '增加复现轮次，区分正常缓存增长与持续存活对象。';
  }
  return { severity, label, summary, advice, signals, bytes };
}

module.exports = { diagnose };
