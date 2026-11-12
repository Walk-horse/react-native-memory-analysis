'use strict';
// HeapScope web UI - no framework, no build step.

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  env: null,
  targets: [],
  job: null,
  es: null,
  reports: [],
  orphans: [],
  timer: null,
  activeView: 'start',
  targetRequest: 0,
  targetsLoading: false,
  targetsMetro: null,
  starting: false,
  actionBusy: false,
  reportsLoading: false,
  booting: true,
  aiConfig: null,
  aiResult: null,
  aiBusy: false,
  aiAbort: null,
  aiRaw: '',
  aiDeep: null,
};

/* ---------------- utils ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.hints = data.hints || []; throw e; }
  return data;
}

const fmtBytes = n => {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${(n < 0 ? -v : v).toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)} ${u[i]}`;
};
const fmtTime = ts => {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtCount = n => {
  if (n == null) return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};
// 逐轮数量仅为线索；需要结合完整场景验证。
function trendBits(c) {
  const t = c.trend || [];
  if (t.length < 2) return '<span class="hint">旧报告无逐轮数据</span>';
  const d1 = t[1] - t[0];
  const deltas = t.slice(1).map((n, i) => n - t[i]);
  const d2 = t.length > 2 ? deltas[deltas.length - 1] : null;
  let tag = '仅 2 份', cls = 'mid';
  if (t[t.length - 1] <= t[0]) { tag = '无净增长'; cls = 'flat'; }
  else if (d2 == null) { tag = '仅 2 份'; cls = 'mid'; }
  else if (deltas.some(d => d < 0)) { tag = '波动'; cls = 'flat'; }
  else if ((t[t.length - 1] - t[0]) / Math.max(1, t[0]) < 0.02) { tag = '平稳'; cls = 'flat'; }
  else if (d1 <= 0) { tag = '后期增长'; cls = 'mid'; }
  else if (d2 / d1 >= 0.7 && deltas.every(d => d > 0)) { tag = '线性↑'; cls = 'rise'; }
  else if (d2 / d1 <= 0.35) { tag = '趋平'; cls = 'flat'; }
  else { tag = '放缓'; cls = 'mid'; }
  return `${t.map(fmtCount).join(' → ')} <span class="ttag ${cls}">${tag}</span>`;
}

/* ---------------- nav ---------------- */
function switchView(name) {
  state.activeView = name;
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${name}`; });
  $$('.nav-item').forEach(b => { const active = b.dataset.view === (name === 'detail' ? 'reports' : name); b.classList.toggle('active', active); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (name !== 'status') closeStream();
  else ensureStream();
  if (name === 'reports') loadReports();
  if (name === 'ai') loadAiConfig();
}

function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
}

function ensureStream() {
  const job = state.job;
  if (!job || state.es) return;
  if (!['queued', 'running', 'waiting'].includes(job.status)) return;
  bindSSE(job.id);
}

$$('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

/* ---------------- env + targets ---------------- */
async function loadEnv() {
  try {
    const e = await api('/api/env');
    state.env = e;
    $('#version').textContent = `v${e.version}`;
    $('#env-metro').textContent = e.metro;
    $('#env-heap').textContent = `${e.heapLimitMB} MB`;
    $('#env-out').textContent = e.outDir;
    $('#env-out').title = e.outDir;
    $('#f-metro').value = e.metro;
    if (e.project && !$('#f-project').value) $('#f-project').value = e.project;
    if (e.heapLimitMB < 6000) {
      $('#env-heap').style.color = 'var(--warn)';
      $('#env-heap').title = '大堆分析建议 8GB：NODE_OPTIONS=--max-old-space-size=8192 heapscope serve';
    }
  } catch (e) { /* service down */ }
}

const isLive = job => !!job && ['queued', 'running', 'waiting'].includes(job.status);

function renderStartControls() {
  const active = isLive(state.job);
  const ready = state.targets.length > 0 && state.targetsMetro === $('#f-metro').value.trim() && !!$('#f-target').value;
  $('#btn-start').disabled = state.booting || state.starting || state.targetsLoading || !ready || active;
  $('#btn-refresh').disabled = state.targetsLoading;
  $('#f-target').disabled = state.targetsLoading || !ready && !state.targets.length;
  $('#btn-show-active').hidden = !active;
  if (active && !state.starting) $('#start-hint').textContent = '已有任务正在运行，请先等待完成或取消。';
  else if (!state.starting && $('#start-hint').textContent.startsWith('已有任务')) $('#start-hint').textContent = '';
}

function renderModeHelp() {
  const sampling = $('#f-mode').value === 'sampling';
  $('#steps-field').hidden = sampling;
  $('#f-steps').disabled = sampling;
  $('#f-algorithm').disabled = sampling;
  $('#snapshot-tips').hidden = sampling;
  $('#sampling-tips').hidden = !sampling;
  const interval = $('#f-interval');
  interval.options[0].textContent = sampling ? '手动（点击结束采样）' : '手动（点按钮拍快照）';
  interval.options[1].textContent = sampling ? '自动结束 · 采样 15 秒' : '自动 · 15 秒';
  for (const option of [...interval.options].slice(2)) { option.hidden = sampling; option.disabled = sampling; }
  if (sampling && Number(interval.value) > 15) interval.value = '15';
  $('#mode-help').textContent = sampling ? '采样只记录一个采样窗口，不进行多轮快照差分；自动模式固定采样 15 秒。' : '完整快照适合对比存活对象；如果快照期间设备断连，可选择「仅采样」避免再次拍摄完整快照。';
}

async function loadTargets() {
  const metro = $('#f-metro').value.trim();
  const id = ++state.targetRequest;
  const sel = $('#f-target');
  const hint = $('#target-hint');
  const previous = sel.value;
  state.targetsLoading = true;
  state.targets = [];
  state.targetsMetro = null;
  sel.innerHTML = '<option value="">探测中 ...</option>';
  hint.textContent = '正在探测 Metro ...';
  renderStartControls();
  try {
    if (!metro) throw new Error('请输入 Metro 地址');
    const r = await api(`/api/targets?metro=${encodeURIComponent(metro)}`);
    if (id !== state.targetRequest) return;
    state.targets = r.targets || [];
    state.targetsMetro = metro;
    if (!state.targets.length) {
      sel.innerHTML = '<option value="">未发现设备</option>';
      hint.textContent = 'Metro 已连上，但没有可调试页面，请确认 App 已连接且为 dev 构建。';
    } else {
      const retained = state.targets.some(t => (t.id || String(t.index)) === previous);
      const prompt = state.targets.length > 1 ? '<option value="">请选择目标设备</option>' : '';
      sel.innerHTML = prompt + state.targets.map(t => `<option value="${esc(t.id || String(t.index))}">${esc(t.title || t.id)}${t.device ? ` · ${esc(t.device)}` : ''} · ${esc(t.id || String(t.index))}</option>`).join('');
      if (retained) sel.value = previous;
      hint.textContent = `${state.targets.length} 个目标${state.targets.length > 1 ? ' · 请核对设备名称和 ID' : ''} · ${r.browser || ''} ${r.protocol || ''}`.trim();
    }
  } catch (e) {
    if (id !== state.targetRequest) return;
    state.targets = [];
    sel.innerHTML = '<option value="">探测失败</option>';
    hint.textContent = e.message;
    hint.title = (e.hints || []).join('\n');
  } finally {
    if (id === state.targetRequest) { state.targetsLoading = false; renderStartControls(); }
  }
}

$('#btn-refresh').addEventListener('click', loadTargets);
$('#f-metro').addEventListener('change', loadTargets);
$('#f-metro').addEventListener('input', () => {
  ++state.targetRequest;
  state.targetsLoading = false;
  state.targets = [];
  state.targetsMetro = null;
  $('#f-target').innerHTML = '<option value="">请刷新设备</option>';
  $('#target-hint').textContent = '地址已更改，请刷新设备列表。';
  renderStartControls();
});
$('#f-target').addEventListener('change', renderStartControls);
$('#f-mode').addEventListener('change', renderModeHelp);
$('#btn-show-active').addEventListener('click', () => switchView('status'));
$('#btn-start-from-empty').addEventListener('click', () => switchView('start'));

/* ---------------- start job ---------------- */
$('#btn-start').addEventListener('click', async () => {
  const hint = $('#start-hint');
  if (state.starting || isLive(state.job)) return;
  state.starting = true;
  renderStartControls();
  hint.textContent = '正在启动 ...';
  try {
    const body = {
      metro: $('#f-metro').value.trim(),
      target: $('#f-target').value,
      project: $('#f-project').value.trim(),
      name: $('#f-name').value.trim(),
      steps: Number($('#f-steps').value),
      mode: $('#f-mode').value,
      interval: Number($('#f-interval').value),
      top: Number($('#f-top').value),
      algorithm: $('#f-algorithm').value,
      keepSnapshots: $('#f-keep-snaps').checked,
    };
    if (body.target === '' || state.targetsMetro !== body.metro) throw new Error('请刷新并选择目标设备');
    if (!Number.isInteger(body.top) || body.top < 5 || body.top > 200) throw new Error('候选条数必须是 5 到 200 的整数');
    if (body.name && (!/^[A-Za-z0-9._-]+$/.test(body.name) || body.name === '.' || body.name === '..')) throw new Error('报告名只能包含字母、数字、点、下划线和短横线');
    const r = await api('/api/jobs', { method: 'POST', body });
    hint.textContent = '';
    attachJob(r.job);
    switchView('status');
  } catch (e) {
    hint.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
  } finally {
    state.starting = false;
    renderStartControls();
  }
});

/* ---------------- job state ---------------- */
function attachJob(job) {
  state.job = job;
  $('#status-card').hidden = false;
  $('#status-empty').hidden = true;
  $('#log-card').hidden = false;
  $('#log').textContent = '';
  (job.log || []).forEach(appendLog);
  renderJob();
  if (state.activeView === 'status') bindSSE(job.id);
}

function bindSSE(id) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/jobs/${id}/events`);
  state.es = es;
  es.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (state.es !== es || state.job?.id !== id) return;
    if (msg.type === 'log') appendLog(msg.line);
    else if (msg.type === 'job') { state.job = msg.job; state.jobVersion = (state.jobVersion || 0) + 1; syncLog(msg.job.log); renderJob(); }
    else if (msg.type === 'stage') { state.job && Object.assign(state.job, { stage: msg.stage, stageInfo: msg.info }); renderJob(); }
    else if (msg.type === 'progress') { state.job && (state.job.progress = msg.progress); renderProgress(); }
    else if (msg.type === 'end') {
      // The terminal event is authoritative. Render it immediately instead of
      // waiting for the follow-up GET, otherwise the last snapshot/progress
      // event can remain visible while the log already says "completed".
      if (state.job?.id === id) {
        state.job = {
          ...state.job,
          status: msg.status || 'done',
          stage: msg.status === 'error' ? 'error' : msg.status === 'cancelled' ? 'cancelled' : 'done',
          result: msg.result || state.job.result,
          error: msg.error || state.job.error,
          finishedAt: state.job.finishedAt || Date.now(),
        };
        state.jobVersion = (state.jobVersion || 0) + 1;
        renderJob();
      }
      es.close();
      if (state.es === es) state.es = null;
      $('#nav-dot').hidden = true;
      refreshJob(id).then(() => loadReports());
    }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

async function refreshJob(id) {
  try {
    const version = state.jobVersion || 0;
    const r = await api(`/api/jobs/${id}`);
    if (state.job?.id !== id || version !== (state.jobVersion || 0)) return;
    state.job = r.job;
    if (state.activeView === 'status') syncLog(r.job.log);
    renderJob();
  } catch { /* ignore */ }
}

function stepNodes() {
  const steps = state.job?.params?.steps || 3;
  if (state.job?.resolvedMode === 'sampling' || state.job?.params?.mode === 'sampling') return [{ key: 'connecting', label: '连接设备' }, { key: 'sampling', label: '采样并复现' }, { key: 'analyzing', label: '分析热点' }, { key: 'done', label: '报告' }];
  const nodes = [{ key: 'connecting', label: '连接设备' }, { key: 's0', label: '基线快照' }];
  for (let i = 1; i < steps; i++) {
    nodes.push({ key: `w${i}`, label: `复现场景 ${i}` });
    nodes.push({ key: `s${i}`, label: `快照 ${i}` });
  }
  nodes.push({ key: 'analyzing', label: '差分分析' });
  nodes.push({ key: 'done', label: '报告' });
  return nodes;
}

function activeIndex(job) {
  const info = job.stageInfo || {};
  const nodes = stepNodes();
  const find = key => nodes.findIndex(n => n.key === key);
  switch (job.stage) {
    case 'connecting': return 0;
    case 'connected': return 1;
    case 'waiting': return find(`w${info.round}`) >= 0 ? find(`w${info.round}`) : 1;
    case 'snapshot': return find(`s${info.index ?? 0}`) >= 0 ? find(`s${info.index ?? 0}`) : 1;
    case 'sampling': return find('sampling') >= 0 ? find('sampling') : 1;
    case 'analyzing': return nodes.length - 2;
    case 'done': return nodes.length - 1;
    case 'error': case 'cancelled': return -1;
    default: return 0;
  }
}

function renderStepper() {
  const job = state.job;
  if (!job) return;
  const nodes = stepNodes();
  const act = activeIndex(job);
  $('#stepper').innerHTML = nodes.map((n, i) => {
    const cls = !job ? '' : (i === act ? 'active' : i < act ? 'done' : '');
    return `<span class="step ${cls}"><span class="n">${i < act ? '✓' : i + 1}</span>${esc(n.label)}</span>`;
  }).join('');
}

function renderJob() {
  const job = state.job;
  if (!job) return;
  const p = job.params || {};
  $('#status-sub').textContent = `${p.name || ''} · 输出 ${p.out || ''}`;
  $('#pill-target').textContent = p.target != null ? `目标 ${p.target}` : '-';
  const sampling = (job.resolvedMode || p.mode) === 'sampling';
  $('#pill-mode').textContent = job.resolvedMode ? `实际模式 ${job.resolvedMode}` : `模式 ${p.mode || '-'}`;
  $('#pill-round').textContent = sampling ? '单次采样窗口' : `${p.steps || 0} 轮`;
  $('#status-badge').textContent = {
    queued: '排队中', running: '进行中', waiting: '等待操作', done: '已完成', error: '失败', cancelled: '已取消',
  }[job.status] || job.status;
  $('#status-badge').className = 'badge' + (job.status === 'done' ? ' done' : job.status === 'error' || job.status === 'cancelled' ? ' error' : '');

  renderStepper();
  renderProgress();

  const canAct = job.status === 'waiting' && job.canAct === true && !job.cancelRequested;
  const canQueueQuit = job.status === 'running' && job.stage === 'snapshot' && !job.cancelRequested;
  $('#action-bar').hidden = !canAct && !canQueueQuit;
  $('#btn-next').disabled = state.actionBusy || !canAct;
  $('#btn-quit').disabled = state.actionBusy || !!job.pendingQuit || !!job.cancelRequested;
  if (canQueueQuit) {
    $('#btn-next').hidden = true;
    $('#btn-quit').textContent = job.pendingQuit ? '已安排结束' : '本轮后结束并出报告';
    $('#action-hint').textContent = job.pendingQuit ? '当前快照完成后结束采集。' : '当前快照完成后结束，不再等待下一轮。';
  }
  if (canAct) {
    const info = job.stageInfo || {};
    if (job.gateMode === 'sampling') {
      $('#btn-next').hidden = true;
      $('#btn-quit').textContent = '结束采样并出报告';
      $('#action-hint').textContent = '采样进行中：在 App 里复现完场景后点这里结束';
    } else {
      $('#btn-next').hidden = false;
      $('#btn-next').textContent = `拍下一张快照（第 ${info.round}/${Math.max(1, (p.steps || 3) - 1)} 轮）`;
      $('#btn-quit').textContent = '结束并出报告';
      $('#action-hint').textContent = job.gateMode === 'timed'
        ? `自动等待中，到点自动拍；也可提前点按钮`
        : '在 App 里复现完场景后点这里';
    }
  }

  const live = ['queued', 'running', 'waiting'].includes(job.status);
  $('#cancel-bar').hidden = !live;
  $('#btn-cancel').disabled = state.actionBusy || !!job.cancelRequested || job.stage === 'analyzing';
  $('#btn-cancel').textContent = job.cancelRequested ? '正在取消…' : '取消本次分析';
  $('#cancel-hint').textContent = job.cancelRequested ? '正在停止采集，请稍候。' : job.stage === 'analyzing' ? '分析已开始，暂不支持取消。' : '取消不会生成报告，已采集文件会保留。';
  $('#result-bar').hidden = job.status !== 'done';
  if (job.status === 'done' && job.result) {
    $('#btn-open-report').href = job.result.htmlUrl;
  }
  if (job.status === 'error' && job.error) {
    $('#progress-text').textContent = `失败：${job.error}`;
  }

  if (live) {
    $('#nav-dot').hidden = false;
    if (!state.timer) state.timer = setInterval(tickElapsed, 1000);
    // 轮询兜底：SSE 断线或丢事件时，界面最多落后 3 秒
    if (!state.poll) {
      state.poll = setInterval(() => {
        const j = state.job;
        if (j && ['queued', 'running', 'waiting'].includes(j.status)) refreshJob(j.id);
        else { clearInterval(state.poll); state.poll = null; }
      }, 3000);
    }
  } else {
    $('#nav-dot').hidden = true;
    clearInterval(state.timer);
    state.timer = null;
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
  }
  renderStartControls();
  tickElapsed();
}

function tickElapsed() {
  const job = state.job;
  if (!job || !job.startedAt) return;
  const end = job.finishedAt || Date.now();
  $('#pill-elapsed').textContent = fmtDur(end - job.startedAt);
}

function renderProgress() {
  const job = state.job;
  if (!job) return;
  const bar = $('#progress-bar');
  const txt = $('#progress-text');
  const info = job.stageInfo || {};
  const pr = job.progress;

  // A terminal job always owns the completed state, even when the final
  // snapshot event arrived immediately before the end event.
  if (job.status === 'done') {
    bar.className = 'progress-bar';
    bar.style.width = '100%';
    txt.textContent = '分析完成，报告已生成';
    return;
  }
  if (job.status === 'cancelled') {
    bar.className = 'progress-bar';
    bar.style.width = '100%';
    txt.textContent = '已取消，未生成报告';
    return;
  }
  if (job.status === 'error') {
    bar.className = 'progress-bar';
    bar.style.width = '100%';
    txt.textContent = `分析失败：${job.error || '未知错误'}`;
    return;
  }

  if (job.stage === 'snapshot' && info.phase === 'start') {
    bar.className = 'progress-bar indeterminate';
    txt.textContent = pr?.bytes && !pr.done ? `正在接收快照 ${info.index} · ${fmtBytes(pr.bytes)} / ${pr.chunks} chunks（请勿操作 App）` : `正在拍摄快照 ${info.index}（App 冻结中，请勿操作）`;
    return;
  }
  bar.className = 'progress-bar';
  if (pr && pr.bytes && job.stage === 'snapshot') {
    bar.style.width = '65%';
    txt.textContent = `接收中 ${fmtBytes(pr.bytes)} · ${pr.chunks} chunks`;
    return;
  }
  const map = {
    connecting: [8, '连接 Metro inspector ...'],
    connected: [18, `已连接 · ${info.engine || ''}${info.bridgeless ? ' · bridgeless' : ''} · ${info.mode || ''}`],
    waiting: [30, '等待你在 App 里操作，完成后点「拍下一张快照」'],
    snapshot: [55, '快照传输完成'],
    sampling: [50, 'sampling 采集中 ...'],
    analyzing: [85, '差异分析 + source map 符号化 ...'],
    done: [100, '完成'],
    error: [100, '失败'],
    cancelled: [100, '已取消'],
  };
  const [pct, label] = map[job.stage] || [0, ''];
  bar.style.width = `${pct}%`;
  txt.textContent = label;
}

function syncLog(lines) {
  if (!Array.isArray(lines)) return;
  const el = $('#log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent = lines.join('\n') || '等待任务 ...';
  if ($('#autoscroll').checked && atBottom) el.scrollTop = el.scrollHeight;
}

function appendLog(line) {
  const el = $('#log');
  if (el.textContent === '等待任务 ...') el.textContent = '';
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent += (el.textContent ? '\n' : '') + line;
  const lines = el.textContent.split('\n');
  if (lines.length > 800) el.textContent = lines.slice(-800).join('\n');
  if ($('#autoscroll').checked && atBottom) el.scrollTop = el.scrollHeight;
}

$('#btn-next').addEventListener('click', () => act('next'));
$('#btn-quit').addEventListener('click', () => act('quit'));
$('#btn-goto-list').addEventListener('click', () => switchView('reports'));

async function act(action) {
  const job = state.job;
  if (!job || state.actionBusy || !isLive(job)) return;
  state.actionBusy = true;
  renderJob();
  try {
    await api(`/api/jobs/${job.id}/action`, { method: 'POST', body: { action } });
    await refreshJob(job.id);
  } catch (e) {
    appendLog(`✗ ${e.message}`);
    await refreshJob(job.id);
  } finally {
    state.actionBusy = false;
    renderJob();
  }
}

$('#btn-cancel').addEventListener('click', async () => {
  const job = state.job;
  if (!job || !isLive(job) || state.actionBusy || job.cancelRequested || job.stage === 'analyzing') return;
  if (!confirm('取消本次采集？已采集的文件会保留，本次不生成报告。')) return;
  state.actionBusy = true;
  renderJob();
  try {
    await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    await refreshJob(job.id);
  } catch (e) { appendLog(`✗ ${e.message}`); await refreshJob(job.id); }
  finally { state.actionBusy = false; renderJob(); }
});

/* ---------------- AI config ---------------- */
function setAiHint(msg, kind = '') {
  const el = $('#ai-hint');
  el.textContent = msg;
  el.style.color = kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--danger)' : '';
}

async function loadAiConfig() {
  try {
    const { config } = await api('/api/ai/config');
    state.aiConfig = config;
    fillAiForm(config);
  } catch (e) {
    $('#ai-config-state').textContent = `读取配置失败：${e.message}`;
  }
}

function renderAiModels() {
  const list = $('#ai-models-list');
  const presets = (state.aiConfig?.presets || []);
  const models = state.aiModels || [];
  if (!models.length) {
    list.innerHTML = '<div class="empty" style="padding:10px 0">还没有模型配置，点「+ 添加模型」新增一个。</div>';
    return;
  }
  list.innerHTML = models.map((m, i) => {
    const opts = presets.map(p => `<option value="${esc(p.id)}"${p.id === m.provider ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
    const env = state.aiConfig?.envOverrides || [];
    const keyHint = m.hasApiKey
      ? `已保存密钥${env.includes('apiKey') ? ' · 当前由环境变量 HEAPSCOPE_AI_API_KEY 提供' : ''}（留空不修改）`
      : '未保存密钥；本地模型（Ollama）可留空';
    return `<div class="ai-model-card" data-index="${i}" data-old-name="${esc(m.name)}">
      <div class="ai-model-head">
        <input class="ai-m-name" value="${esc(m.name)}" placeholder="模型配置名（如：主力 / 备援 / 本地）" spellcheck="false" />
        <label class="chk"><input type="radio" name="ai-default-model" value="${esc(m.name)}"${state.aiDefault === m.name ? ' checked' : ''}/> 默认</label>
        <button class="btn ghost danger ai-m-remove" ${models.length <= 1 ? 'disabled' : ''} type="button" title="删除该模型">删除</button>
      </div>
      <div class="field-row">
        <div class="field"><label>服务商预设</label><select class="ai-m-provider">${opts}</select></div>
        <div class="field grow"><label>Base URL <span class="opt">接口会追加 /chat/completions</span></label><input class="ai-m-base-url" value="${esc(m.baseUrl)}" placeholder="https://api.openai.com/v1" spellcheck="false" /></div>
        <div class="field"><label>模型名</label><input class="ai-m-model" value="${esc(m.model)}" placeholder="gpt-4o-mini" spellcheck="false" /></div>
      </div>
      <div class="field-row">
        <div class="field grow">
          <label>API Key <span class="opt">只保存在本地配置文件，页面显示掩码</span></label>
          <div class="inline">
            <input class="ai-m-key" type="password" placeholder="${m.hasApiKey ? '已保存，留空不修改' : '未保存密钥'}" autocomplete="off" spellcheck="false" />
            <button class="btn ghost ai-m-key-toggle" type="button" title="显示 / 隐藏">显示</button>
            <button class="btn ghost danger ai-m-key-clear" type="button" title="清除已保存密钥">清除</button>
          </div>
          <div class="hint ai-m-key-hint">${keyHint}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function fillAiForm(c) {
  state.aiModels = (c.models || []).map(m => ({ name: m.name, provider: m.provider, baseUrl: m.baseUrl, model: m.model, hasApiKey: !!m.hasApiKey, apiKey: '', clearApiKey: false }));
  state.aiDefault = c.defaultModel || (c.models && c.models[0] && c.models[0].name) || '';
  $('#ai-temperature').value = c.temperature ?? 0.2;
  $('#ai-max-tokens').value = c.maxTokens ?? 2048;
  $('#ai-max-candidates').value = c.maxCandidates ?? 15;
  $('#ai-timeout').value = Math.round((c.timeoutMs ?? 120000) / 1000);
  const totalEl = $('#ai-total-timeout');
  if (totalEl) totalEl.value = Math.round((c.totalTimeoutMs ?? 1800000) / 60000);
  $('#ai-system').value = c.systemPrompt || '';
  $('#ai-enabled').checked = c.enabled !== false;
  $('#ai-stream').checked = c.stream !== false;
  $('#ai-deep').checked = c.deepAnalysis !== false;
  $('#ai-deep-snapshots').value = c.deepMaxSnapshots ?? 4;
  $('#ai-deep-candidates').value = c.deepMaxCandidates ?? 8;
  $('#ai-deep-files').value = c.deepMaxSourceFiles ?? 12;
  $('#ai-deep-radius').value = c.deepSourceRadius ?? 12;
  $('#ai-deep-chars').value = c.deepMaxChars ?? 18000;
  $('#ai-deep-mb').value = c.deepMaxSnapshotMB ?? 400;
  renderAiModels();
  $('#ai-config-path').textContent = c.configPath || '-';
  const env = c.envOverrides || [];
  $('#ai-config-state').innerHTML = c.ready
    ? `<span class="ai-state-ok">● 已就绪</span> · ${esc(c.model)}${env.length ? ` · 环境变量覆盖 ${esc(env.join(', '))}` : ''}${c.models?.length > 1 ? ` · ${c.models.length} 个模型` : ''}`
    : '<span class="ai-state-off">● 未配置完成</span> · 填写 Base URL、模型与 API Key 后即可使用';
  $('#ai-nav-state').textContent = c.ready ? '已配置' : '未配置';
}

function collectAiForm() {
  const models = [...document.querySelectorAll('#ai-models-list .ai-model-card')].map(card => {
    const keyEl = card.querySelector('.ai-m-key');
    const name = card.querySelector('.ai-m-name').value.trim() || '默认';
    const clear = card.dataset.clear === '1';
    return {
      name: name.slice(0, 40),
      provider: card.querySelector('.ai-m-provider').value || 'custom',
      baseUrl: card.querySelector('.ai-m-base-url').value.trim(),
      model: card.querySelector('.ai-m-model').value.trim(),
      apiKey: clear ? '' : (keyEl.value || ''),
      clearApiKey: clear,
      extraHeaders: {},
    };
  });
  const form = {
    enabled: $('#ai-enabled').checked,
    models,
    defaultModel: state.aiDefault,
    temperature: Number($('#ai-temperature').value),
    maxTokens: Number($('#ai-max-tokens').value),
    maxCandidates: Number($('#ai-max-candidates').value),
    timeoutMs: Number($('#ai-timeout').value) * 1000,
    stream: $('#ai-stream').checked,
    systemPrompt: $('#ai-system').value,
    deepAnalysis: $('#ai-deep').checked,
    deepMaxSnapshots: Number($('#ai-deep-snapshots').value),
    deepMaxCandidates: Number($('#ai-deep-candidates').value),
    deepMaxSourceFiles: Number($('#ai-deep-files').value),
    deepSourceRadius: Number($('#ai-deep-radius').value),
    deepMaxChars: Number($('#ai-deep-chars').value),
    deepMaxSnapshotMB: Number($('#ai-deep-mb').value),
  };
  const totalEl = $('#ai-total-timeout');
  if (totalEl) form.totalTimeoutMs = Number(totalEl.value) * 60000;
  return form;
}

// --- model list interactions (event delegation on the persistent container) ---
$('#ai-models-list').addEventListener('input', e => {
  const card = e.target.closest('.ai-model-card');
  if (!card) return;
  const t = e.target;
  if (t.classList.contains('ai-m-name')) {
    const newName = t.value.trim() || '默认';
    if (state.aiDefault === card.dataset.oldName) state.aiDefault = newName;
    card.dataset.oldName = newName;
    const radio = card.querySelector('input[name="ai-default-model"]');
    if (radio) radio.value = newName;
  } else if (t.classList.contains('ai-m-key')) {
    card.dataset.clear = '';
  }
});

$('#ai-models-list').addEventListener('change', e => {
  const card = e.target.closest('.ai-model-card');
  if (!card) return;
  if (e.target.name === 'ai-default-model') {
    state.aiDefault = card.querySelector('.ai-m-name').value.trim() || '默认';
    return;
  }
  if (e.target.classList.contains('ai-m-provider')) {
    const p = (state.aiConfig?.presets || []).find(x => x.id === e.target.value);
    card.querySelector('.ai-m-provider').value = e.target.value;
    if (p && p.baseUrl) {
      card.querySelector('.ai-m-base-url').value = p.baseUrl;
      card.querySelector('.ai-m-model').value = p.model;
      const idx = Number(card.dataset.index);
      if (state.aiModels[idx]) { state.aiModels[idx].baseUrl = p.baseUrl; state.aiModels[idx].model = p.model; }
    }
  }
});

$('#ai-models-list').addEventListener('click', e => {
  const card = e.target.closest('.ai-model-card');
  if (!card) return;
  const i = Number(card.dataset.index);
  if (e.target.classList.contains('ai-m-key-toggle')) {
    const el = card.querySelector('.ai-m-key');
    el.type = el.type === 'password' ? 'text' : 'password';
    e.target.textContent = el.type === 'password' ? '显示' : '隐藏';
  } else if (e.target.classList.contains('ai-m-remove')) {
    if ((state.aiModels || []).length <= 1) return;
    state.aiModels.splice(i, 1);
    if (state.aiDefault === card.dataset.oldName) state.aiDefault = state.aiModels[0]?.name || '';
    renderAiModels();
  } else if (e.target.classList.contains('ai-m-key-clear')) {
    const m = state.aiModels[i];
    if (!m || (!m.hasApiKey && !m.apiKey)) { setAiHint('当前没有已保存的密钥'); return; }
    if (!confirm(`清除模型「${m.name}」已保存的 API Key？`)) return;
    m.clearApiKey = true; m.apiKey = '';
    card.dataset.clear = '1';
    card.querySelector('.ai-m-key').value = '';
    setAiHint('✓ 该模型密钥将在保存时清除', 'ok');
  }
});

$('#btn-ai-add-model').addEventListener('click', () => {
  state.aiModels = state.aiModels || [];
  const n = state.aiModels.length + 1;
  state.aiModels.push({ name: `模型 ${n}`, provider: 'custom', baseUrl: '', model: '', hasApiKey: false, apiKey: '', clearApiKey: false });
  if (!state.aiDefault) state.aiDefault = state.aiModels[0].name;
  renderAiModels();
});

$('#btn-ai-prompt-reset').addEventListener('click', () => {
  $('#ai-system').value = state.aiConfig?.defaultSystemPrompt || '';
  setAiHint('已恢复默认提示词，记得保存');
});

$('#btn-ai-save').addEventListener('click', async () => {
  const btn = $('#btn-ai-save');
  btn.disabled = true;
  setAiHint('正在保存 ...');
  try {
    const { config } = await api('/api/ai/config', { method: 'PUT', body: collectAiForm() });
    state.aiConfig = config;
    fillAiForm(config);
    setAiHint(config.ready ? '✓ 配置已保存，可以生成 AI 分析了' : '✓ 已保存，但仍缺少必填项', 'ok');
  } catch (e) { setAiHint(`✗ ${e.message}`, 'err'); }
  finally { btn.disabled = false; }
});

$('#btn-ai-test').addEventListener('click', async () => {
  const btn = $('#btn-ai-test');
  btn.disabled = true;
  setAiHint('正在测试连接 ...');
  try {
    const r = await api('/api/ai/test', { method: 'POST', body: { config: collectAiForm() } });
    setAiHint(`✓ 连接正常 · ${r.model} · ${r.latencyMs}ms · 回复「${r.reply}」`, 'ok');
  } catch (e) { setAiHint(`✗ ${e.message}`, 'err'); }
  finally { btn.disabled = false; }
});

/* ---------------- AI report analysis ---------------- */
function populateAiModelSelect() {
  const sel = $('#ai-model-select');
  const cfgs = state.aiConfig?.models || [];
  if (!cfgs.length) { sel.hidden = true; return; }
  sel.hidden = false;
  sel.innerHTML = cfgs.map(m => `<option value="${esc(m.name)}">${esc(m.name)} · ${esc(m.model || '?')}</option>`).join('');
  sel.value = (cfgs.some(m => m.name === state.aiConfig.defaultModel) ? state.aiConfig.defaultModel : cfgs[0].name);
}

function applyDeepContext(deep) {
  state.aiDeep = deep || null;
  const box = $('#ai-run-deep');
  const hint = $('#ai-deep-hint');
  const row = box.closest('.ai-deep-row');
  if (!deep) {
    box.checked = false; box.disabled = true;
    row.classList.add('off');
    hint.textContent = '深度证据信息不可用';
    return;
  }
  const ok = deep.enabled !== false && deep.available;
  box.disabled = !ok;
  box.checked = ok && state.aiConfig?.deepAnalysis !== false;
  row.classList.toggle('off', !ok);
  if (!deep.available) {
    hint.textContent = '该报告未保留快照，只能基于报告摘要分析；重新采集时勾选「保留快照文件」可启用深度分析。';
  } else if (!deep.enabled) {
    hint.textContent = '深度分析已在「AI 配置」中关闭，启用后可结合快照与项目源码。';
  } else {
    const bits = [`${deep.snapshotCount} 份快照 / ${fmtBytes(deep.snapshotBytes)}`, `${deep.siteCount} 处源码位置`];
    if (deep.project) bits.push(`项目 …/${esc(deep.project.split('/').slice(-2).join('/'))}`);
    hint.innerHTML = `可用：${bits.join(' · ')}${deep.warnings?.length ? ` · ${esc(deep.warnings[0])}` : ''}`;
  }
}

function renderAiResult(ai) {
  const status = $('#ai-status'), meta = $('#ai-meta'), body = $('#ai-body');
  $('#btn-ai-clear').hidden = !ai;
  $('#btn-ai-copy').hidden = !ai;
  $('#btn-ai-run').textContent = ai ? '重新生成' : '生成 AI 分析';
  state.aiResult = ai || null;
  if (!ai) {
    status.textContent = '未分析';
    status.className = 'pill';
    meta.textContent = '';
    body.innerHTML = '<div class="empty">尚未生成 AI 分析。配置好模型后点击「生成 AI 分析」，报告摘要会送给模型做根因归纳。</div>';
    return;
  }
  status.textContent = '已生成';
  status.className = 'pill ok';
  const bits = [
    ai.model ? `模型 ${ai.model}` : null,
    ai.generatedAt ? `生成于 ${fmtTime(ai.generatedAt)}` : null,
    ai.usage?.total_tokens ? `tokens ${ai.usage.total_tokens}` : null,
    ai.promptChars ? `输入 ${ai.promptChars.toLocaleString()} 字符 / ${ai.candidatesUsed ?? '-'} 条候选` : null,
    ai.deep ? `深度证据 ${ai.deep.snapshots || 0} 份快照 / ${ai.deep.sourceFiles || 0} 个源码片段${ai.deep.truncated ? '（已裁剪）' : ''}` : null,
  ].filter(Boolean);
  meta.textContent = bits.join(' · ');
  body.innerHTML = ai.html ? `<div class="md">${ai.html}</div>`
    : `<pre class="ai-stream">${esc(ai.markdown || '')}</pre>`;
}

async function loadAiResult(name) {
  try {
    const { ai } = await api(`/api/ai/reports/${encodeURIComponent(name)}/result`);
    if (detailName === name) renderAiResult(ai);
  } catch (e) {
    if (detailName === name) $('#ai-body').innerHTML = `<div class="ai-error">读取 AI 结论失败：${esc(e.message)}</div>`;
  }
}

function setAiBusy(busy) {
  state.aiBusy = busy;
  $('#btn-ai-run').disabled = busy;
  $('#btn-ai-stop').hidden = !busy;
  $('#btn-ai-clear').disabled = busy;
  $('#ai-status').textContent = busy ? '分析中' : (state.aiResult ? '已生成' : '未分析');
  $('#ai-status').className = 'pill' + (!busy && state.aiResult ? ' ok' : '');
}

function appendAiDelta(text) {
  state.aiRaw += text;
  let pre = $('#ai-stream-out');
  if (!pre) {
    $('#ai-body').innerHTML = '<pre class="ai-stream" id="ai-stream-out"></pre>';
    pre = $('#ai-stream-out');
  }
  pre.textContent = state.aiRaw;
  pre.scrollTop = pre.scrollHeight;
}

async function runAiAnalysis() {
  const name = detailName;
  if (!name || state.aiBusy) return;
  if (state.aiConfig && !state.aiConfig.ready) {
    $('#ai-body').innerHTML = '<div class="ai-error">AI 尚未配置完成。请先在「AI 配置」页填写 Base URL、模型与 API Key 并保存。</div>';
    return;
  }
  state.aiRaw = '';
  setAiBusy(true);
  const ac = new AbortController();
  state.aiAbort = ac;
  try {
    populateAiModelSelect();
    const modelName = $('#ai-model-select').value || undefined;
    const res = await fetch(`/api/ai/reports/${encodeURIComponent(name)}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: $('#ai-note').value.trim(), deep: $('#ai-run-deep').checked, model: modelName }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const handle = msg => {
      if (msg.type === 'start') { $('#ai-meta').textContent = `正在调用 ${msg.model || 'AI'} ...`; }
      else if (msg.type === 'stage') {
        const text = msg.stage === 'snapshot' ? `本机解析快照 ${msg.index}/${msg.total}：${msg.file}`
          : msg.stage === 'sources' ? `读取项目源码：${msg.files} 个片段`
          : msg.stage === 'done' ? `深度证据就绪（${msg.snapshots} 份快照 / ${msg.sourceFiles} 个源码片段），等待模型输出 ...`
          : msg.stage === 'fallback' ? (msg.message || '退回报告摘要模式')
          : '正在准备深度证据 ...';
        $('#ai-meta').textContent = text;
      }
      else if (msg.type === 'context') {
        const d = msg.deep || {};
        $('#ai-meta').textContent = `深度证据 ${d.snapshots || 0} 份快照 / ${d.sourceFiles || 0} 个源码片段 · ${(d.chars || 0).toLocaleString()} 字符，正在请求模型 ...`;
      }
      else if (msg.type === 'heartbeat') {
        $('#ai-meta').textContent = `分析进行中，已等待 ${Math.round((msg.elapsedMs || 0) / 1000)}s（只要模型持续输出就不会被空闲超时中断）...`;
      }
      else if (msg.type === 'delta') appendAiDelta(msg.text || '');
      else if (msg.type === 'done') {
        renderAiResult(msg.result);
        // 单文件报告由服务端实时渲染，刷新内嵌 iframe 让 AI 章节同步出现
        $('#report-frame').src = `/reports/${encodeURIComponent(name)}/report.html?t=${Date.now()}`;
        loadReports();
      }
      else if (msg.type === 'error') throw new Error(msg.message || 'AI 分析失败');
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx).replace(/\r/g, '');
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let msg; try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handle(msg);
        }
      }
    }
    if (!state.aiResult) throw new Error('AI 服务未返回完整结论');
  } catch (e) {
    const stopped = e.name === 'AbortError';
    $('#ai-body').innerHTML = `<div class="ai-error">${esc(stopped ? '已停止生成' : e.message)}${state.aiRaw ? `<details><summary>查看已生成的部分内容</summary><pre class="ai-stream">${esc(state.aiRaw)}</pre></details>` : ''}</div>`;
  } finally {
    state.aiAbort = null;
    setAiBusy(false);
  }
}

$('#btn-ai-run').addEventListener('click', runAiAnalysis);
$('#btn-ai-stop').addEventListener('click', () => state.aiAbort?.abort());
$('#btn-ai-goto-config').addEventListener('click', () => switchView('ai'));
$('#btn-ai-copy').addEventListener('click', async () => {
  if (!state.aiResult?.markdown) return;
  try { await navigator.clipboard.writeText(state.aiResult.markdown); setAiHintForPanel('✓ 已复制 Markdown'); }
  catch { setAiHintForPanel('复制失败，请手动选择文本'); }
});
function setAiHintForPanel(msg) {
  const el = $('#ai-meta');
  const old = el.textContent;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = old; }, 2200);
}
$('#btn-ai-clear').addEventListener('click', async () => {
  const name = detailName;
  if (!name || !state.aiResult) return;
  if (!confirm(`清除报告 ${name} 的 AI 分析结论？`)) return;
  try {
    await api(`/api/ai/reports/${encodeURIComponent(name)}/result`, { method: 'DELETE' });
    renderAiResult(null);
    $('#ai-meta').textContent = '';
    $('#report-frame').src = `/reports/${encodeURIComponent(name)}/report.html?t=${Date.now()}`;
    loadReports();
  } catch (e) { $('#ai-body').innerHTML = `<div class="ai-error">${esc(e.message)}</div>`; }
});

/* ---------------- reports ---------------- */
async function loadReports() {
  if (state.reportsLoading) return;
  state.reportsLoading = true;
  $('#btn-reload-reports').disabled = true;
  try {
    const r = await api('/api/reports');
    state.reports = r.reports || [];
    state.orphans = r.orphans || [];
    $('#nav-count').textContent = state.reports.length;
    renderReports();
    renderOrphans();
  } catch (e) {
    $('#report-empty').hidden = true;
    $('#report-grid').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  } finally { state.reportsLoading = false; $('#btn-reload-reports').disabled = false; }
}

function renderReports() {
  const q = ($('#report-search').value || '').trim().toLowerCase();
  const list = state.reports.filter(r =>
    !q || r.name.toLowerCase().includes(q) || (r.target || '').toLowerCase().includes(q));
  const grid = $('#report-grid');
  $('#report-empty').hidden = list.length > 0;
  $('#report-empty').textContent = q ? '没有匹配的报告，请调整搜索条件。' : '还没有报告，先运行一次分析。';
  grid.innerHTML = list.map(r => {
    const d = r.heapDelta;
    const dCls = d == null ? '' : d > 0 ? 'up' : 'down';
    const dTxt = d == null ? '-' : `${d > 0 ? '+' : ''}${fmtBytes(d)}`;
    return `<article class="report-card" role="button" tabindex="0" aria-label="查看报告 ${esc(r.name)}" data-name="${esc(r.name)}">
      <div class="rc-head">
        <span class="name">${esc(r.name)}</span>
        <span class="time">${fmtTime(r.mtime)}</span>
      </div>
      <div class="rc-meta">
        <span class="pill">${esc(r.mode)}</span>
        <span class="pill">${r.rounds} 轮</span>
        <span class="pill">${r.candidates} 候选</span>
        ${r.warnings ? `<span class="pill">${r.warnings} 警告</span>` : ''}
        ${r.ai ? `<span class="pill rc-ai">✦ AI ${r.ai.deep ? '深度分析' : '已分析'}</span>` : ''}
        ${r.snapshots ? `<span class="pill" title="采集时保留了快照文件，可用于深度分析">◈ ${r.snapshots} 份快照</span>` : ''}
      </div>
      <div class="rc-stats">
        <span>堆 <b>${fmtBytes(r.heapFirst)}→${fmtBytes(r.heapLast)}</b></span>
        <span class="${dCls}">Δ <b class="${dCls}">${dTxt}</b></span>
      </div>
    </article>`;
  }).join('');
  grid.querySelectorAll('.report-card').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.name));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(el.dataset.name); } });
  });
}

$('#report-search').addEventListener('input', renderReports);
$('#btn-reload-reports').addEventListener('click', loadReports);

// 残留目录：采集失败/取消后只剩快照（或 .partial），没有 analysis.json，不进报告列表，
// 但磁盘上确实占空间，需要单独暴露并支持整目录删除。
function renderOrphans() {
  const box = $('#orphans');
  const list = state.orphans || [];
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  const total = list.reduce((n, o) => n + (o.bytes || 0), 0);
  box.hidden = false;
  box.innerHTML = `<div class="orphan-head">
      <span>残留目录 <b>${list.length}</b> 个 · 共 <b>${fmtBytes(total)}</b>（采集失败/取消，无 analysis.json）</span>
      <button class="btn ghost danger" id="btn-purge-orphans">全部删除</button>
    </div>
    ${list.map(o => `<div class="orphan-row">
      <span class="name">${esc(o.name)}</span>
      <span class="meta">${o.files} 个文件 · ${fmtBytes(o.bytes)}</span>
      <button class="btn ghost danger" data-orphan="${esc(o.name)}">删除</button>
    </div>`).join('')}`;
  box.querySelectorAll('[data-orphan]').forEach(b => {
    b.addEventListener('click', () => deleteOrphan(b.dataset.orphan));
  });
  $('#btn-purge-orphans').addEventListener('click', purgeOrphans);
}

async function deleteOrphan(name) {
  if (!confirm(`删除残留目录 ${name}？目录内所有文件（快照/采样）会被移除，不可恢复。`)) return;
  try {
    await api(`/api/reports/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadReports();
  } catch (e) { alert(e.message); }
}

async function purgeOrphans() {
  const list = state.orphans || [];
  if (!list.length) return;
  if (!confirm(`删除全部 ${list.length} 个残留目录？目录内的文件会一并移除，不可恢复。`)) return;
  const failed = [];
  for (const o of list) {
    try { await api(`/api/reports/${encodeURIComponent(o.name)}`, { method: 'DELETE' }); }
    catch (e) { failed.push(`${o.name}: ${e.message}`); }
  }
  await loadReports();
  if (failed.length) alert(`部分目录删除失败：\n${failed.join('\n')}`);
}

let detailName = null;
let detailReport = null;

function issueCell(c) {
  const d = c.issue || { severity: c.focus === 'high' ? 'high' : c.focus === 'watch' ? 'watch' : 'low', label: c.focus === 'high' ? '可能存在问题' : c.focus === 'watch' ? '潜在问题' : '暂未发现明显问题', summary: c.focusReason || '当前增长证据不足，建议结合持有链和重复实验确认。', advice: '结合源码位置、持有链和 GC 状态进一步确认。', signals: [] };
  const cls = d.severity === 'high' ? 'issue-high' : d.severity === 'watch' ? 'issue-watch' : 'issue-low';
  return `<td class="issue ${cls}"><strong>${esc(d.label)}</strong><div>${esc(d.summary)}</div><small>${esc((d.signals || []).slice(0, 2).join(' · '))}</small></td>`;
}

function focusTag(c) {
  if (c.focus === 'high') return ` <span class="tag hot" title="${esc(c.focusReason || '')}">重点关注</span>`;
  if (c.focus === 'watch') return ` <span class="tag watch" title="${esc(c.focusReason || '')}">观察</span>`;
  return '';
}

function renderSourceEvidence(entries) {
  if (!entries?.length) return '<div class="hint evidence-note">没有可解析的关联源码位置；请结合下方 GC Root 持有链检查。</div>';
  const rows = entries.map(e => {
    const parts = String(e.shortFile || e.file || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const segments = parts.map(part => `<span class="crumb-part">${esc(part)}</span>`);
    if (e.method) segments.push(`<span class="crumb-method">${esc(e.method)}</span>`);
    segments.push(`<span class="crumb-line">第 ${esc(e.line)} 行${e.columnBase === 1 && e.column != null ? ` · 第 ${esc(e.column)} 列` : ''}</span>`);
    const kind = e.business === true ? '<span class="pill ok">业务</span>' : e.business === false ? '<span class="pill">依赖/非业务</span>' : '<span class="pill">归属未知</span>';
    const snippet = e.snippet?.length
      ? `<details><summary>查看已保存的源码上下文</summary><pre class="evidence-code">${e.snippet.map(l => `<span class="${l.hit ? 'hit' : ''}">${esc(String(l.n).padStart(5))}  ${esc(l.text)}</span>`).join('')}</pre></details>`
      : e.sourceLine ? `<pre class="evidence-line">${esc(e.sourceLine)}</pre>` : '<div class="hint evidence-note">报告未保存源码内容，仅有位置；可用同版本 source map 重新分析。</div>';
    return `<div class="evidence-row"><div class="evidence-via">${esc(e.via)} ${kind}</div><div class="crumb" title="${esc(e.file)}">${segments.join('<span class="crumb-sep" aria-hidden="true">›</span>')}</div>${e.editorUrl ? `<a class="evidence-editor" href="${esc(e.editorUrl)}" title="在浏览器所在电脑打开该路径；需安装 VS Code 并存在同版本源码">在 VS Code 中打开 ↗</a>` : ''}${snippet}${e.symbolicator ? `<div class="hint">映射来源：${esc(e.symbolicator)}</div>` : ''}</div>`;
  }).join('');
  return `<details class="chainbox" open><summary>关联源码证据 ${entries.length} 项</summary><div class="hint evidence-note">每项是独立发现的位置；路径面包屑不是调用栈，关联位置也不等同于泄漏根因或分配点。</div>${rows}</details>`;
}

function renderCandRows() {
  const report = detailReport;
  if (!report) return;
  const only = $('#f-focus-only').checked;
  const list = report.candidates.map((c, i) => ({ c, i })).filter(({ c }) => !only || c.focus === 'high');
  if (!list.length) {
    $('#cand-table tbody').innerHTML = `<tr><td colspan="6" class="hint">${only ? '没有「重点关注」候选，取消勾选可看全部' : '暂无增长候选；可能未发现增长，或本报告没有快照差分。'}</td></tr>`;
    return;
  }
  $('#cand-table tbody').innerHTML = list.map(({ c, i }) => {
    const srcBits = [];
    const stacks = (Array.isArray(c.callStacks) ? c.callStacks : []).filter(stack => stack && stack.provenance === 'sampling' && Array.isArray(stack.frames) && stack.frames.length >= 2 && stack.frames.every(frame => frame && typeof frame === 'object'));
    if (stacks.length) {
      srcBits.push(`<details class="chainbox" open><summary>采样调用栈 ${stacks.length} 条</summary><div class="hint">采样分配路径，不代表泄漏根因；从调用方到分配热点。</div>${stacks.map(stack => `<div class="path">${stack.frames.map(frame => `<span>${esc(frame.functionName || '(anonymous)')}${frame.source || frame.url ? ` <small>${esc(frame.source || `${frame.url}:${Number(frame.line) + 1}`)}</small>` : ''}</span>`).join(' › ')}</div>`).join('')}</details>`);
    } else {
    srcBits.push(`<div class="src">${esc(c.sourceDetail ? `${c.sourceDetail.file}:${c.sourceDetail.line}` : (c.source || '-'))}${c.sourceDetail ? (/node_modules/i.test(c.sourceDetail.file || '') ? ' <span class="pill">依赖</span>' : ' <span class="pill ok">业务</span>') : ''}</div>`);
    if (c.siteVia) srcBits.push(`<div class="hint">${esc(c.siteVia)}</div>`);
    if (c.sourceDetail && c.sourceDetail.sourceLine) srcBits.push(`<div class="hint mono">${esc(c.sourceDetail.sourceLine.trim())}</div>`);
    srcBits.push(renderSourceEvidence(c.sourceEvidence));
    }
    if (c.focusReason) srcBits.push(`<div class="hint hot-hint">${c.focus === 'high' ? '重点关注' : '标记'}：${esc(c.focusReason)}</div>`);
    if (c.issue?.advice) srcBits.push(`<div class="hint"><strong>建议：</strong>${esc(c.issue.advice)}</div>`);
    return `
      <tr class="crow${c.focus === 'high' ? ' hot' : ''}" tabindex="0" role="button" aria-expanded="false" aria-label="展开候选 ${esc(c.name)}">
        <td class="mono"><span class="caret">▸</span>${i + 1}</td>
        <td><div class="nm">${esc(c.name)}${focusTag(c)}</div><div class="hint">${esc(c.type)}${c.globalHolder ? ' · 全局持有' : ''}</div></td>
        <td class="mono">${c.countA}→${c.countB}${c.countC != null ? `→${c.countC}` : ''}${c.newCount != null ? `<div class="hint">new +${c.newCount} · del -${c.deletedCount}</div>` : ''}</td>
        <td class="mono tline">${trendBits(c)}</td>
        <td class="mono up">+${fmtBytes(c.totalBytes)}</td>
        ${issueCell(c)}
      </tr>
      <tr class="xrow" hidden><td colspan="6"><div class="xgrid">
        <div><div class="xh">源码位置</div>${srcBits.join('')}</div>
        <div><div class="xh">GC root 持有链</div><div class="path">${esc(c.retainerText || 'n/a')}</div></div>
      </div></td></tr>`;
  }).join('');
}

async function openDetail(name) {
  detailName = name;
  detailReport = null;
  switchView('detail');
  $('#detail-name').textContent = name;
  $('#detail-chips').innerHTML = '';
  $('#detail-warnings').innerHTML = '';
  $('#cand-table tbody').innerHTML = '';
  $('#f-focus-only').checked = false;
  $('#focus-count').hidden = true;
  $('#report-frame').src = `/reports/${encodeURIComponent(name)}/report.html`;
  $('#detail-raw').href = `/reports/${encodeURIComponent(name)}/report.html`;
  renderAiResult(null);
  $('#ai-meta').textContent = '';
  applyDeepContext(null);
  populateAiModelSelect();
  $('#ai-deep-hint').textContent = '正在检查可用证据 ...';
  loadAiResult(name);
  try {
    const { report } = await api(`/api/reports/${encodeURIComponent(name)}`);
    if (detailName !== name || state.activeView !== 'detail') return;
    detailReport = report;
    applyDeepContext(report.deep);
    const m = report.meta || {};
    $('#detail-chips').innerHTML = [
      `模式 ${m.mode || '-'}`,
      `算法 ${report.algorithm === 'devtools' ? 'DevTools 对比式' : 'HeapScope 加权'}`,
      `引擎 ${m.engine || '-'}`,
      m.rnVersion ? `RN ${m.rnVersion}` : null,
      m.bridgeless ? 'bridgeless' : null,
      `目标 ${m.target || '-'}`,
      `符号化 ${m.siteCoverage || '-'}`,
      `${report.totalCandidates} 组候选`,
    ].filter(Boolean).map(t => `<span class="pill">${esc(t)}</span>`).join('');

    const f = report.focus || {};
    const cnt = $('#focus-count');
    if (f.high || f.watch) {
      cnt.hidden = false;
      cnt.innerHTML = `<span class="tag hot">重点关注 ${f.high || 0}</span>${f.watch ? `<span class="tag watch">观察 ${f.watch}</span>` : ''}`;
    } else {
      cnt.hidden = true;
    }
    renderCandRows();

    $('#detail-warnings').innerHTML = (report.warnings || []).slice(0, 6)
      .map(w => `<div class="warn">${esc(w)}</div>`).join('');
  } catch (e) {
    if (detailName === name && state.activeView === 'detail') $('#detail-chips').innerHTML = `<span class="warn">${esc(e.message)}</span>`;
  }
}

$('#f-focus-only').addEventListener('change', renderCandRows);

$('#btn-back').addEventListener('click', () => switchView('reports'));

function toggleCandidate(tr) {
  const x = tr?.nextElementSibling;
  if (!x || !x.classList.contains('xrow')) return;
  x.hidden = !x.hidden;
  tr.classList.toggle('open', !x.hidden);
  tr.setAttribute('aria-expanded', String(!x.hidden));
}
$('#cand-table').addEventListener('click', e => {
  const tr = e.target.closest('tr.crow');
  if (tr) toggleCandidate(tr);
});
$('#cand-table').addEventListener('keydown', e => {
  const tr = e.target.closest('tr.crow');
  if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleCandidate(tr); }
});
$('#btn-delete').addEventListener('click', async () => {
  if (!detailName) return;
  if (!confirm(`删除报告 ${detailName}？该目录下的快照与分析文件会一并移除，不可恢复。`)) return;
  const name = detailName;
  const btn = $('#btn-delete');
  btn.disabled = true;
  try {
    await api(`/api/reports/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (detailName === name && state.activeView === 'detail') switchView('reports');
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; }
});

/* ---------------- boot ---------------- */
(async function boot() {
  const q = new URLSearchParams(location.search);
  if (location.protocol === 'file:') {
    const bar = document.createElement('div');
    bar.className = 'banner';
    bar.innerHTML = '当前是直接打开的本地文件，样式与接口都不可用。请运行 <code>heapscope serve</code>，然后访问 <code>http://127.0.0.1:7788</code>';
    document.body.prepend(bar);
  }
  const initialView = ['start', 'status', 'reports', 'detail'].includes(q.get('view')) ? q.get('view') : 'start';
  switchView(initialView);
  renderModeHelp();
  renderStartControls();
  await loadEnv();
  await loadAiConfig().catch(() => {});
  await loadTargets();
  await loadReports().catch(() => {});
  if (q.get('view') === 'detail' && q.get('report')) openDetail(q.get('report'));
  // resume an in-flight job after page reload
  try {
    const r = await api('/api/jobs');
    const live = (r.jobs || []).find(j => ['queued', 'running', 'waiting'].includes(j.status));
    if (live) {
      const full = await api(`/api/jobs/${live.id}`);
      attachJob(full.job);
      if (!q.get('view') || q.get('view') === 'status') switchView('status');
    }
  } catch { /* no jobs yet */ }
  finally { state.booting = false; renderStartControls(); }
})();
