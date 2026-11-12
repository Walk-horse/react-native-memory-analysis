'use strict';
// Regression for: setting a timeout used to abort an analysis that was still
// producing output. timeoutMs is now an IDLE timeout (re-armed on every chunk);
// totalTimeoutMs is an optional hard ceiling for one request.
// Uses a local mock OpenAI-compatible server; no network / no real model.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createService } = require('../src/service/server');
const { chat, normalize, DEFAULTS } = require('../src/ai');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ' · ' + detail : ''}`);
};
const delay = ms => new Promise(r => setTimeout(r, ms));

function mockAiServer() {
  const state = { seen: [], endlessClosed: false };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    state.seen.push(body);
    if (!req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end('not found'); return; }
    const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const model = body.model;

    if (model === 'stalled') {
      // Headers + one chunk, then silence forever. Must still hit the idle guard.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ choices: [{ delta: { content: '开始' } }] });
      res.on('close', () => { /* client aborted after timeout */ });
      return;
    }
    if (model === 'endless') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => {
        if (res.destroyed) return;
        send({ choices: [{ delta: { content: '字' } }] });
      }, 60);
      res.on('close', () => { clearInterval(timer); state.endlessClosed = true; });
      return;
    }
    if (model === 'slow-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pieces = ['第一段\n', '第二段\n', '第三段\n', '第四段\n', '第五段\n', '第六段\n', '第七段\n', '第八段\n'];
      (async () => {
        for (const p of pieces) {
          await delay(180);
          if (res.destroyed) return;
          send({ choices: [{ delta: { content: p } }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      })();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ choices: [{ delta: { content: '完成' } }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return { server, state };
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
        if (!line.startsWith('data:')) continue; // SSE comments are ignored
        try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
      }
    }
  }
  return events;
}

const ANALYSIS = {
  generatedAt: new Date().toISOString(), algorithm: 'devtools',
  meta: { target: 'app (iPhone)', engine: 'hermes' },
  totals: [{ label: 'A', shallowBytes: 1000, nodeCount: 10 }],
  focus: { high: 0, watch: 0, low: 0 }, totalCandidates: 0, candidates: [], warnings: [],
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heapscope-ai-timeout-'));
  const mock = mockAiServer();
  let service;
  const savedEnv = { ...process.env };
  try {
    await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
    const cfg = extra => normalize({
      baseUrl, apiKey: 'sk-timeout-test', model: 'slow-stream',
      timeoutMs: 1000, totalTimeoutMs: 0, ...extra,
    });
    const msgs = [{ role: 'user', content: 'ping' }];

    // --- 1. The original bug: a stream longer than timeoutMs but still alive ---
    const t0 = Date.now();
    const got = [];
    const slow = await chat(cfg(), msgs, { onDelta: p => got.push(p) });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed > 1000, `stream should outlast the idle timeout, took ${elapsed}ms`);
    assert.equal(got.length, 8);
    assert.equal(slow.text, '第一段\n第二段\n第三段\n第四段\n第五段\n第六段\n第七段\n第八段\n');
    check('持续输出超过空闲超时仍不中断（原 bug 回归）', true, `${elapsed}ms > 1000ms, 8 chunks`);

    // --- 2. Silence must still time out, with a diagnosable message ---
    const t1 = Date.now();
    let stallErr;
    try { await chat(cfg({ model: 'stalled' }), msgs); } catch (e) { stallErr = e; }
    assert.ok(stallErr, 'stalled upstream must be aborted');
    assert.match(stallErr.message, /连续 1s 没有返回数据/);
    assert.match(stallErr.message, /空闲超时/);
    assert.ok(Date.now() - t1 < 3000);
    check('上游静默仍会触发空闲超时且文案可诊断', true, `${Date.now() - t1}ms`);

    // --- 3. Total ceiling stops a trickle that would otherwise never end ---
    let totalErr;
    try { await chat(cfg({ model: 'endless', totalTimeoutMs: 1000 }), msgs); } catch (e) { totalErr = e; }
    assert.ok(totalErr, 'total timeout must abort an endless trickle');
    assert.match(totalErr.message, /总时长超过 1s/);
    check('总时长上限兜底生效（持续吐字也不会无限挂住）', true, totalErr.message.slice(0, 60));

    // --- 4. Zero means unlimited total; defaults / env override are coherent ---
    assert.equal(DEFAULTS.totalTimeoutMs, 1800000);
    assert.equal(normalize({ totalTimeoutMs: 0 }).totalTimeoutMs, 0);
    process.env.HEAPSCOPE_AI_TOTAL_TIMEOUT_MS = '0';
    const { createConfigStore } = require('../src/ai');
    const store = createConfigStore({ outDir: tmp });
    store.save({ baseUrl, apiKey: 'sk-timeout-test', model: 'fast', timeoutMs: 1000, totalTimeoutMs: 900000 });
    assert.equal(store.publicView().totalTimeoutMs, 0); // env wins
    assert.match(store.publicView().envOverrides.join(','), /totalTimeoutMs/);
    delete process.env.HEAPSCOPE_AI_TOTAL_TIMEOUT_MS;
    assert.equal(store.read().totalTimeoutMs, 900000); // file value persists
    check('totalTimeoutMs 可持久化、0 = 不限、环境变量可覆盖', true);

    // --- 5. The stop button still cancels promptly ---
    const ac = new AbortController();
    const pending = chat(cfg(), msgs, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('已取消')), 200);
    let cancelErr;
    try { await pending; } catch (e) { cancelErr = e; }
    assert.ok(cancelErr && /已取消/.test(cancelErr.message));
    check('客户端停止按钮仍能立即取消请求', true);

    // --- 6. End-to-end SSE: slow stream longer than idle timeout still completes ---
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

    const put = await req('/api/ai/config', { method: 'PUT', body: {
      baseUrl, apiKey: 'sk-timeout-test', model: 'slow-stream',
      timeoutMs: 1000, totalTimeoutMs: 0, stream: true, enabled: true, deepAnalysis: false,
    } });
    const saved = (await put.json()).config;
    assert.equal(saved.timeoutMs, 1000);
    assert.equal(saved.totalTimeoutMs, 0);
    check('Web 配置接口保存并回显两项超时参数', true);

    const sse = await req('/api/ai/reports/report-x/analyze', { method: 'POST', body: { note: '', deep: false } });
    assert.equal(sse.status, 200);
    const events = await readSse(sse);
    const kinds = events.map(e => e.type);
    assert.equal(kinds.at(-1), 'done', `unexpected stream end: ${kinds.join(',')}`);
    assert.ok(!kinds.includes('error'));
    assert.match(events.find(e => e.type === 'done').result.markdown, /第八段/);
    check('SSE 端到端：超过空闲超时仍正常 done，无 error 事件', true, kinds.join(','));

    // --- 7. Client disconnect aborts the upstream request and frees the run lock ---
    await req('/api/ai/config', { method: 'PUT', body: { model: 'endless', totalTimeoutMs: 0 } });
    const controller = new AbortController();
    const dropped = req('/api/ai/reports/report-x/analyze', {
      method: 'POST', body: { deep: false }, signal: controller.signal,
    });
    await delay(250);
    controller.abort();
    await dropped.catch(() => {});
    let closed = mock.state.endlessClosed;
    for (let i = 0; i < 12 && !closed; i++) { await delay(80); closed = mock.state.endlessClosed; }
    assert.ok(closed, 'upstream AI request should be aborted when the client leaves');
    await req('/api/ai/config', { method: 'PUT', body: { model: 'fast' } });
    let again;
    for (let i = 0; i < 12; i++) {
      again = await req('/api/ai/reports/report-x/analyze', { method: 'POST', body: { deep: false } });
      if (again.status !== 409) break;
      await again.text();
      await delay(80);
    }
    assert.equal(again.status, 200, 'run lock must be released after disconnect');
    const cleanup = await readSse(again);
    assert.equal(cleanup.at(-1).type, 'done');
    check('客户端断开后上游请求被取消且报告锁释放', true);
  } finally {
    process.env = savedEnv;
    if (service) await new Promise(r => service.close(r));
    mock.server.closeAllConnections?.();
    await new Promise(r => mock.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(x => !x.ok).length;
  console.log(`${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} PASS\x1b[0m`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
