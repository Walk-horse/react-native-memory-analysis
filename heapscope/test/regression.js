'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFixture } = require('../src/fixture');
const { analyzeSamplingProfile } = require('../src/snapshot');
const { runAnalysis, matchTarget } = require('../src/pipeline');
const { runCaptureJob } = require('../src/job');
const { takeHeapSnapshot } = require('../src/capture');
const { validateOptions } = require('../src/config');
const watchman = require('../src/watchman');
const { render } = require('../src/report');
const { diagnose } = require('../src/diagnosis');
const { sourceEvidence, vscodeUrl } = require('../src/source-evidence');
const { createMockServer } = require('./mock-metro');
const { createService } = require('../src/service/server');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heapscope-regression-'));
  let mock, service;
  try {
    const iphone = { id: 'ios-1', title: 'app (iPhone)', deviceName: 'iPhone' };
    const android = { id: 'android-1', title: 'app (Android)', deviceName: 'Android' };
    assert.equal(matchTarget([android], iphone), null, '不得因仅剩一台设备而切换平台');
    assert.equal(matchTarget([{ ...iphone, id: 'ios-2' }], iphone).id, 'ios-2');
    assert.equal(matchTarget([{ ...iphone, id: 'ios-2' }, { ...iphone, id: 'ios-3' }], iphone), null, '同名目标不明确时不得随意选择');
    assert.equal(matchTarget([{ ...iphone, id: 'ios-2', deviceName: '其他 iPhone' }], iphone), null);
    assert.equal(matchTarget([iphone, android], iphone), iphone);
    console.log('PASS 跨设备和同名目标不会误重连');
    const fixture = makeFixture();
    const files = [fixture[0], fixture[1], fixture[2], fixture[0]].map((f, i) => {
      const file = path.join(tmp, `${i}.heapsnapshot`);
      fs.writeFileSync(file, JSON.stringify(f.data));
      return file;
    });
    for (const algorithm of ['devtools', 'heapscope']) {
      const { analysis } = await runAnalysis({ snapFiles: files, algorithm, out: path.join(tmp, algorithm), symbolication: false });
      assert.equal(analysis.totals.length, 4);
      assert.equal(analysis.totals[3].nodeCount, analysis.totals[0].nodeCount);
      if (algorithm === 'devtools') assert.equal(analysis.candidates.length, 0, '首末相同不应产生增长候选');
    }
    assert.match(render({ totals: [], candidates: [{ type: 'closure', name: 'listener', trend: [1, 2, 3], totalBytes: 100000, focus: 'high', globalHolder: true }] }), /问题判断/);
    const issue = diagnose({ type: 'closure', name: 'listener', trend: [1, 2, 3], totalBytes: 100000, focus: 'high', globalHolder: true });
    assert.equal(issue.label, '可能存在问题');
    console.log('PASS 四轮快照使用真实末轮及问题判断');
    assert.equal(watchman.compare({ method: 'none', digest: '-' }, { method: 'none', digest: '-' }).clean, null);
    const html = render({ totals: [], candidates: [], sourceCheck: { clean: null } });
    assert.match(html, /未校验采集期间源码/);
    assert.doesNotMatch(html, /源码树未变化，符号化结果可信/);
    assert.throws(() => validateOptions({ steps: NaN }), /steps/);
    assert.throws(() => validateOptions({ algorithm: 'bad' }), /algorithm/);
    assert.throws(() => validateOptions({ top: -1 }), /top/);
    console.log('PASS 未校验来源和无效参数');

    const legacyCandidate = {
      type: 'object', name: 'sample', score: 1, totalBytes: 1, countA: 1, countB: 2,
      sourceDetail: { file: '/work/app/src/a b.tsx', line: 42, column: 7, symbolicator: 'metro /index.map', method: 'open', sourceLine: '<unsafe>', snippet: [{ n: 42, text: '<unsafe>', hit: true }] },
      sourceChain: [
        { file: '/work/app/src/a b.tsx', shortFile: 'src/a b.tsx', line: 42, via: '持有者', business: true },
        { file: '/work/app/src/old.ts', shortFile: 'src/old.ts', line: 10, via: '属性值', business: true },
      ],
    };
    const evidence = sourceEvidence(legacyCandidate);
    assert.equal(evidence[0].column, 7);
    assert.equal(evidence[0].snippet[0].text, '<unsafe>');
    assert.equal(evidence[0].editorUrl, 'vscode://file/work/app/src/a%20b.tsx:42:7');
    assert.equal(evidence[1].sourceLine, '');
    assert.equal(vscodeUrl('https://evil/a', 1), null);
    assert.equal(vscodeUrl('//evil/a', 1), null);
    assert.equal(vscodeUrl('/tmp/a', 0), null);
    assert.equal(vscodeUrl('/tmp/a', 1, 0, null), 'vscode://file/tmp/a:1');
    const evidenceHtml = render({ totals: [], candidates: [legacyCandidate] });
    assert.match(evidenceHtml, /关联源码证据 2 项/);
    assert.match(evidenceHtml, /路径面包屑不是调用栈/);
    assert.match(evidenceHtml, /&lt;unsafe&gt;/);
    assert.doesNotMatch(evidenceHtml, /<unsafe>/);
    assert.match(evidenceHtml, /报告未保存源码内容/);
    console.log('PASS 关联源码证据面包屑、旧报告兼容与转义');
    const frameNode = (name, size, children = []) => ({ callFrame: { functionName: name, url: '/bundle.js', lineNumber: 0, columnNumber: 0 }, selfSize: size, children });
    const sampling = analyzeSamplingProfile({ head: frameNode('(root)', 0, [frameNode('A', 0, [frameNode('<B>', 4)]), frameNode('C', 0, [frameNode('<B>', 6)]), frameNode('single', 1)]) });
    const hotspot = sampling.hotspots.find(h => h.functionName === '<B>');
    assert.equal(hotspot.selfSize, 10);
    assert.deepEqual(hotspot.callStacks.map(x => x.frames.map(f => f.functionName).join('>')).sort(), ['A><B>', 'C><B>']);
    assert.equal(sampling.hotspots.find(h => h.functionName === 'single').callStacks.length, 0);
    const stackCandidate = { ...legacyCandidate, callStacks: hotspot.callStacks };
    const stackHtml = render({ totals: [], candidates: [stackCandidate], sampling });
    assert.match(stackHtml, /采样调用栈 2 条/);
    assert.match(stackHtml, /&lt;B&gt;/);
    assert.doesNotMatch(stackHtml, /关联源码证据 2 项/);
    assert.doesNotMatch(stackHtml, /<B>/);
    assert.match(stackHtml, /无采样调用栈/);
    assert.match(render({ totals: [], candidates: [{ ...legacyCandidate, callStacks: [{ frames: hotspot.callStacks[0].frames }] }] }), /关联源码证据 2 项/);
    console.log('PASS 采样调用栈优先、路径独立和旧数据回退');



    const handlers = new Map();
    const data = JSON.stringify(fixture[0].data);
    const fake = { on(m, fn) { handlers.set(m, fn); return () => handlers.delete(m); },
      async send(m) { if (m === 'HeapProfiler.takeHeapSnapshot') handlers.get('HeapProfiler.addHeapSnapshotChunk')({ chunk: data }); return {}; } };
    const snapshotPath = path.join(tmp, 'stream.heapsnapshot');
    const snap = await takeHeapSnapshot(fake, { outputFile: snapshotPath, doGc: false, quietMs: 1 });
    assert.equal(snap.ok, true); assert.equal(snap.file, snapshotPath);
    assert.equal(snap.json, undefined); assert.equal(fs.readFileSync(snapshotPath, 'utf8'), data);
    assert.equal(fs.existsSync(snapshotPath + '.partial'), false);
    console.log('PASS 快照分片写入文件并完成校验');

    mock = createMockServer();
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const metro = `http://127.0.0.1:${mock.address().port}`;
    const gates = [];
    const r = await runCaptureJob({ metro, target: '0', mode: 'sampling', out: path.join(tmp, 'sampling'), steps: 4, symbolicate: true }, {
      gate: async g => { gates.push(g.mode); return { action: 'next' }; },
    });
    assert.deepEqual(gates, ['sampling']);
    assert.equal(r.analysis.algorithm, 'devtools');
    assert.ok(r.analysis.sampling.hotspots.length);
    assert.ok(r.analysis.sampling.hotspots.some(h => /StoreDetail/.test(h.source || '')), '纯采样热点应进行符号化');
    assert.equal(r.analysis.sourceCheck.clean, null);
    console.log('PASS sampling 独立流程和符号化');

    fs.mkdirSync(path.join(tmp, 'existing'));
    service = createService({ outDir: tmp, metro });
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${service.address().port}`;

    fs.mkdirSync(path.join(tmp, 'legacy-report'));
    fs.writeFileSync(path.join(tmp, 'legacy-report', 'analysis.json'), JSON.stringify({ totals: [], candidates: [legacyCandidate] }));
    fs.writeFileSync(path.join(tmp, 'legacy-report', 'report.html'), '<html>legacy report</html>');
    const projected = await (await fetch(`${base}/api/reports/legacy-report`)).json();
    assert.equal(projected.report.candidates[0].sourceEvidence[0].column, 7);
    const reRendered = await (await fetch(`${base}/reports/legacy-report/report.html`)).text();
    assert.match(reRendered, /关联源码证据 2 项/);
    assert.equal(fs.readFileSync(path.join(tmp, 'legacy-report', 'report.html'), 'utf8'), '<html>legacy report</html>');

    const request = (body, origin) => fetch(base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await request({ name: 'existing' })).status, 409);
    assert.equal((await request({ name: 'invalid', steps: -2 })).status, 400);
    assert.equal((await request({ name: 'cross' }, 'http://evil.example')).status, 403);
    console.log('PASS Web 防覆盖、参数校验和跨来源请求');
    const created = await request({ name: 'web-cancel', target: 'mockdev-1', mode: 'sampling' });
    assert.equal(created.status, 201);
    const { job: createdJob } = await created.json();
    const getJob = async () => (await (await fetch(`${base}/api/jobs/${createdJob.id}`)).json()).job;
    let current;
    for (let i = 0; i < 100; i++) {
      current = await getJob();
      if (current.canAct || current.status === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(current.gateMode, 'sampling');
    assert.equal(current.resolvedMode, 'sampling');
    const actionUrl = `${base}/api/jobs/${createdJob.id}/action`;
    assert.equal((await fetch(actionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'next' }) })).status, 409);
    assert.equal((await fetch(actionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'invalid' }) })).status, 400);
    const cancelUrl = `${base}/api/jobs/${createdJob.id}/cancel`;
    assert.equal((await fetch(cancelUrl, { method: 'POST' })).status, 200);
    for (let i = 0; i < 100; i++) {
      current = await getJob();
      if (current.status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(current.status, 'cancelled');
    assert.equal(fs.existsSync(path.join(tmp, 'web-cancel', 'analysis.json')), false);
    assert.equal((await fetch(cancelUrl, { method: 'POST' })).status, 409);
    console.log('PASS Web 采样操作约束及取消后不生成报告');
  } finally {
    if (service) await new Promise(resolve => service.close(resolve));
    if (mock) { mock.closeAll(); await new Promise(resolve => mock.close(resolve)); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
