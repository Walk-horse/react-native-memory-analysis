'use strict';
// Multi-model AI config: models array, per-run selection, per-model key
// preservation, env override onto the active model. No network access; uses a
// local mock OpenAI-compatible server that accepts two distinct keys.

const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createService } = require('../src/service/server');
const { maskKey, normalize, selectModel } = require('../src/ai');

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
      const ok = req.headers.authorization === 'Bearer sk-test-1111' || req.headers.authorization === 'Bearer sk-deep-2222';
      if (!ok) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'unauthorized' } })); return; }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '正常' } }], model: body.model, usage: { total_tokens: 5 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      for (const p of ['## 结论\n', '疑似泄漏。\n', `- 模型 ${body.model}\n`]) send({ choices: [{ delta: { content: p } }] });
      send({ choices: [{ delta: {} }], usage: { total_tokens: 10 }, model: body.model });
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
  meta: { target: 'app', engine: 'hermes', rnVersion: '0.81.5', mode: 'snapshot', bridgeless: true, siteCoverage: '1/1' },
  totals: [{ label: 'A', shallowBytes: 1000, nodeCount: 10 }, { label: 'B', shallowBytes: 2000, nodeCount: 20 }],
  focus: { high: 1, watch: 0, low: 0 }, totalCandidates: 1, warnings: [],
  candidates: [{
    type: 'object', name: 'FiberNode', countA: 1, countB: 2, trend: [1, 2],
    totalBytes: 100000, globalHolder: true, focus: 'high', focusReason: '线性增长',
    sourceDetail: { file: 'src/X.tsx', line: 1, method: 'f', sourceLine: 'x' },
    retainerText: 'GC roots -> global -> FiberNode',
  }],
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heapscope-aim-'));
  const mock = mockAiServer();
  let service;
  const saved = {};
  for (const k of ['HEAPSCOPE_AI_MODEL', 'HEAPSCOPE_AI_BASE_URL', 'HEAPSCOPE_AI_API_KEY']) saved[k] = process.env[k];
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
    const twoModels = normalize({ models: [
      { name: '主力', provider: 'openai', baseUrl, apiKey: 'sk-test-1111', model: 'openai-mock' },
      { name: '备援', provider: 'deepseek', baseUrl, apiKey: 'sk-deep-2222', model: 'deepseek-mock' },
    ], defaultModel: '主力' });
    assert.equal(twoModels.models.length, 2);
    assert.equal(twoModels.defaultModel, '主力');
    assert.equal(twoModels.model, 'openai-mock');
    const selB = selectModel(twoModels, '备援');
    assert.equal(selB.model, 'deepseek-mock');
    assert.equal(selB.apiKey, 'sk-deep-2222');
    const selDefault = selectModel(twoModels, null);
    assert.equal(selDefault.model, 'openai-mock');
    const selUnknown = selectModel(twoModels, '不存在');
    assert.equal(selUnknown.model, 'openai-mock');
    check('selectModel 按名挑选 / 默认回退 / 未知回退', true);

    // --- config: save two models ---
    let r = await req('/api/ai/config', { method: 'PUT', body: {
      enabled: true,
      models: [
        { name: '主力', provider: 'openai', baseUrl, apiKey: 'sk-test-1111', model: 'openai-mock' },
        { name: '备援', provider: 'deepseek', baseUrl, apiKey: 'sk-deep-2222', model: 'deepseek-mock' },
      ],
      defaultModel: '主力',
      maxCandidates: 5,
    } });
    let c = (await r.json()).config;
    check('保存含两个模型的配置', c.models.length === 2 && c.defaultModel === '主力' && c.model === 'openai-mock' && c.ready === true,
      `active=${c.model}`);
    assert.equal(c.models.find(m => m.name === '主力').apiKey, 'sk-t••••1111');
    assert.equal(c.models.find(m => m.name === '备援').apiKey, 'sk-d••••2222');
    check('每个模型密钥独立脱敏', true);

    // --- analyze with explicit model selection ---
    r = await req('/api/ai/reports/report-x/analyze', { method: 'POST', body: { note: 'n', model: '备援' } });
    assert.equal(r.status, 200);
    let events = await readSse(r);
    let start = events.find(e => e.type === 'start');
    let done = events.find(e => e.type === 'done');
    check('按模型分析：start 事件报告选中模型', start.model === 'deepseek-mock', start.model);
    check('按模型分析：结论含该模型名', /deepseek-mock/.test(done.result.markdown));
    const sentB = mock.seen.find(s => s.url.includes('chat/completions'));
    assert.equal(sentB.body.model, 'deepseek-mock');
    assert.equal(sentB.headers.authorization, 'Bearer sk-deep-2222');
    check('按模型分析：请求携带该模型的 key 与 model', true);

    // --- analyze using default model (no body.model) ---
    mock.seen.length = 0;
    r = await req('/api/ai/reports/report-x/analyze', { method: 'POST', body: {} });
    events = await readSse(r);
    start = events.find(e => e.type === 'start');
    assert.equal(start.model, 'openai-mock');
    const sentA = mock.seen.find(s => s.url.includes('chat/completions'));
    assert.equal(sentA.headers.authorization, 'Bearer sk-test-1111');
    check('不指定模型时使用默认模型', true);

    // --- save with a masked key must NOT overwrite the other model's key ---
    mock.seen.length = 0;
    r = await req('/api/ai/config', { method: 'PUT', body: {
      models: [
        { name: '主力', provider: 'openai', baseUrl, apiKey: 'sk-test-1111', model: 'openai-mock' },
        { name: '备援', provider: 'deepseek', baseUrl, apiKey: 'sk-d••••2222', model: 'deepseek-mock' },
      ],
      defaultModel: '备援',
    } });
    c = (await r.json()).config;
    const disk = JSON.parse(fs.readFileSync(c.configPath, 'utf8'));
    assert.equal(disk.models.find(m => m.name === '备援').apiKey, 'sk-deep-2222');
    assert.equal(disk.models.find(m => m.name === '主力').apiKey, 'sk-test-1111');
    check('回传掩码不覆盖任一模型的已存密钥', true);
    assert.equal(c.defaultModel, '备援');
    assert.equal(c.model, 'deepseek-mock');
    check('defaultModel 切换生效', true);

    // --- env override applies to the active (default) model ---
    process.env.HEAPSCOPE_AI_MODEL = 'env-model';
    c = (await (await req('/api/ai/config')).json()).config;
    check('环境变量覆盖应用到活跃模型', c.model === 'env-model' && c.envOverrides.includes('model'));
    delete process.env.HEAPSCOPE_AI_MODEL;

    // --- test endpoint honours body.model ---
    r = await req('/api/ai/test', { method: 'POST', body: { model: '主力' } });
    let t = await r.json();
    check('测试连接按 body.model 选择模型', t.ok === true && t.model === 'openai-mock', t.model);
    r = await req('/api/ai/test', { method: 'POST', body: { model: '备援', config: { apiKey: 'sk-wrong' } } });
    t = await r.json();
    check('错误密钥按所选模型报错', r.status === 401 && /API Key 无效/.test(t.error || ''), t.error || '');
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    if (service) await new Promise(r => service.close(r));
    await new Promise(r => mock.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(x => !x.ok).length;
  console.log(`${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} PASS\x1b[0m`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
