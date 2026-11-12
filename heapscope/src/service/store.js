'use strict';
// Web service state: job registry (in-memory) + report index (scanned from disk).

const fs = require('node:fs');
const path = require('node:path');

const { markFocus } = require('../snapshot');
const { diagnose } = require('../diagnosis');
const { sourceEvidence, validCallStacks } = require('../source-evidence');
const { markdownToHtml } = require('../markdown');
const { describeDeep } = require('../deep-evidence');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const AI_RESULT_FILE = 'ai-analysis.json';

// AI 结论与报告同目录保存：删除报告时一并清掉，单文件 report.html 也能读到。
function aiPath(outDir, name) {
  if (!isSafeName(name)) throw new Error('非法报告名');
  return path.join(outDir, name, AI_RESULT_FILE);
}

function readAiResult(outDir, name) {
  try {
    const r = JSON.parse(fs.readFileSync(aiPath(outDir, name), 'utf8'));
    // 始终从 markdown 重新渲染，不信任落盘的 html 字段（防篡改注入）。
    return r && typeof r.markdown === 'string' ? { ...r, html: markdownToHtml(r.markdown) } : null;
  } catch { return null; }
}

function aiSummary(outDir, name) {
  const r = readAiResult(outDir, name);
  if (!r) return null;
  return {
    status: r.status || 'done', generatedAt: r.generatedAt || null, model: r.model || null,
    usage: r.usage || null, promptChars: r.promptChars || null,
    chars: (r.markdown || '').length,
    deep: r.deep ? {
      snapshots: r.deep.snapshots || 0, sourceFiles: r.deep.sourceFiles || 0,
      chars: r.deep.chars || 0, truncated: !!r.deep.truncated,
    } : null,
  };
}

function saveAiResult(outDir, name, result) {
  const p = aiPath(outDir, name);
  fs.writeFileSync(p, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function deleteAiResult(outDir, name) {
  const p = aiPath(outDir, name);
  const existed = fs.existsSync(p);
  if (existed) fs.rmSync(p);
  return { name, deleted: existed };
}

// 早期报告可能没有 focus 字段，读取时补算一次，让历史报告也能用上标记
function ensureFocus(a) {
  if (!a) return { high: 0, watch: 0, low: 0 };
  const cands = a.candidates || [];
  if (!a.focus || cands.some(c => !c.focus)) a.focus = markFocus(cands);
  return a.focus;
}

function isSafeName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

// A job is the unit the browser drives: start -> rounds -> analyze -> report.
function createJob(params) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    status: 'queued', // queued | running | waiting | done | error | cancelled
    stage: 'queued',
    stageInfo: {},
    params,
    log: [],
    progress: null,
    rounds: [],
    gate: null,
    abort: null,
    result: null,
    error: null,
    elapsedMs: 0,
  };
  return job;
}

function publicJob(job, { logLimit = 300 } = {}) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stageInfo: job.stageInfo,
    resolvedMode: job.resolvedMode || null,
    params: job.params,
    progress: job.progress,
    rounds: job.rounds,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - (job.startedAt || job.createdAt),
    error: job.error,
    result: job.result,
    log: job.log.slice(-logLimit),
    canAct: job.status === 'waiting' && !!job.gate && !job.cancelRequested,
    cancelRequested: !!job.cancelRequested,
    pendingQuit: !!job.pendingQuit,
    gateMode: job.gate?.mode || null,
  };
}

function listReports(outDir) {
  const reports = [];
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return reports; }
  for (const e of entries) {
    if (!e.isDirectory() || !isSafeName(e.name)) continue;
    const dir = path.join(outDir, e.name);
    const jsonPath = path.join(dir, 'analysis.json');
    const htmlPath = path.join(dir, 'report.html');
    if (!fs.existsSync(jsonPath)) continue;
    let stat, a;
    try {
      stat = fs.statSync(jsonPath);
      a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch { continue; }
    const totals = a.totals || [];
    const first = totals[0], last = totals[totals.length - 1];
    reports.push({
      name: e.name,
      generatedAt: a.generatedAt || stat.mtime.toISOString(),
      mtime: stat.mtimeMs,
      hasHtml: fs.existsSync(htmlPath),
      mode: a.meta?.mode || '?',
      target: a.meta?.target || '-',
      engine: a.meta?.engine || '?',
      rnVersion: a.meta?.rnVersion || null,
      rounds: totals.length,
      heapFirst: first?.shallowBytes ?? null,
      heapLast: last?.shallowBytes ?? null,
      heapDelta: first && last ? last.shallowBytes - first.shallowBytes : null,
      candidates: a.candidates?.length || 0,
      totalCandidates: a.totalCandidates || 0,
      warnings: a.warnings?.length || 0,
      siteCoverage: a.meta?.siteCoverage || null,
      snapshots: (a.snapshotFiles || []).filter(f => fs.existsSync(path.join(dir, path.basename(f)))).length,
      ai: aiSummary(outDir, e.name),
      sizeBytes: totals.length ? null : null,
    });
  }
  reports.sort((x, y) => y.mtime - x.mtime);
  return reports;
}

function readReport(outDir, name, { top = 20, project = null, deepEnabled = true } = {}) {
  if (!isSafeName(name)) throw new Error('非法报告名');
  const dir = path.join(outDir, name);
  const jsonPath = path.join(dir, 'analysis.json');
  if (!fs.existsSync(jsonPath)) throw new Error(`报告不存在: ${name}`);
  const a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  ensureFocus(a);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const deep = describeDeep({ analysis: a, reportDir: dir, project: project || a.meta?.project || null, enabled: deepEnabled });
  return {
    name,
    generatedAt: a.generatedAt,
    algorithm: a.algorithm || 'heapscope',
    focus: a.focus || { high: 0, watch: 0, low: 0 },
    meta: a.meta || {},
    totals: (a.totals || []).map(t => ({ label: t.label, shallowBytes: t.shallowBytes, nodes: t.nodeCount })),
    warnings: a.warnings || [],
    candidates: (a.candidates || []).slice(0, top).map(c => ({
      type: c.type, name: c.name, countA: c.countA, countB: c.countB, countC: c.countC,
      totalBytes: c.totalBytes, growth2: c.growth2, globalHolder: c.globalHolder,
      newCount: c.newCount ?? null, deletedCount: c.deletedCount ?? null,
      trend: c.trend || null,
      focus: c.focus || null, focusReason: c.focusReason || null,
      source: c.source, sourceDetail: c.sourceDetail, siteVia: c.siteVia, retainerText: c.retainerText,
      callStacks: validCallStacks(c), sourceChain: c.sourceChain || null, sourceEvidence: sourceEvidence(c), allocDetail: c.allocDetail || null,
      issue: c.issue || diagnose(c),
    })),
    totalCandidates: a.totalCandidates || 0,
    sampling: a.sampling ? { hotspots: (a.sampling.hotspots || []).slice(0, 10) } : null,
    statsSeries: a.statsSeries || [],
    snapshotFiles: (a.snapshotFiles || []).map(f => path.basename(f)),
    files,
    deep,
    ai: readAiResult(outDir, name),
    // report.html 支持从 analysis.json 实时渲染，始终可用
    htmlUrl: `/reports/${encodeURIComponent(name)}/report.html`,
  };
}

// 递归统计目录体积：删除/清理时回报释放量，避免「删了但不知道删了什么」。
function dirUsage(dir) {
  let bytes = 0, files = 0;
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        try { bytes += fs.statSync(p).size; } catch { /* gone */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

// 只有快照/采样但没有 analysis.json 的目录（采集失败、取消、只剩 .partial），
// 不会出现在报告列表里，需要单独暴露出来才能删干净。
function listOrphans(outDir) {
  const orphans = [];
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return orphans; }
  for (const e of entries) {
    if (!e.isDirectory() || !isSafeName(e.name)) continue;
    const dir = path.join(outDir, e.name);
    if (fs.existsSync(path.join(dir, 'analysis.json'))) continue;
    const st = dirUsage(dir);
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch { /* gone */ }
    orphans.push({ name: e.name, bytes: st.bytes, files: st.files, mtime });
  }
  orphans.sort((a, b) => b.mtime - a.mtime);
  return orphans;
}

function deleteReport(outDir, name) {
  if (!isSafeName(name)) throw new Error('非法报告名');
  const dir = path.join(outDir, name);
  if (!fs.existsSync(dir)) throw new Error(`报告不存在: ${name}`);
  const usage = dirUsage(dir);
  fs.rmSync(dir, { recursive: true, force: true });   // 整个记录目录（含快照/sourcemap）
  if (fs.existsSync(dir)) throw new Error(`目录删除失败: ${name}（可能仍被占用）`);
  return { name, freedBytes: usage.bytes, files: usage.files };
}

module.exports = {
  createJob, publicJob, listReports, listOrphans, readReport, deleteReport, isSafeName, ensureFocus,
  readAiResult, aiSummary, saveAiResult, deleteAiResult,
};
