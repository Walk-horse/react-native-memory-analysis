'use strict';
// End-to-end AI feature test: config masking/persistence, connectivity probe,
// SSE analysis, persisted conclusion, single-file report injection, errors.
// Uses a local mock OpenAI-compatible server, no network access required.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createService } = require('../src/service/server');
const { maskKey, normalize, validateConfig, buildMessages, DEFAULT_SYSTEM_PROMPT } = require('../src/ai');
const { markdownToHtml } = require('../src/markdown');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ' · ' + detail : ''}`);
};

function mockAiServer() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.url.startsWith('/v1/chat/completions') && req.method === 'POST') {
      if (body.model === 'fail-401' || req.headers.authorization !== 'Bearer sk-test-123456') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '正常' } }], model: 'mock-model', usage: { total_tokens: 7 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const pieces = [
        '## 结论\n', '疑似泄漏，证据见候选 1。\n\n',
        '- <script>alert(1)</script> 必须被转义\n', '- `FiberNode` 线性增长\n',
      ];
      for (const p of pieces) {
        if (body.model === 'slow-model') await new Promise(r => setTimeout(r, 90));
        send({ choices: [{ delta: { content: p } }] });
      }
      send({ choices: [{ delta: {} }], usage: { total_tokens: 150 }, model: 'mock-model' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404); res.end('not found');
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

const ANALYSIS = {
  generatedAt: new Date().toISOString(), algorithm: 'devtools',
  meta: { target: 'app (iPhone)', engine: 'hermes', rnVersion: '0.81.5', mode: 'snapshot', bridgeless: true, siteCoverage: '2/2' },
  totals: [{ label: 'A', shallowBytes: 1000, nodeCount: 10 }, { label: 'B', shallowBytes: 2000, nodeCount: 20 }],
  focus: { high: 1, watch: 0, low: 0 }, totalCandidates: 1, warnings: ['通道曾断连'],
  candidates: [{
    type: 'object', name: 'FiberNode', countA: 1, countB: 2, countC: 3, trend: [1, 2, 3],
    totalBytes: 100000, globalHolder: true, focus: 'high', focusReason: '线性增长且全局持有',
    sourceDetail: { file: 'src/StoreDetail.tsx', line: 42, method: 'onScroll', sourceLine: 'useEffect(() => {})' },
    sourceChain: [{ via: '属性值', file: 'src/StoreDetail.tsx', line: 42, business: true }],
    retainerText: 'GC roots -> global -> _listeners -> FiberNode',
  }],
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heapscope-ai-'));
  const mock = mockAiServer();
  let service;
  const savedModel = process.env.HEAPSCOPE_AI_MODEL;
  try {
    await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
    fs.mkdirSync(path.join(tmp, 'report-x'));
    fs.writeFileSync(path.join(tmp, 'report-x', 'analysis.json'), JSON.stringify(ANALYSIS));

    service = createService({ outDir: tmp, metro: 'http://127.0.0.1:1' });
    await new Promise(r => service.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${service.address().port}`;
    const req = (p, opts = {}) => fetch(base + p, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    // --- pure helpers ---
    assert.equal(maskKey('sk-test-123456'), 'sk-t••••3456');
    assert.equal(maskKey(''), '');
    assert.throws(() => validateConfig(normalize({ baseUrl: 'ftp://x/v1', model: 'm' })), /http/);
    assert.throws(() => validateConfig(normalize({ baseUrl, model: '' })), /模型名/);
    const md = markdownToHtml('## 标题\n<script>alert(1)</script>\n\n- **粗体** 与 `code`');
    assert.match(md, /<h2>标题<\/h2>/);
    assert.match(md, /&lt;script&gt;/);
    assert.doesNotMatch(md, /<script>alert/);
    assert.match(md, /<strong>粗体<\/strong>/);
    const msgs = buildMessages(ANALYSIS, normalize({ baseUrl, model: 'm', maxCandidates: 1 }), '重点看订阅');
    assert.equal(msgs.messages[0].content, DEFAULT_SYSTEM_PROMPT);
    assert.equal(msgs.candidatesUsed, 1);
    assert.match(msgs.messages[1].content, /重点看订阅/);
    assert.doesNotMatch(msgs.messages[1].content, /heapsnapshot/);
    check('配置校验、密钥掩码、Markdown 转义与 prompt 组装', true);

    // --- config ---
    let r = await req('/api/ai/config');
    let c = (await r.json()).config;
    check('初始配置未就绪且无密钥', c.ready === false && c.apiKey === '' && c.presets.length >= 5, `${c.presets.length} presets`);

    r = await req('/api/ai/config', { method: 'PUT', body: { provider: 'custom', baseUrl, apiKey: 'sk-test-123456', model: 'mock-model', maxCandidates: 5, stream: true, enabled: true } });
    c = (await r.json()).config;
    check('保存配置后就绪且密钥脱敏', c.ready === true && c.hasApiKey === true && c.apiKey === 'sk-t••••3456' && !JSON.stringify(c).includes('sk-test-123456'));
    const configPath = c.configPath;
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    check('配置文件权限为 0600', true);

    r = await req('/api/ai/config', { method: 'PUT', body: { apiKey: c.apiKey, maxCandidates: 4 } });
    c = (await r.json()).config;
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).apiKey, 'sk-test-123456');
    assert.equal(c.maxCandidates, 4);
    check('回传掩码不会覆盖已存密钥', true);

    r = await req('/api/ai/config', { method: 'PUT', headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await req('/api/ai/config', { method: 'PUT', body: { baseUrl: 'ftp://x/v1' } });
    assert.equal(r.status, 400);
    check('跨来源与非法配置被拒绝', true);

    process.env.HEAPSCOPE_AI_MODEL = 'env-model';
    c = (await (await req('/api/ai/config')).json()).config;
    check('环境变量覆盖生效并标注来源', c.model === 'env-model' && c.envOverrides.includes('model'));
    delete process.env.HEAPSCOPE_AI_MODEL;

    r = await req('/api/ai/test', { method: 'POST', body: { config: {} } });
    let t = await r.json();
    check('测试连接走真实 HTTP 探测', t.ok === true && t.model === 'mock-model' && /正常/.test(t.reply), `${t.latencyMs}ms`);
    r = await req('/api/ai/test', { method: 'POST', body: { config: { apiKey: 'sk-wrong' } } });
    t = await r.json();
    check('错误密钥给出可诊断的报错', r.status === 401 && /API Key 无效/.test(t.error || ''), t.error || '');

    // --- streaming analysis ---
    r = await req('/api/ai/reports/report-x/analyze', { method: 'POST', body: { note: '重点看 StoreDetail' } });
    assert.equal(r.status, 200);
    const events = await readSse(r);
    const kinds = events.map(e => e.type);
    const deltas = events.filter(e => e.type === 'delta').map(e => e.text).join('');
    const done = events.find(e => e.type === 'done');
    check('SSE 流完整（start / delta / done）', kinds[0] === 'start' && kinds.includes('delta') && kinds.at(-1) === 'done', kinds.join(','));
    check('流式增量拼成完整结论', /## 结论/.test(deltas) && /FiberNode/.test(deltas) && /## 结论/.test(done?.result?.markdown || ''));
    assert.match(done.result.html, /&lt;script&gt;/);
    assert.doesNotMatch(done.result.html, /<script>alert/);
    assert.equal(done.result.model, 'mock-model');
    assert.equal(done.result.usage.total_tokens, 150);
    assert.equal(done.result.candidatesUsed, 1);
    check('结论 HTML 转义、模型与 usage 元数据', true);

    const sent = mock.seen.find(s => s.url.includes('chat/completions') && s.body.stream === true);
    assert.equal(sent.headers.authorization, 'Bearer sk-test-123456');
    assert.match(sent.body.messages[1].content, /重点看 StoreDetail/);
    assert.match(sent.body.messages[1].content, /StoreDetail\.tsx/);
    check('请求携带密钥、补充关注点与源码位置', true);

    const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'report-x', 'ai-analysis.json'), 'utf8'));
    assert.equal(disk.markdown, done.result.markdown);
    assert.equal(disk.promptChars > 100, true);
    check('结论落盘到报告目录', true);

    // --- report surfaces ---
    const detail = (await (await req('/api/reports/report-x')).json()).report;
    check('报告详情带 AI 结论', !!detail.ai && /&lt;script&gt;/.test(detail.ai.html));
    const list = (await (await req('/api/reports')).json()).reports;
    check('报告卡片显示 AI 摘要', list.length === 1 && list[0].ai?.model === 'mock-model');
    const html = await (await req('/reports/report-x/report.html')).text();
    check('单文件报告内嵌 AI 章节且防注入', /AI 分析/.test(html) && /&lt;script&gt;/.test(html) && !/<script>alert/.test(html));

    // --- concurrency + cleanup ---
    await req('/api/ai/config', { method: 'PUT', body: { model: 'slow-model' } });
    const first = req('/api/ai/reports/report-x/analyze', { method: 'POST', body: {} }).then(readSse);
    await new Promise(res => setTimeout(res, 120));
    const second = await req('/api/ai/reports/report-x/analyze', { method: 'POST', body: {} });
    check('同一报告并发分析返回 409', second.status === 409);
    await first;
    await req('/api/ai/config', { method: 'PUT', body: { model: 'mock-model' } });

    r = await req('/api/ai/reports/report-x/result', { method: 'DELETE' });
    assert.equal((await r.json()).deleted, true);
    const after = await (await req('/reports/report-x/report.html')).text();
    check('清除结论后单文件报告不再含 AI 章节', !/id="ai-analysis"/.test(after));
  } finally {
    if (savedModel == null) delete process.env.HEAPSCOPE_AI_MODEL;
    else process.env.HEAPSCOPE_AI_MODEL = savedModel;
    if (service) await new Promise(r => service.close(r));
    await new Promise(r => mock.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(x => !x.ok).length;
  console.log(`${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} PASS\x1b[0m`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
