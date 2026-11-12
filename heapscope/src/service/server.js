'use strict';
// Zero-dependency HTTP + SSE service for HeapScope.
//   node bin/heapscope.js serve --port 7788
//
// Routes
//   GET  /                       -> web UI (public/index.html)
//   GET  /api/env                -> service config + v8 heap limit
//   GET  /api/targets            -> Metro inspector targets
//   POST /api/jobs               -> start a capture job
//   GET  /api/jobs               -> job list
//   GET  /api/jobs/:id           -> job detail
//   GET  /api/jobs/:id/events    -> SSE stream (log / stage / progress / end)
//   POST /api/jobs/:id/action    -> { action: 'next' | 'quit' }
//   POST /api/jobs/:id/cancel    -> hard stop
//   GET  /api/reports            -> report cards
//   GET  /api/reports/:name       -> report detail (analysis.json projection)
//   DEL  /api/reports/:name       -> delete a report directory
//   GET  /api/ai/config           -> masked AI config + presets
//   PUT  /api/ai/config           -> save AI config
//   POST /api/ai/test             -> connectivity probe
//   GET  /api/ai/reports/:name/context -> retained snapshots / project evidence availability
//   POST /api/ai/reports/:name/analyze -> SSE stream of AI analysis (optionally deep)
//   GET|DELETE /api/ai/reports/:name/result -> persisted AI conclusion
//   GET  /reports/:name/:file     -> raw report assets (report.html)

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const v8 = require('node:v8');

const { metroList, metroVersion, DEFAULT_METRO, stampMinute, fmtBytes } = require('../lib');
const { runCaptureJob } = require('../job');
const { render } = require('../report');
const { validateOptions } = require('../config');
const { createJob, publicJob, listReports, listOrphans, readReport, deleteReport, isSafeName, ensureFocus, readAiResult, saveAiResult, deleteAiResult } = require('./store');
const { createConfigStore, normalize, isReady, testConnection, analyzeReport, deepOptions, selectModel, MASK_MARK, KEEP } = require('../ai');
const { describeDeep, collectDeepEvidence } = require('../deep-evidence');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function createService({ outDir, metro = DEFAULT_METRO, project = null, aiConfigPath = null, log = () => {} }) {
  const jobs = new Map();
  const streams = new Set(); // SSE subscribers: { res, jobId }
  const aiStore = createConfigStore({ outDir, configPath: aiConfigPath });
  const aiRuns = new Map(); // report name -> AbortController; one AI run per report

  const emit = (jobId, payload) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const s of streams) {
      if (s.jobId && s.jobId !== jobId) continue;
      try { s.res.write(data); } catch { streams.delete(s); }
    }
  };

  const touch = job => emit(job.id, { type: 'job', job: publicJob(job) });
  const pushLog = (job, line) => {
    job.log.push(line);
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
    emit(job.id, { type: 'log', id: job.id, line });
  };

  function activeJob() {
    for (const j of jobs.values()) {
      if (j.status === 'running' || j.status === 'waiting' || j.status === 'queued') return j;
    }
    return null;
  }

  // Shared by the context preview and the analysis stream. The project is the
  // service-level --project (falling back to the path recorded at capture time);
  // it is never taken from an arbitrary request body.
  function loadAnalysis(name) {
    if (!isSafeName(name)) throw Object.assign(new Error('bad report name'), { status: 400 });
    const jsonPath = path.join(outDir, name, 'analysis.json');
    if (!fs.existsSync(jsonPath)) throw Object.assign(new Error(`报告不存在: ${name}`), { status: 404 });
    const a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    ensureFocus(a);
    return { a, dir: path.join(outDir, name), project: project || a.meta?.project || null };
  }

  async function startJob(params) {
    const running = activeJob();
    if (running) throw Object.assign(new Error(`已有分析在进行中（${running.id}），请等待或取消后再开始`), { status: 409 });

    const name = String(params.name || '').trim() || `analysis-${stampMinute()}`;
    if (!isSafeName(name)) throw Object.assign(new Error('输出名只能包含字母、数字、点、下划线、短横线'), { status: 400 });

    if (fs.existsSync(path.join(outDir, name))) throw Object.assign(new Error('输出目录已存在，请使用其他报告名'), { status: 409 });
    const requested = { steps: Number(params.steps ?? 3), interval: Number(params.interval ?? 0), top: Number(params.top ?? 30), mode: params.mode ?? 'auto', algorithm: params.algorithm ?? 'devtools' };
    try { validateOptions(requested); } catch (e) { e.status = 400; throw e; }
    const job = createJob({
      name, target: params.target ?? '0', metro: params.metro || metro,
      project: params.project ?? project, steps: requested.steps,
      mode: requested.mode, interval: requested.interval,
      top: requested.top, out: path.join(outDir, name),
      algorithm: requested.algorithm,
    });
    jobs.set(job.id, job);
    job.status = 'queued';
    job.startedAt = Date.now();

    const requestedOut = job.params.out;
    const opts = {
      metro: job.params.metro, target: job.params.target, project: job.params.project || null,
      out: requestedOut, steps: job.params.steps, mode: job.params.mode, interval: job.params.interval,
      top: job.params.top, algorithm: job.params.algorithm,
      // Web 流程：analysis.json 是唯一落盘产物，HTML 打开时实时渲染；
      // 快照/采样/sourcemap 在分析成功后自动清理（UI 可勾选保留）。
      keepSnapshots: params.keepSnapshots === true,
      writeHtml: false,
    };

    const hooks = {
      isCancelled: () => !!job.cancelRequested,
      onCdp: cdp => { job.closeCdp = () => { try { cdp.close(); } catch { /* gone */ } }; },
      onStage: s => {
        job.stage = s.stage;
        job.stageInfo = s;
        if (s.stage === 'connected') job.resolvedMode = s.mode;
        if (s.stage === 'sampling') job.resolvedMode = 'sampling';
        if (s.stage === 'waiting') job.status = 'waiting';
        else if (['connecting', 'connected', 'snapshot', 'analyzing', 'sampling'].includes(s.stage)) job.status = 'running';
        if (s.stage === 'snapshot' && s.phase === 'done') job.rounds.push({ index: s.index, bytes: s.bytes, chunks: s.chunks });
        emit(job.id, { type: 'stage', id: job.id, stage: s.stage, info: s });
        touch(job);
      },
      onLog: line => pushLog(job, line),
      onProgress: p => {
        job.progress = p;
        emit(job.id, { type: 'progress', id: job.id, progress: p });
      },
      onGateExpired: ({ round, mode }) => {
        if (job.gate?.round === round && job.gate?.mode === mode) { job.gate = null; job.status = 'running'; touch(job); }
      },
      gate: ({ round, steps, mode, deadline }) => new Promise(resolve => {
        if (job.pendingQuit) {
          job.pendingQuit = false;
          pushLog(job, '▶ 应用此前记录的「结束并出报告」');
          resolve({ action: 'quit' });
          return;
        }
        job.status = 'waiting';
        job.gate = { mode, round, steps, deadline, resolve: action => resolve({ action }) };
        const label = mode === 'sampling'
          ? '采样进行中 —— 在 App 里复现一次场景，然后点「结束采样并出报告」'
          : `等待操作：第 ${round}/${Math.max(1, steps - 1)} 轮 —— 在 App 里复现一次场景，然后点「拍下一张快照」`;
        pushLog(job, `⏸ ${label}`);
        touch(job);
      }),
    };

    runCaptureJob(opts, hooks)
      .then(r => {
        if (job.cancelRequested) {
          job.status = 'cancelled';
          job.stage = 'cancelled';
          job.error = '已手动取消';
        } else {
          job.status = 'done';
          job.stage = 'done';
          job.result = {
            name, htmlUrl: `/reports/${encodeURIComponent(name)}/report.html`,
            apiUrl: `/api/reports/${encodeURIComponent(name)}`,
            candidates: r.analysis.candidates.length,
            totalCandidates: r.analysis.totalCandidates,
            heapFirst: r.analysis.totals[0]?.shallowBytes ?? null,
            heapLast: r.analysis.totals.at(-1)?.shallowBytes ?? null,
            warnings: r.warnings.length,
          };
          pushLog(job, `✓ 分析完成 · ${r.analysis.candidates.length} 组泄漏候选 · 报告已生成`);
        }
        job.finishedAt = Date.now();
        job.gate = null;
        // Publish the terminal job snapshot before the end marker so clients
        // cannot render a stale snapshot stage after completion.
        touch(job);
        emit(job.id, { type: 'end', id: job.id, status: job.status, result: job.result });
      })
      .catch(e => {
        job.status = job.cancelRequested ? 'cancelled' : 'error';
        job.stage = job.status;
        job.error = e.message;
        job.finishedAt = Date.now();
        job.gate = null;
        pushLog(job, `✗ ${e.message}`);
        touch(job);
        emit(job.id, { type: 'end', id: job.id, status: job.status, error: e.message });
      });

    log(`job ${job.id} started → ${requestedOut}`);
    return publicJob(job);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // Reject cross-origin browser requests; this does not replace authentication.
      const origin = req.headers.origin;
      if (origin) {
        let sameOrigin = false;
        try { const u = new URL(origin); sameOrigin = u.protocol === 'http:' && u.host === req.headers.host; } catch { /* invalid origin */ }
        if (!sameOrigin) return json(res, 403, { ok: false, error: '跨来源请求被拒绝' });
      }
      // ---- API ----
      if (p === '/api/env') {
        const stat = v8.getHeapStatistics();
        return json(res, 200, {
          version: require('../../package.json').version,
          outDir, metro: url.searchParams.get('metro') || metro, project,
          heapLimitMB: Math.round(stat.heap_size_limit / 1048576),
          node: process.version,
          activeJob: activeJob()?.id || null,
          ai: (() => { const c = aiStore.read(); return { ready: isReady(c), provider: c.provider, model: c.model, modelCount: c.models?.length || 0, defaultModel: c.defaultModel, configPath: aiStore.configPath, deepEnabled: c.deepAnalysis }; })(),
        });
      }

      if (p === '/api/targets') {
        const m = (url.searchParams.get('metro') || metro).replace(/\/$/, '');
        try {
          const [list, ver] = await Promise.all([metroList(m), metroVersion(m)]);
          return json(res, 200, {
            ok: true, metro: m, protocol: ver?.['Protocol-Version'] || null, browser: ver?.Browser || null,
            targets: list.map((t, i) => ({
              index: i, id: t.id, title: t.title || '', description: t.description || '',
              device: t.deviceName || '', wsUrl: t.wsUrl || '',
            })),
          });
        } catch (e) {
          return json(res, 200, { ok: false, metro: m, error: e.message, targets: [], hints: [
            'Metro 未运行或端口不通：先在 RN 项目里启动 Metro',
            'Android 真机需要 adb reverse tcp:8081 tcp:8081',
            'App 必须是 dev build（release 包没有 inspector）',
          ] });
        }
      }

      if (p === '/api/jobs' && req.method === 'POST') {
        const body = await readBody(req);
        const job = await startJob(body);
        return json(res, 201, { ok: true, job });
      }

      if (p === '/api/jobs' && req.method === 'GET') {
        const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(j => publicJob(j, { logLimit: 0 }));
        return json(res, 200, { ok: true, jobs: list });
      }

      const jobMatch = p.match(/^\/api\/jobs\/([\w-]+)(\/events|\/action|\/cancel)?$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(res, 404, { ok: false, error: 'job not found' });
        const sub = jobMatch[2];

        if (sub === '/events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
          });
          res.write(`data: ${JSON.stringify({ type: 'job', job: publicJob(job) })}\n\n`);
          const sub_ = { res, jobId: job.id };
          streams.add(sub_);
          const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
          req.on('close', () => { clearInterval(ping); streams.delete(sub_); });
          return;
        }

        if (sub === '/action' && req.method === 'POST') {
          const body = await readBody(req);
          if (!['next', 'quit'].includes(body.action)) return json(res, 400, { ok: false, error: '无效操作' });
          const action = body.action;
          if (job.cancelRequested) return json(res, 409, { ok: false, error: '任务正在取消' });
          if (!job.gate) {
            const live = ['queued', 'running', 'waiting'].includes(job.status);
            if (live && action === 'quit' && job.stage === 'snapshot') {
              // 快照/分析进行中点「结束」：记录下来，到下一个等待点自动生效
              job.pendingQuit = true;
              pushLog(job, '已记录「结束并出报告」：当前步骤完成后自动结束');
              touch(job);
              return json(res, 200, { ok: true, queued: true });
            }
            const why = job.status === 'error'
              ? `任务已失败：${job.error || '未知错误'}`
              : job.status === 'done' ? '任务已完成' : `当前状态 ${job.status}`;
            return json(res, 409, { ok: false, error: `当前任务不在等待状态（${why}）`, status: job.status });
          }
          if (job.gate.mode === 'sampling' && action !== 'quit') return json(res, 409, { ok: false, error: '采样中只能结束采样' });
          job.gate.resolve(action);
          job.gate = null;
          job.status = 'running';
          pushLog(job, action === 'quit' ? '▶ 结束采集，开始分析' : '▶ 已触发，正在拍摄快照');
          touch(job);
          return json(res, 200, { ok: true });
        }

        if (sub === '/cancel' && req.method === 'POST') {
          if (!['queued', 'running', 'waiting'].includes(job.status)) return json(res, 409, { ok: false, error: '任务已结束' });
          if (job.stage === 'analyzing') return json(res, 409, { ok: false, error: '分析已开始，暂不支持取消，请等待完成' });
          if (job.cancelRequested) return json(res, 200, { ok: true });
          job.cancelRequested = true;
          if (job.gate) { job.gate.resolve('quit'); job.gate = null; }
          job.closeCdp?.();
          pushLog(job, '✗ 已请求取消');
          touch(job);
          return json(res, 200, { ok: true });
        }

        return json(res, 200, { ok: true, job: publicJob(job) });
      }

      // ---- AI config + analysis ----
      if (p === '/api/ai/config' && req.method === 'GET') {
        return json(res, 200, { ok: true, config: aiStore.publicView() });
      }

      if (p === '/api/ai/config' && req.method === 'PUT') {
        const body = await readBody(req);
        try { return json(res, 200, { ok: true, config: aiStore.save(body) }); }
        catch (e) { e.status = 400; throw e; }
      }

      if (p === '/api/ai/test' && req.method === 'POST') {
        const body = await readBody(req);
        // Select a named model (or the configured default) and overlay any
        // unsaved form values sent by the AI config page.
        const eff = selectModel(aiStore.read(), body.model);
        const patch = { ...(body.config || {}) };
        // A masked / placeholder key means "keep the stored one".
        if (!patch.apiKey || patch.apiKey === KEEP || String(patch.apiKey).includes(MASK_MARK)) delete patch.apiKey;
        const cfg = normalize({ ...eff, ...patch });
        if (!isReady(cfg)) { const e = new Error('AI 尚未配置完成：请填写 Base URL、模型名和 API Key'); e.status = 400; throw e; }
        try { return json(res, 200, { ok: true, ...await testConnection(cfg) }); }
        catch (e) { e.status = e.status || 502; throw e; }
      }

      const aiResultMatch = p.match(/^\/api\/ai\/reports\/([^/]+)\/result$/);
      if (aiResultMatch) {
        const name = decodeURIComponent(aiResultMatch[1]);
        if (!isSafeName(name)) return json(res, 400, { ok: false, error: 'bad report name' });
        if (req.method === 'DELETE') {
          const r = deleteAiResult(outDir, name);
          log(`AI result ${name} deleted`);
          return json(res, 200, { ok: true, ...r });
        }
        return json(res, 200, { ok: true, ai: readAiResult(outDir, name) });
      }

      const aiContextMatch = p.match(/^\/api\/ai\/reports\/([^/]+)\/context$/);
      if (aiContextMatch && req.method === 'GET') {
        const name = decodeURIComponent(aiContextMatch[1]);
        const { a, dir, project: proj } = loadAnalysis(name);
        const cfg = aiStore.read();
        return json(res, 200, {
          ok: true,
          context: describeDeep({ analysis: a, reportDir: dir, project: proj, enabled: cfg.deepAnalysis }),
          options: deepOptions(cfg),
        });
      }

      const aiAnalyzeMatch = p.match(/^\/api\/ai\/reports\/([^/]+)\/analyze$/);
      if (aiAnalyzeMatch && req.method === 'POST') {
        const name = decodeURIComponent(aiAnalyzeMatch[1]);
        if (!isSafeName(name)) return json(res, 400, { ok: false, error: 'bad report name' });
        const body = await readBody(req);
        const cfg = aiStore.read();
        // Per-run model selection: the report panel may request any configured
        // profile by name; unknown/omitted falls back to the configured default.
        const eff = selectModel(cfg, body.model);
        if (!isReady(eff)) return json(res, 400, { ok: false, error: 'AI 尚未配置完成：请先在「AI 配置」页填写 Base URL、模型名和 API Key' });
        const { a, dir, project: proj } = loadAnalysis(name);
        if (aiRuns.has(name)) return json(res, 409, { ok: false, error: '该报告正在生成 AI 分析，请等待完成' });

        // Per-run override wins; otherwise follow the AI config. Deep analysis
        // silently degrades to report-only when no snapshot was retained.
        const deepWanted = body.deep == null ? cfg.deepAnalysis : body.deep === true;
        const preview = describeDeep({ analysis: a, reportDir: dir, project: proj, enabled: deepWanted });

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
        });
        const send = (type, data) => {
          if (res.writableEnded || res.destroyed) return;
          try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch { /* client gone */ }
        };
        const ac = new AbortController();
        aiRuns.set(name, ac);
        // res 'close' fires on both normal completion and client disconnect;
        // writableEnded distinguishes the two. req 'close' can fire as soon as
        // the POST body is consumed and must NOT be used as the cancel signal.
        res.on('close', () => { if (!res.writableEnded) ac.abort(new Error('客户端已断开')); });
        // Deep-evidence parsing and slow first tokens can leave the SSE socket
        // quiet for a while. A periodic event keeps proxies/browsers from
        // dropping the connection and tells the UI the run is still alive.
        const startedAt = Date.now();
        const heartbeat = setInterval(() => {
          if (res.writableEnded || res.destroyed) return;
          send('heartbeat', { elapsedMs: Date.now() - startedAt });
        }, 15000);
        send('start', { model: eff.model, provider: eff.provider, name, deep: deepWanted && preview.available });
        try {
          let deep = null;
          if (deepWanted && preview.available) {
            deep = await collectDeepEvidence({
              analysis: a, reportDir: dir, project: proj,
              options: deepOptions(cfg),
              onStage: (stage, info) => {
                if (ac.signal.aborted) throw new Error('已取消');
                send('stage', { stage, ...info });
              },
            });
            if (!deep) send('stage', { stage: 'fallback', message: '快照不可用，已退回报告摘要模式' });
            else send('context', { deep: deep.meta });
          } else if (deepWanted) {
            send('stage', { stage: 'fallback', message: '该报告未保留快照，仅基于报告摘要分析' });
          }
          const result = await analyzeReport({
            config: eff, analysis: a, note: String(body.note || ''), deep, signal: ac.signal,
            onDelta: piece => send('delta', { text: piece }),
          });
          const saved = saveAiResult(outDir, name, result);
          send('done', { result: { ...saved, html: readAiResult(outDir, name)?.html || result.html } });
          log(`AI analysis ${name} done · ${eff.model} · ${result.markdown.length} chars · deep ${deep ? deep.meta.snapshots + ' snaps' : 'off'}`);
        } catch (e) {
          if (!res.writableEnded) send('error', { message: e.message });
          if (e.message !== '客户端已断开') log(`! AI analysis ${name}: ${e.message}`);
        } finally {
          clearInterval(heartbeat);
          aiRuns.delete(name);
          if (!res.writableEnded && !res.destroyed) res.end();
        }
        return;
      }

      if (p === '/api/reports') {
        return json(res, 200, { ok: true, outDir, reports: listReports(outDir), orphans: listOrphans(outDir) });
      }

      const reportMatch = p.match(/^\/api\/reports\/([^/]+)$/);
      if (reportMatch) {
        const name = decodeURIComponent(reportMatch[1]);
        if (req.method === 'DELETE') {
          const r = deleteReport(outDir, name);
          log(`report ${name} deleted · ${r.files} files · ${fmtBytes(r.freedBytes)}`);
          return json(res, 200, { ok: true, ...r });
        }
        const top = Number(url.searchParams.get('top') || 20);
        const cfg = aiStore.read();
        return json(res, 200, {
          ok: true,
          report: readReport(outDir, name, { top, project: project || null, deepEnabled: cfg.deepAnalysis }),
        });
      }

      // ---- raw report assets ----
      const assetMatch = p.match(/^\/reports\/([^/]+)\/([\w.-]+)$/);
      if (assetMatch) {
        const name = decodeURIComponent(assetMatch[1]);
        const file = assetMatch[2];
        if (!isSafeName(name) || !isSafeName(file)) return json(res, 400, { ok: false, error: 'bad path' });
        const dir = path.join(outDir, name);
        // Prefer re-rendering persisted analysis so historical reports also
        // receive presentation improvements; fall back to legacy HTML when no
        // analysis.json exists. Never rewrite the original offline artifact.
        if (file === 'report.html' && fs.existsSync(path.join(dir, 'analysis.json'))) {
          const jsonPath = path.join(dir, 'analysis.json');
          if (!fs.existsSync(jsonPath)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end('report not found');
          }
          let html;
          try {
            const a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            ensureFocus(a); // 旧报告补算重点关注标记
            html = render(a, { ai: readAiResult(outDir, name) }); // 已保存的 AI 结论也进单文件报告
          } catch (e) { return json(res, 500, { ok: false, error: `报告渲染失败: ${e.message}` }); }
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
          return res.end(html);
        }
        return serveFile(res, path.join(dir, file));
      }

      // ---- static UI ----
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      const staticMatch = p.match(/^\/([\w.-]+\.(css|js|svg|png|ico))$/);
      if (staticMatch) return serveFile(res, path.join(PUBLIC_DIR, staticMatch[1]));

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      const code = e.status || 500;
      if (code === 500) log(`! ${req.method} ${p} -> ${e.message}`);
      json(res, code, { ok: false, error: e.message });
    }
  });

  server.on('close', () => { for (const s of streams) { try { s.res.end(); } catch { /* closed */ } } streams.clear(); });
  return server;
}

module.exports = { createService };
