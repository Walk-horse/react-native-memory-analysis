'use strict';
// Local deep evidence for AI analysis.
//
// When a capture kept its .heapsnapshot files, this module re-opens them on the
// SAME machine, extracts compact structural facts (per-round constructors,
// objects that survived since baseline, exact GC-root retainer chains for the
// report's top candidates) and reads project source around the reported
// positions. The result is a bounded, human-readable prompt section.
//
// Raw snapshots and full source files NEVER leave this process: only the
// excerpts below are sent to the configured model.

const fs = require('node:fs');
const path = require('node:path');
const { HeapSnapshot, summarize, normalizeName } = require('./snapshot');

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|kt|java|m|mm|swift|vue|svelte)$/i;
const SECRET_NAME = /(\.env|secret|credential|private|keystore|keychain|\.p12|\.pem|\.key|id_rsa)/i;
const MAX_FILE_BYTES = 256 * 1024;

const DEFAULTS = {
  deepMaxSnapshots: 4,
  deepMaxCandidates: 8,
  deepMaxSourceFiles: 12,
  deepSourceRadius: 12,
  deepMaxChars: 18000,
  deepMaxSnapshotMB: 400,
};

const clip = (v, n) => {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const int = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};
const optsOf = o => ({
  maxSnapshots: int(o?.maxSnapshots, 1, 20, DEFAULTS.deepMaxSnapshots),
  maxCandidates: int(o?.maxCandidates, 1, 30, DEFAULTS.deepMaxCandidates),
  maxSourceFiles: int(o?.maxSourceFiles, 0, 50, DEFAULTS.deepMaxSourceFiles),
  sourceRadius: int(o?.sourceRadius, 0, 60, DEFAULTS.deepSourceRadius),
  maxChars: int(o?.maxChars, 2000, 60000, DEFAULTS.deepMaxChars),
  maxSnapshotMB: Number(o?.maxSnapshotMB) > 0 ? Number(o.maxSnapshotMB) : DEFAULTS.deepMaxSnapshotMB,
  topGroups: 10,
});

// ---------- snapshot discovery ----------

function discoverSnapshots(reportDir, analysis = {}) {
  const names = new Set();
  for (const f of analysis.snapshotFiles || []) {
    if (typeof f === 'string' && /\.heapsnapshot$/i.test(f)) names.add(path.basename(f));
  }
  try {
    for (const e of fs.readdirSync(reportDir)) if (/\.heapsnapshot$/i.test(e)) names.add(e);
  } catch { /* report dir gone */ }
  const out = [];
  for (const name of names) {
    const file = path.join(reportDir, name);   // basename only: no traversal
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ name, file, bytes: st.size });
    } catch { /* gone */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pickEvenly(files, max) {
  if (files.length <= max) return files;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * (files.length - 1) / (max - 1));
    if (!seen.has(idx)) { seen.add(idx); out.push(files[idx]); }
  }
  return out;
}

// Cheap metadata for the UI: no snapshot is parsed here.
function describeDeep({ analysis, reportDir, project = null, enabled = true } = {}) {
  const a = analysis || {};
  const snapshots = discoverSnapshots(reportDir, a);
  const sites = collectSites(a);
  let root = null;
  try {
    if (project && fs.statSync(project).isDirectory()) root = fs.realpathSync(project);
  } catch { /* not available */ }
  const warnings = [];
  if (!snapshots.length) warnings.push('该报告未保留 .heapsnapshot；重新采集时勾选「保留快照文件」可启用深度分析');
  if (!root) warnings.push('未找到可用的项目路径（serve --project / capture --project），深度分析只含快照证据');
  return {
    enabled: enabled !== false,
    available: snapshots.length > 0,
    snapshots: snapshots.map(s => ({ name: s.name, bytes: s.bytes })),
    snapshotCount: snapshots.length,
    snapshotBytes: snapshots.reduce((n, s) => n + s.bytes, 0),
    project: root,
    siteCount: sites.length,
    warnings,
  };
}

// ---------- snapshot mining ----------

function candidateTargets(analysis, max) {
  const cands = (analysis.candidates || []).map((c, i) => ({ c, i }));
  const rank = x => (x.c.focus === 'high' ? 0 : x.c.focus === 'watch' ? 1 : 2);
  cands.sort((x, y) => rank(x) - rank(y) || (y.c.totalBytes || 0) - (x.c.totalBytes || 0));
  return cands.slice(0, max).map(({ c, i }) => ({
    i: i + 1, type: String(c.type || ''), name: String(c.name || ''),
    key: `${c.type}|${c.name}`,
  }));
}

function matchTargets(snap, targets, baselineIds) {
  const index = new Map();
  for (const t of targets) index.set(t.key, t.i);
  const found = new Map();
  for (const n of snap.nodes) {
    const key = `${n.type}|${normalizeName(n.type, n.name)}`;
    const i = index.get(key);
    if (i == null) continue;
    let m = found.get(i);
    if (!m) { m = { i, count: 0, bytes: 0, largest: null, fresh: null }; found.set(i, m); }
    m.count++;
    m.bytes += n.selfSize;
    const node = { i: n.i, id: n.id, size: n.selfSize, name: clip(n.name, 80) };
    if (!m.largest || node.size > m.largest.size) m.largest = node;
    if (baselineIds && !baselineIds.has(n.id) && (!m.fresh || node.size > m.fresh.size)) m.fresh = node;
  }
  return targets.map(t => found.get(t.i) || { i: t.i, count: 0, bytes: 0, largest: null, fresh: null });
}

function retainerChains(snap, targets, matches) {
  const chains = [];
  for (const t of targets) {
    const m = matches.find(x => x.i === t.i);
    const rep = m?.fresh || m?.largest;
    if (!rep) continue;
    let out = null;
    try {
      const p = snap.retainerPath(rep.i, { maxHops: 10 });
      out = {
        i: t.i, name: clip(t.name, 100), type: t.type,
        count: m.count, bytes: m.bytes,
        representative: { size: rep.size, name: rep.name, freshSinceBaseline: rep === m.fresh },
        holderCount: (snap.inEdges[rep.i] || []).length,
        truncated: !!p?.truncated,
        path: p?.hops ? p.hops.map(h => (h.edge ? `${clip(h.node, 90)} --[${clip(h.edge, 40)}]-->` : clip(h.node, 90))) : [],
      };
    } catch (e) {
      out = { i: t.i, name: clip(t.name, 100), error: clip(e.message, 120) };
    }
    chains.push(out);
  }
  return chains;
}

function topNewGroups(snap, baselineIds, limit = 8) {
  if (!baselineIds) return [];
  const groups = new Map();
  for (const n of snap.nodes) {
    if (baselineIds.has(n.id)) continue;
    const key = `${n.type}|${normalizeName(n.type, n.name)}`;
    let g = groups.get(key);
    if (!g) { g = { type: n.type, name: normalizeName(n.type, n.name), count: 0, bytes: 0 }; groups.set(key, g); }
    g.count++; g.bytes += n.selfSize;
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

async function mineSnapshots(files, analysis, o, onStage, warnings) {
  const targets = candidateTargets(analysis, o.maxCandidates);
  const rounds = [];
  let firstIds = null;
  let chains = [];
  const capBytes = o.maxSnapshotMB * 1024 * 1024;
  for (let idx = 0; idx < files.length; idx++) {
    const entry = files[idx];
    // Yield between files so the HTTP layer can flush SSE progress events and
    // honour a cancellation while a 100MB+ snapshot is being parsed.
    await new Promise(resolve => setImmediate(resolve));
    onStage('snapshot', { index: idx + 1, total: files.length, file: entry.name, bytes: entry.bytes });
    if (entry.bytes > capBytes) {
      warnings.push(`跳过 ${entry.name}：${(entry.bytes / 1048576).toFixed(0)}MB 超过单文件上限 ${o.maxSnapshotMB}MB`);
      continue;
    }
    let snap;
    try {
      snap = new HeapSnapshot(JSON.parse(fs.readFileSync(entry.file, 'utf8')), entry.name);
      const totals = snap.totals();
      const groups = summarize(snap);
      const ids = snap.idSet();
      if (!firstIds) firstIds = ids;
      const matches = matchTargets(snap, targets, firstIds);
      let freshCount = 0;
      if (idx > 0) for (const n of snap.nodes) if (!firstIds.has(n.id)) freshCount++;
      const round = {
        label: entry.name, fileBytes: entry.bytes,
        nodes: totals.nodes, edges: totals.edges, shallowBytes: totals.shallowBytes,
        newSinceBaseline: freshCount,
        topGroups: [...groups.values()].sort((a, b) => b.bytes - a.bytes)
          .slice(0, o.topGroups).map(g => ({ type: g.type, name: clip(g.name, 90), count: g.count, bytes: g.bytes })),
        candidates: matches.map(m => ({ i: m.i, count: m.count, bytes: m.bytes })),
      };
      if (idx === files.length - 1) {
        chains = retainerChains(snap, targets, matches);
        round.topNewGroups = topNewGroups(snap, firstIds);
      }
      rounds.push(round);
    } catch (e) {
      warnings.push(`快照 ${entry.name} 解析失败：${clip(e.message, 160)}`);
    }
  }
  return { rounds, chains, targets, parsed: rounds.length };
}

// ---------- project source ----------

function collectSites(analysis) {
  const sites = [];
  const seen = new Set();
  const add = (d, via, priority) => {
    if (!d || typeof d.file !== 'string' || !/\.(m?js|jsx|tsx?|kt|java|m|mm|swift)(?:$|[?#])/i.test(d.file)) return;
    const line = Number(d.line);
    if (!Number.isSafeInteger(line) || line < 1) return;
    const key = `${d.file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ file: d.file, line, via: clip(via || '源码位置', 40), priority });
  };
  const cands = (analysis.candidates || []).map((c, i) => ({ c, i }));
  cands.sort((x, y) => (x.c.focus === 'high' ? 0 : x.c.focus === 'watch' ? 1 : 2) - (y.c.focus === 'high' ? 0 : y.c.focus === 'watch' ? 1 : 2)
    || (y.c.totalBytes || 0) - (x.c.totalBytes || 0));
  for (const { c, i } of cands.slice(0, 30)) {
    const p = c.focus === 'high' ? 0 : c.focus === 'watch' ? 1 : 2;
    add(c.sourceDetail, `候选${i + 1} 分配/关联位置`, p);
    add(c.allocDetail, `候选${i + 1} 分配点（依赖）`, p + 3);
    for (const e of c.sourceChain || []) add(e, `候选${i + 1} ${e.via || '关联位置'}`, p + 1);
  }
  for (const h of analysis.sampling?.hotspots || []) add(h.sourceDetail, '采样热点', 4);
  return sites.sort((a, b) => a.priority - b.priority);
}

function inside(root, file) {
  return file === root || file.startsWith(root + path.sep);
}

// Sourcemap positions are often absolute paths from a different machine.
// Try the path itself, then progressively shorter path suffixes under root.
function resolveProjectFile(root, raw, warnings) {
  if (!root || !raw) return null;
  let f = raw.split(/[?#]/)[0].replace(/^file:\/\//, '');
  if (/^(https?|script#|webpack|metro)/i.test(f) || /index\.bundle/i.test(f)) return null;
  const parts = f.replace(/\\/g, '/').split('/').filter(Boolean);
  // Every candidate is joined onto root: an absolute path from another machine
  // is only ever used as a path *suffix*, never as a raw filesystem path.
  const tries = [];
  if (path.isAbsolute(f) && inside(root, f)) tries.push(f);
  tries.push(path.resolve(root, f.replace(/^\/+/, '')));
  for (let i = Math.max(0, parts.length - 6); i < parts.length; i++) {
    tries.push(path.resolve(root, parts.slice(i).join(path.sep)));
  }
  for (const t of tries) {
    if (!inside(root, t)) continue;
    let real, st;
    try { real = fs.realpathSync(t); st = fs.statSync(real); } catch { continue; }
    if (!inside(root, real) || !st.isFile()) continue;   // symlink escaping root
    if (!CODE_EXT.test(real) || SECRET_NAME.test(path.basename(real))) {
      warnings.push(`跳过敏感/非源码文件 ${clip(path.basename(real), 60)}`);
      return null;
    }
    if (st.size > MAX_FILE_BYTES) {
      warnings.push(`跳过超大源码文件 ${clip(path.basename(real), 60)}`);
      return null;
    }
    return real;
  }
  return null;
}

function redact(text) {
  const secretLine = /((?:api[_-]?key|access[_-]?key|password|passwd|secret|token|authorization|bearer)\s*[:=]\s*)(['"`])([^'"`\n]{0,200})\2/gi;
  return text
    .replace(secretLine, (m, prefix, q) => `${prefix}${q}***${q}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]');
}

function readPackageInfo(root) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = Object.keys(p.dependencies || {});
    const picked = deps.filter(d => /react|navigation|image|list|flash|fast|hermes|reanimated|gesture|redux|zustand|mobx|storage|async|webview|video|map/i.test(d));
    return {
      name: clip(p.name, 60), version: clip(p.version, 30),
      react: p.dependencies?.react || null, reactNative: p.dependencies?.['react-native'] || null,
      relevantDeps: picked.slice(0, 24),
    };
  } catch { return null; }
}

function collectSources({ analysis, project, o, onStage, warnings }) {
  let root = null;
  try {
    if (project && fs.statSync(project).isDirectory()) root = fs.realpathSync(project);
  } catch { /* no project */ }
  const pkg = root ? readPackageInfo(root) : null;
  if (!root) {
    warnings.push('未找到项目目录，跳过源码上下文（启动服务时用 --project 指定 RN 项目根）');
    return { root, pkg, sources: [], missing: 0 };
  }
  const sites = collectSites(analysis);
  const sources = [];
  let missing = 0;
  const seen = new Set();
  for (const site of sites) {
    if (sources.length >= o.maxSourceFiles) break;
    const file = resolveProjectFile(root, site.file, warnings);
    if (!file) { missing++; continue; }
    const rel = path.relative(root, file).split(path.sep).join('/');
    const key = `${rel}:${site.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const from = Math.max(1, site.line - o.sourceRadius);
      const to = Math.min(lines.length, site.line + o.sourceRadius);
      const snippet = lines.slice(from - 1, to)
        .map((t, k) => `${String(from + k).padStart(5)}  ${clip(redact(t), 240)}`).join('\n');
      sources.push({ file: rel, line: site.line, via: site.via, lines: `${from}-${to}`, totalLines: lines.length, snippet });
    } catch (e) { warnings.push(`读取 ${rel} 失败：${clip(e.message, 100)}`); }
  }
  onStage('sources', { files: sources.length, missing, project: root });
  return { root, pkg, sources, missing };
}

// ---------- prompt rendering / budget ----------

function renderDeep(data) {
  const lines = [
    '# 深度证据（由 HeapScope 在本机解析，原始快照与完整源码未上传）',
    '',
    `数据来源：${data.stats.parsed}/${data.stats.found} 份保留快照、${data.sources.length} 个项目源码片段。`,
    '这些证据可与上面的报告摘要互相印证；若冲突，以原始快照的持有链为准，并说明差异。',
    `项目源码来自当前工作区${data.project ? `「${clip(path.basename(data.project), 60)}」` : '（未指定）'}，可能与采集时的 bundle 不完全一致；路径均相对项目根。`,
    '',
    '## 1. 快照逐轮结构',
    '```json',
    JSON.stringify(data.rounds.map(r => ({
      file: r.label, nodes: r.nodes, edges: r.edges, shallowBytes: r.shallowBytes,
      newSinceBaseline: r.newSinceBaseline,
      topGroups: r.topGroups,
      topNewGroups: r.topNewGroups,
      reportCandidates: r.candidates,
    }))),
    '```',
    '',
    '字段：newSinceBaseline = 相对首轮新增且仍存活的节点 id 数；topGroups = 该轮 self size 最大的构造器分组；reportCandidates 的 i 对应报告候选编号，count/bytes 是该轮精确值。',
    '',
    '## 2. 候选精确持有链（末轮原始快照）',
    '```json',
    JSON.stringify(data.chains),
    '```',
    '',
    'path 从 GC root 指向候选代表节点；freshSinceBaseline=true 表示该对象在首轮不存在。',
    '',
    '## 3. 项目上下文',
    data.pkg ? '```json\n' + JSON.stringify(data.pkg) + '\n```\n' : '',
  ];
  for (const s of data.sources) {
    lines.push(`### ${s.file}:${s.line}（${s.via} · 第 ${s.lines} 行 / 共 ${s.totalLines} 行）`, '```', s.snippet, '```', '');
  }
  if (data.warnings.length) lines.push('## 深度证据采集警告', ...data.warnings.map(w => `- ${w}`), '');
  lines.push('请优先引用深度证据里的轮次编号、候选编号与「文件:行号」，并明确区分哪些判断来自原始快照、哪些只是源码推断。');
  return lines.join('\n');
}

function fit(data, maxChars) {
  let text = renderDeep(data);
  let guard = 0;
  while (text.length > maxChars && guard++ < 30) {
    if (data.sources.length > 1) data.sources.splice(Math.max(1, Math.ceil(data.sources.length * 0.7)));
    else if (data.chains.length > 3) data.chains.splice(Math.max(3, Math.ceil(data.chains.length * 0.7)));
    else if (data.rounds.some(r => r.topGroups.length > 4)) data.rounds.forEach(r => { r.topGroups.splice(4); if (r.topNewGroups) r.topNewGroups.splice(4); });
    else if (data.rounds.length > 2) data.rounds = [data.rounds[0], data.rounds[data.rounds.length - 1]];
    else if (data.sources.length) data.sources = [];
    else break;
    text = renderDeep(data);
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（深度证据已按字符预算截断）';
  return text;
}

/**
 * Build the deep prompt section. Returns null when nothing usable was found.
 * Never throws for missing/corrupt artifacts: failures become warnings.
 */
async function collectDeepEvidence({ analysis, reportDir, project = null, options = {}, onStage = () => {} } = {}) {
  const o = optsOf(options);
  const a = analysis || {};
  const warnings = [];
  const all = discoverSnapshots(reportDir, a);
  if (!all.length) return null;
  const files = pickEvenly(all, o.maxSnapshots);
  if (files.length < all.length) warnings.push(`只采样 ${files.length}/${all.length} 份快照（deepMaxSnapshots=${o.maxSnapshots}），首末轮均包含`);

  onStage('start', { found: all.length, picked: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) });
  const { rounds, chains, parsed } = await mineSnapshots(files, a, o, onStage, warnings);
  if (!parsed) return null;

  await new Promise(resolve => setImmediate(resolve));
  const src = collectSources({ analysis: a, project, o, onStage, warnings });
  if (a.sourceCheck && a.sourceCheck.clean === false) {
    warnings.push(`采集期间项目源码发生过变更：${clip(a.sourceCheck.reason, 160)}；当前源码片段可能与快照不一致`);
  }
  if (src.missing) warnings.push(`${src.missing} 处源码位置未能在项目内定位（可能来自依赖、bundle 或已被改动）`);

  const sourceFilesBeforeFit = src.sources.length;
  const siteCount = collectSites(a).length;
  const data = {
    rounds, chains, sources: src.sources, pkg: src.pkg, project: src.root, warnings,
    stats: { found: all.length, parsed, sourceFiles: sourceFilesBeforeFit, sourceSites: siteCount },
  };
  const text = fit(data, o.maxChars);
  const meta = {
    snapshots: parsed,
    snapshotBytes: files.reduce((n, f) => n + f.bytes, 0),
    snapshotFiles: files.map(f => f.name),
    sourceFiles: data.sources.length,
    sourceSites: siteCount,
    project: src.root,
    chars: text.length,
    truncated: text.includes('已按字符预算截断') || data.sources.length < sourceFilesBeforeFit,
    warnings,
  };
  onStage('done', meta);
  return { text, meta, warnings };
}

module.exports = {
  DEFAULTS, collectDeepEvidence, describeDeep, discoverSnapshots, collectSites,
  renderDeep, fit,
};
