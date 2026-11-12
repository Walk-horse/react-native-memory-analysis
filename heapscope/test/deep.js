'use strict';
// Deep AI evidence: local snapshot mining + project source excerpts.
// Covers prompt injection, budget trimming, path confinement, secret redaction,
// fallback when snapshots were not retained, and the HTTP/SSE integration.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { makeFixture } = require('../src/fixture');
const { collectDeepEvidence, describeDeep } = require('../src/deep-evidence');
const { normalize, buildMessages, analyzeReport } = require('../src/ai');
const { createService } = require('../src/service/server');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ' · ' + detail : ''}`);
};

const ANALYSIS_BASE = {
  generatedAt: new Date().toISOString(), algorithm: 'devtools',
  meta: { target: 'mall (iPhone)', engine: 'hermes', rnVersion: '0.81.5', mode: 'snapshot', siteCoverage: '2/2' },
  totals: [{ label: 'A', shallowBytes: 100000, nodeCount: 100 }, { label: 'B', shallowBytes: 200000, nodeCount: 200 }],
  focus: { high: 1, watch: 0, low: 0 }, totalCandidates: 1, warnings: [],
  sourceCheck: { clean: false, reason: 'watchman: 3 个文件在采集期间发生变更' },
  candidates: [{
    type: 'object', name: 'FiberNode', countA: 2, countB: 5, countC: 8, trend: [2, 5, 8],
    totalBytes: 3072, globalHolder: true, focus: 'high', focusReason: '线性增长且全局持有',
    sourceDetail: { file: '/other-machine/build/src/StoreDetail.tsx', line: 42, method: 'onScroll', sourceLine: 'useEffect(() => subscribe(), [])' },
    sourceChain: [
      { via: '属性值', file: '/other-machine/build/node_modules/@foreshop/flash-list/src/FlashList.tsx', line: 10, business: false },
      { via: '逃逸测试', file: '/other-machine/build/src/escape.tsx', line: 1 },
      { via: '密钥测试', file: '/other-machine/build/src/.env', line: 1 },
      { via: 'bundle', file: 'http://127.0.0.1:8081/index.bundle?platform=ios', line: 12 },
    ],
    retainerText: 'GC roots -> global -> _listeners -> FiberNode',
  }],
};

function makeProject(tmp) {
  const root = path.join(tmp, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '@foreshop', 'flash-list', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'MallApp', version: '1.2.3',
    dependencies: { react: '19.0.0', 'react-native': '0.81.5', '@foreshop/flash-list': '2.0.2' },
  }));
  const lines = Array.from({ length: 80 }, (_, i) => `const line${i + 1} = 'normal code';`);
  lines[40] = 'const apiKey = "sk-supersecret-abcdef123456";';   // must be redacted
  lines[41] = 'useEffect(() => emitter.subscribe(onScroll), []);';
  fs.writeFileSync(path.join(root, 'src', 'StoreDetail.tsx'), lines.join('\n'));
  fs.writeFileSync(path.join(root, 'src', '.env'), 'API_KEY=sk-env-leak-123456789\n');
  fs.writeFileSync(path.join(root, 'node_modules', '@foreshop', 'flash-list', 'src', 'FlashList.tsx'),
    Array.from({ length: 20 }, (_, i) => `// FlashList line ${i + 1}`).join('\n'));
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'Secret.tsx'), 'const leak = "TOP_SECRET_OUTSIDE";\n');
  try { fs.symlinkSync(path.join(outside, 'Secret.tsx'), path.join(root, 'src', 'escape.tsx')); } catch { /* non-POSIX */ }
  return root;
}

function makeReport(tmp, name, { withSnapshots = true } = {}) {
  const outDir = path.join(tmp, 'out');
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  if (withSnapshots) {
    for (const [i, s] of makeFixture().entries()) {
      const f = path.join(dir, `snap-${i}.heapsnapshot`);
      fs.writeFileSync(f, JSON.stringify(s.data));
      files.push(f);
    }
  }
  const a = JSON.parse(JSON.stringify(ANALYSIS_BASE));
  a.meta.project = path.join(tmp, 'project');
  a.snapshotFiles = files;
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(a));
  return { outDir, dir, a, files };
}

function mockAiServer() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen.push({ url: req.url, headers: req.headers, body });
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '正常' } }], model: 'mock-model' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { content: '## 结论\n' } }] });
    send({ choices: [{ delta: { content: '已结合深度证据复核候选 1。' } }] });
    send({ choices: [{ delta: {} }], usage: { total_tokens: 88 }, model: 'mock-model' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return { server, seen };
}

async function readSse(res) {
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
      }
    }
  }
  return events;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heapscope-deep-'));
  const mock = mockAiServer();
  let service;
  try {
    const project = makeProject(tmp);
    const deep = makeReport(tmp, 'report-deep');
    const plain = makeReport(tmp, 'report-plain', { withSnapshots: false });

    // ---------- pure collector ----------
    const d = describeDeep({ analysis: deep.a, reportDir: deep.dir, project });
    check('预览接口能列出保留快照与源码位置',
      d.available && d.snapshotCount === 3 && d.siteCount >= 2 && d.project === fs.realpathSync(project),
      `${d.snapshotCount} snaps / ${d.siteCount} sites`);
    const p = describeDeep({ analysis: plain.a, reportDir: plain.dir, project });
    check('未保留快照时明确标记不可用并给出提示',
      !p.available && p.warnings.some(w => /保留快照/.test(w)));

    const stages = [];
    const ev = await collectDeepEvidence({
      analysis: deep.a, reportDir: deep.dir, project,
      options: { maxChars: 16000, maxSnapshots: 3, maxSourceFiles: 8, sourceRadius: 3 },
      onStage: (s, info) => stages.push(s),
    });
    assert.ok(ev);
    check('采集阶段事件完整', ['start', 'snapshot', 'sources', 'done'].every(s => stages.includes(s)), stages.join(','));
    check('快照结构与精确持有链进入证据',
      ev.meta.snapshots === 3 && /snap-2\.heapsnapshot/.test(ev.text) && /GC roots/.test(ev.text) && /newSinceBaseline/.test(ev.text),
      `${ev.meta.chars} chars`);
    check('跨机器绝对路径按后缀回退读到项目源码',
      /StoreDetail\.tsx:42/.test(ev.text) && /emitter\.subscribe/.test(ev.text) && /FlashList\.tsx:10/.test(ev.text));
    check('依赖与 RN 版本摘要进入证据', /react-native/.test(ev.text) && /0\.81\.5/.test(ev.text));
    check('采集期源码变更作为警告保留', ev.warnings.some(w => /watchman/.test(w)));

    // security
    check('源码中的密钥被脱敏', !ev.text.includes('sk-supersecret-abcdef123456') && /apiKey\s*=\s*"\*\*\*"/.test(ev.text));
    check('.env 与 bundle URL 位置被跳过', !ev.text.includes('sk-env-leak') && !ev.text.includes('API_KEY=') && !ev.text.includes('index.bundle'));
    check('项目外符号链接未被读取（路径限制）', !ev.text.includes('TOP_SECRET_OUTSIDE'));
    check('prompt 不泄露本地绝对路径', !ev.text.includes(deep.dir) && !ev.text.includes(fs.realpathSync(project) + '/src'));

    const small = await collectDeepEvidence({
      analysis: deep.a, reportDir: deep.dir, project, options: { maxChars: 2500, sourceRadius: 12 },
    });
    check('字符预算生效并标记裁剪', small.text.length <= 2600 && small.meta.truncated === true, `${small.text.length} chars`);

    const skipped = await collectDeepEvidence({
      analysis: deep.a, reportDir: deep.dir, project, options: { maxSnapshotMB: 0.00001 },
    });
    check('超过大小上限的快照被跳过且不伪造证据', skipped === null);
    check('无快照时采集返回 null', await collectDeepEvidence({ analysis: plain.a, reportDir: plain.dir, project }) === null);

    const cfg = normalize({ baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-model', maxCandidates: 3 });
    const withDeep = buildMessages(deep.a, cfg, '', ev);
    const without = buildMessages(deep.a, cfg, '');
    check('深度证据只在该模式下追加到 prompt',
      /深度证据/.test(withDeep.messages[1].content) && !/深度证据/.test(without.messages[1].content) &&
      withDeep.promptChars > without.promptChars);

    // ---------- HTTP + SSE ----------
    await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
    service = createService({ outDir: deep.outDir, project, metro: 'http://127.0.0.1:1' });
    await new Promise(r => service.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${service.address().port}`;
    const req = (p, opts = {}) => fetch(base + p, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    let r = await req('/api/ai/config', { method: 'PUT', body: {
      provider: 'custom', baseUrl, apiKey: 'sk-test-123456', model: 'mock-model',
      stream: true, deepAnalysis: true, deepMaxChars: 12000, deepSourceRadius: 3,
      deepMaxSourceFiles: 6, deepMaxSnapshots: 3,
    } });
    const c = (await r.json()).config;
    check('深度参数可保存并回显',
      c.deepAnalysis === true && c.deepMaxChars === 12000 && c.deepMaxSnapshots === 3 && c.apiKey === 'sk-t••••3456');

    r = await req('/api/ai/reports/report-deep/context');
    const ctx = (await r.json()).context;
    check('深度证据预览接口可用', ctx.available && ctx.snapshotCount === 3 && ctx.enabled === true, `${ctx.siteCount} sites`);
    r = await req('/api/ai/reports/report-plain/context');
    check('无快照报告的预览接口给出降级提示', (await r.json()).context.warnings.some(w => /未保留/.test(w)));

    r = await req('/api/reports/report-deep');
    const detail = (await r.json()).report;
    check('报告详情携带深度证据状态', detail.deep?.available === true && detail.deep.project === fs.realpathSync(project));

    // deep run
    r = await req('/api/ai/reports/report-deep/analyze', { method: 'POST', body: { note: '看订阅', deep: true } });
    assert.equal(r.status, 200);
    const events = await readSse(r);
    const kinds = events.map(e => e.type);
    check('深度分析 SSE 含阶段与证据事件',
      kinds[0] === 'start' && kinds.includes('stage') && kinds.includes('context') && kinds.at(-1) === 'done', kinds.join(','));
    check('阶段事件报告快照解析进度', events.some(e => e.stage === 'snapshot' && e.total === 3));
    const contextEvt = events.find(e => e.type === 'context');
    check('证据摘要事件含快照数与源码数', contextEvt.deep.snapshots === 3 && contextEvt.deep.sourceFiles >= 1,
      `${contextEvt.deep.chars} chars`);

    const prompts = mock.seen.filter(s => s.url.includes('chat/completions') && s.body.stream === true);
    const sentText = prompts.at(-1).body.messages[1].content;
    check('请求携带深度证据（快照结构/持有链/源码）',
      /深度证据/.test(sentText) && /GC roots/.test(sentText) && /StoreDetail\.tsx:42/.test(sentText) && /看订阅/.test(sentText));
    check('送出内容不含原始快照文件与明文密钥',
      !sentText.includes('"nodes":[') && !sentText.includes('sk-supersecret-abcdef123456'));
    const done = events.find(e => e.type === 'done');
    check('结论落盘记录深度证据元数据', done.result.deep?.snapshots === 3 && done.result.deepChars > 0);

    r = await req('/api/ai/reports/report-deep/result');
    const saved = (await r.json()).ai;
    check('持久化结论可读取深度标记', saved.deep?.snapshots === 3);
    const html = await (await req('/reports/report-deep/report.html')).text();
    check('单文件报告标注深度证据', /AI 分析/.test(html) && /深度证据/.test(html));
    r = await req('/api/reports');
    check('报告卡片显示深度分析标记', (await r.json()).reports.find(x => x.name === 'report-deep')?.ai?.deep?.snapshots === 3);

    // explicit opt-out
    r = await req('/api/ai/reports/report-deep/analyze', { method: 'POST', body: { deep: false } });
    const off = await readSse(r);
    check('单次可关闭深度分析', off.find(e => e.type === 'done')?.result?.deep === null);
    const offText = mock.seen.filter(s => s.url.includes('chat/completions') && s.body.stream === true).at(-1).body.messages[1].content;
    check('关闭后 prompt 只含报告摘要', !/深度证据（由 HeapScope/.test(offText));

    // fallback: deep requested but no snapshots retained
    r = await req('/api/ai/reports/report-plain/analyze', { method: 'POST', body: { deep: true } });
    const fb = await readSse(r);
    check('无快照时自动退回摘要模式', fb.some(e => e.type === 'stage' && e.stage === 'fallback') &&
      fb.find(e => e.type === 'done')?.result?.deep === null);

    // config switch
    await req('/api/ai/config', { method: 'PUT', body: { deepAnalysis: false } });
    r = await req('/api/ai/reports/report-deep/context');
    check('配置关闭后预览标记 enabled=false', (await r.json()).context.enabled === false);
    r = await req('/api/reports/report-deep');
    check('配置关闭后报告详情同步', (await r.json()).report.deep.enabled === false);
  } finally {
    if (service) await new Promise(r => service.close(r));
    await new Promise(r => mock.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(x => !x.ok).length;
  console.log(`${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} PASS\x1b[0m`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
