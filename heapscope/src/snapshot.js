'use strict';
// V8/Hermes .heapsnapshot reader. Field layout is read from snapshot.meta,
// NOT hardcoded - Hermes changes node_fields between RN releases.

const { fmtBytes } = require('./lib');

const WEAK_EDGE = 'weak';

class HeapSnapshot {
  constructor(json, label = 'snapshot') {
    if (!json || !json.snapshot || !json.snapshot.meta) throw new Error(`invalid heapsnapshot (${label}): missing snapshot.meta`);
    this.label = label;
    this.meta = json.snapshot.meta;
    this.strings = json.strings || [];
    this.nodeFields = this.meta.node_fields || [];
    this.edgeFields = this.meta.edge_fields || [];
    this.locationFields = this.meta.location_fields || [];
    this.nodeTypes = (this.meta.node_types || [])[0] || [];
    this.edgeTypes = (this.meta.edge_types || [])[0] || [];
    this.nStride = this.nodeFields.length;
    this.eStride = this.edgeFields.length;
    this.lStride = this.locationFields.length;
    this.nodesFlat = json.nodes || [];
    this.edgesFlat = json.edges || [];
    this.locationsFlat = json.locations || [];
    this.nodeCount = json.snapshot.node_count != null ? json.snapshot.node_count : Math.floor(this.nodesFlat.length / this.nStride);
    this.edgeCount = json.snapshot.edge_count != null ? json.snapshot.edge_count : Math.floor(this.edgesFlat.length / this.eStride);
    this._nf = Object.fromEntries(this.nodeFields.map((f, i) => [f, i]));
    this._ef = Object.fromEntries(this.edgeFields.map((f, i) => [f, i]));
    this._lf = Object.fromEntries(this.locationFields.map((f, i) => [f, i]));
    this._nodes = null;
    this._inEdges = null;
    this._roots = null;
    this._locations = null;
  }

  _need(field, kind) {
    const map = kind === 'node' ? this._nf : kind === 'edge' ? this._ef : this._lf;
    if (map[field] == null) return null;
    return map[field];
  }

  get nodes() {
    if (this._nodes) return this._nodes;
    const arr = new Array(this.nodeCount);
    const iType = this._need('type', 'node'), iName = this._need('name', 'node');
    const iId = this._need('id', 'node'), iSize = this._need('self_size', 'node');
    const iEc = this._need('edge_count', 'node');
    let edgeCursor = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const o = i * this.nStride;
      const typeIdx = iType != null ? this.nodesFlat[o + iType] : 0;
      const nameIdx = iName != null ? this.nodesFlat[o + iName] : 0;
      const ec = iEc != null ? this.nodesFlat[o + iEc] : 0;
      arr[i] = {
        i,
        type: this.nodeTypes[typeIdx] || `type#${typeIdx}`,
        name: this.strings[nameIdx] != null ? String(this.strings[nameIdx]) : String(nameIdx ?? ''),
        id: iId != null ? this.nodesFlat[o + iId] : i,
        selfSize: iSize != null ? Number(this.nodesFlat[o + iSize]) || 0 : 0,
        edgeCount: ec,
        edgesStart: edgeCursor,
      };
      edgeCursor += ec;
    }
    this._nodes = arr;
    return arr;
  }

  edgeAt(k) {
    const o = k * this.eStride;
    const iType = this._need('type', 'edge'), iName = this._need('name_or_index', 'edge');
    const iTo = this._need('to_node', 'edge');
    if (iTo == null) return null;
    const typeIdx = iType != null ? this.edgesFlat[o + iType] : 0;
    const type = this.edgeTypes[typeIdx] || `edge#${typeIdx}`;
    const rawName = iName != null ? this.edgesFlat[o + iName] : 0;
    const name = (type === 'element' || type === 'hidden') ? `[${rawName}]` : (this.strings[rawName] != null ? String(this.strings[rawName]) : '');
    const toFlat = Number(this.edgesFlat[o + iTo]) || 0;
    return { type, name, to: this.nStride ? Math.floor(toFlat / this.nStride) : 0 };
  }

  *edgesOf(nodeIndex) {
    const n = this.nodes[nodeIndex];
    if (!n || !n.edgeCount) return;
    for (let k = 0; k < n.edgeCount; k++) {
      const e = this.edgeAt(n.edgesStart + k);
      if (e) yield e;
    }
  }

  // locations: object_index is an offset into the flat nodes array.
  get locations() {
    if (this._locations) return this._locations;
    const m = new Map();
    const iObj = this._need('object_index', 'loc');
    const iScript = this._need('script_id', 'loc');
    const iLine = this._need('line', 'loc');
    const iCol = this._need('column', 'loc');
    if (iObj != null && this.lStride) {
      for (let p = 0; p + this.lStride <= this.locationsFlat.length; p += this.lStride) {
        const nodeIdx = Math.floor((Number(this.locationsFlat[p + iObj]) || 0) / (this.nStride || 1));
        m.set(nodeIdx, {
          scriptId: iScript != null ? this.locationsFlat[p + iScript] : null,
          line: iLine != null ? this.locationsFlat[p + iLine] : null,
          column: iCol != null ? this.locationsFlat[p + iCol] : null,
        });
      }
    }
    this._locations = m;
    return m;
  }

  idSet() {
    const s = new Set();
    for (const n of this.nodes) s.add(n.id);
    return s;
  }

  totals() {
    let bytes = 0;
    for (const n of this.nodes) bytes += n.selfSize;
    return { nodes: this.nodes.length, edges: this.edgeCount, shallowBytes: bytes };
  }

  // Hermes embeds the real device bundle URL in strings (host is the device-
  // reachable IP, NOT 127.0.0.1). Prefer it over a guessed --bundle-url.
  bundleUrls() {
    const out = new Set();
    const re = /https?:\/\/[^\s"'()]*index\.bundle[^\s"'()]*/g;
    for (const s of this.strings) {
      if (typeof s !== 'string' || s.length > 4000) continue;
      let m;
      while ((m = re.exec(s)) !== null) {
        const u = m[0].replace(/:\d+:\d+.*$/, '').replace(/[),;]+$/, '');
        if (u) out.add(u);
      }
      re.lastIndex = 0;
    }
    return [...out];
  }

  get inEdges() {
    if (this._inEdges) return this._inEdges;
    const inEdges = new Array(this.nodeCount);
    for (let from = 0; from < this.nodeCount; from++) {
      for (const e of this.edgesOf(from)) {
        if (e.type === WEAK_EDGE) continue; // weak edges do not retain
        if (e.to < 0 || e.to >= this.nodeCount) continue;
        (inEdges[e.to] || (inEdges[e.to] = [])).push({ from, name: e.name, type: e.type });
      }
    }
    this._inEdges = inEdges;
    return inEdges;
  }

  get rootSet() {
    if (this._roots) return this._roots;
    const roots = new Set();
    const ie = this.inEdges;
    for (let i = 0; i < this.nodeCount; i++) {
      const n = this.nodes[i];
      const isSyntheticRoot = n.type === 'synthetic' && /root/i.test(n.name);
      if (!ie[i] || ie[i].length === 0 || isSyntheticRoot || n.id === 1) roots.add(i);
    }
    if (!roots.size) roots.add(0);
    this._roots = roots;
    return roots;
  }

  // Shortest strong-reference chain from a GC root down to the target.
  retainerPath(target, { maxHops = 12 } = {}) {
    if (target == null || target < 0 || target >= this.nodeCount) return null;
    const ie = this.inEdges;
    const rootSet = this.rootSet;
    const parent = new Map(); // holderIndex -> { next, edge }
    const seen = new Set([target]);
    const queue = [target];
    let qi = 0, found = null;
    while (qi < queue.length && qi < 200000) {
      const cur = queue[qi++];
      if (rootSet.has(cur)) { found = cur; break; }
      for (const e of ie[cur] || []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        parent.set(e.from, { next: cur, edge: e });
        queue.push(e.from);
      }
    }
    if (found == null) return { truncated: true, hops: [], hopIndices: [], reason: 'no root reachable (cycle or weak-only holders)' };
    const chain = [];
    let cur = found;
    while (cur !== target && chain.length < maxHops + 2) {
      const step = parent.get(cur);
      if (!step) break;
      const n = this.nodes[cur];
      chain.push({ node: `${n.name || n.type} (${n.type})`, edge: step.edge.name || step.edge.type, i: cur });
      cur = step.next;
    }
    const targetNode = this.nodes[target];
    chain.push({ node: `${targetNode.name || targetNode.type} (${targetNode.type})`, edge: '', i: target });
    return { truncated: chain.length > maxHops, hops: chain.slice(0, maxHops + 1), hopIndices: chain.slice(0, maxHops + 1).map(h => h.i) };
  }
}

// ---------- grouping ----------

function normalizeName(type, name) {
  if (type === 'string' || /string/i.test(type)) {
    const len = String(name).length;
    const bucket = len < 32 ? '0-31' : len < 128 ? '32-127' : len < 1024 ? '128-1023' : len < 8192 ? '1K-8K' : '8K+';
    return `<string len:${bucket}>`;
  }
  let s = String(name)
    // Collapse allocation-site suffixes so closures from the same function
    // group together (Chrome DevTools groups by constructor, not by line).
    .replace(/@\d+:\d+$/, '@SITE')
    .replace(/:\d+:\d+$/, ':SITE')
    .replace(/0x[0-9a-f]+/gi, '@ADDR')
    .replace(/(?:@|:)\d{5,}/g, '@OFFSET')
    .replace(/\b\d{5,}\b/g, '#');
  if (s.length > 96) s = s.slice(0, 96) + '...';
  return s || '(anonymous)';
}

// A "file:line:col" suffix on a heap node name is only a real allocation site
// if the file part looks like a file/URL/function name. Date/time strings
// ("2026-09-22 23:59:59") and log payloads otherwise produce bogus sites.
function validSiteFile(f) {
  if (!f || /\s/.test(f) || /^\d{4}-\d{2}-\d{2}/.test(f)) return false;
  if (/^(https?:|file:|script#|\/)/.test(f)) return true;
  if (/\.(bundle|jsbundle|js|jsx|ts|tsx|mjs|cjs)(?:[?#].*)?$/i.test(f)) return true;
  return /^[A-Za-z_$][\w$./-]{0,120}$/.test(f);
}

function makeSite(s) {
  if (!validSiteFile(s[1])) return null;
  const line = Number(s[2]), column = Number(s[3]);
  if (!Number.isFinite(line) || line < 0 || line > 5e6 || !Number.isFinite(column) || column > 5e6) return null;
  return { file: s[1], line, column };
}

// Hermes sometimes encodes allocation site directly in a closure/object name.
function parseSiteFromName(name) {
  const s = String(name);
  let m = s.match(/^(.*?):(\d+):(\d+)$/);
  if (m) return makeSite(m);
  m = s.match(/^(.*?)@(\d+):(\d+)$/);
  if (m) return makeSite(m);
  m = s.match(/^at\s+.*\((https?:\/\/[^)]+):(\d+):(\d+)\)$/);
  if (m) return makeSite(m);
  return null;
}

function locToSite(loc) {
  return { file: `script#${loc.scriptId}`, line: loc.line, column: loc.column };
}

// Hermes only records a debug location for ~15-20% of heap nodes. For the
// rest, a 1-hop neighbour (a property value, or the object holding it) often
// has one. Marked "associated" so it is never mistaken for the allocation site.
function associateSite(snap, nodeIndex) {
  const locs = snap.locations;
  const own = locs.get(nodeIndex);
  if (own && own.line != null) return { site: locToSite(own), via: 'allocation' };
  for (const e of snap.edgesOf(nodeIndex)) {
    const loc = locs.get(e.to);
    if (loc && loc.line != null) return { site: locToSite(loc), via: `property ${e.name || e.type}` };
  }
  for (const e of snap.inEdges[nodeIndex] || []) {
    const loc = locs.get(e.from);
    if (loc && loc.line != null) return { site: locToSite(loc), via: 'holder' };
  }
  return null;
}

function siteKey(site) {
  if (!site) return '';
  return `${site.file}:${site.line}:${site.column}`;
}

// Collect every code position reachable around a set of nodes: own allocation
// site, property values, holders (1-2 hops) and retainer-chain nodes. Used to
// give leak candidates a code location even when the object itself has none.
// Each hint carries `via` so callers can label it as associated, never as the
// allocation site.
function collectSiteHints(snap, nodeIndices, { maxHints = 10 } = {}) {
  const locs = snap.locations;
  const out = [];
  const seen = new Set();
  const push = (site, via, nodeIdx) => {
    if (!site || site.line == null || out.length >= maxHints) return;
    const k = siteKey(site);
    if (seen.has(k)) return;
    seen.add(k);
    const n = nodeIdx != null ? snap.nodes[nodeIdx] : null;
    out.push({ site, via, node: n ? String(n.name || n.type).slice(0, 60) : '' });
  };
  for (const idx of nodeIndices) {
    if (idx == null || idx < 0) continue;
    const own = locs.get(idx);
    if (own && own.line != null) push(locToSite(own), '对象自身', idx);
    if (out.length >= maxHints) break;
    let props = 0;
    for (const e of snap.edgesOf(idx)) {
      if (e.type === WEAK_EDGE) continue;
      const loc = locs.get(e.to);
      if (loc && loc.line != null) { push(locToSite(loc), `属性值 ${e.name || e.type}`, e.to); if (++props >= 3) break; }
    }
    let holders = 0;
    for (const e of snap.inEdges[idx] || []) {
      const loc = locs.get(e.from);
      if (loc && loc.line != null) { push(locToSite(loc), '持有者', e.from); if (++holders >= 3) break; }
    }
    // 2nd hop up the holder chain — often a closure created at a business line.
    if (out.length < maxHints) {
      for (const e of (snap.inEdges[idx] || []).slice(0, 3)) {
        for (const e2 of (snap.inEdges[e.from] || []).slice(0, 3)) {
          const loc = locs.get(e2.from);
          if (loc && loc.line != null) push(locToSite(loc), '持有链', e2.from);
          if (out.length >= maxHints) break;
        }
        if (out.length >= maxHints) break;
      }
    }
    if (out.length >= maxHints) break;
  }
  return out;
}

function summarize(snap) {
  const groups = new Map();
  const locs = snap.locations;
  for (const n of snap.nodes) {
    const loc = locs.get(n.i);
    const site = parseSiteFromName(n.name) || (loc && loc.line != null
      ? { file: `script#${loc.scriptId}`, line: loc.line, column: loc.column }
      : null);
    const key = `${n.type}|${normalizeName(n.type, n.name)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, type: n.type, name: normalizeName(n.type, n.name), site,
        count: 0, bytes: 0, samples: [], nodes: [],
      };
      groups.set(key, g);
    }
    if (!g.site && site) g.site = site;
    g.count++;
    g.bytes += n.selfSize;
    if (g.samples.length < 4 && n.type !== 'string' && n.name) g.samples.push(String(n.name).slice(0, 100));
    if (g.nodes.length < 6) g.nodes.push({ i: n.i, id: n.id, size: n.selfSize });
    // keep the largest node as retainer representative
    if (!g._rep || n.selfSize > g._rep.size) g._rep = { i: n.i, id: n.id, size: n.selfSize };
  }
  return groups;
}

function scoreOf(a, b, c) {
  const ca = a ? a.count : 0, cb = b ? b.count : 0, cc = c ? c.count : cb;
  const ba = a ? a.bytes : 0, bb = b ? b.bytes : 0, bc = c ? c.bytes : bb;
  const g1c = cb - ca, g2c = c ? cc - cb : 0;
  const g1b = bb - ba, g2b = c ? bc - bb : 0;
  const totalBytes = bc - ba;
  if (totalBytes <= 0 && g2b <= 0) return null;
  let score = Math.max(1, totalBytes);
  // Monotonically growing across a repeated scenario is the classic leak signal.
  if (c) {
    if (g1b > 0 && g2b > 0) score *= 2.2;
    else if (g1b > 0 && g2b === 0) score *= 1.1;
    else score *= 0.55; // one-off growth / noise
  }
  if (ca === 0 && cc > 0) score *= 1.35; // brand new objects surviving every round
  if (/closure|array|object|FiberNode|listener|subscription/i.test(b?.type || '')) score *= 1.1;
  return {
    score, countA: ca, countB: cb, countC: c ? cc : null,
    bytesA: ba, bytesB: bb, bytesC: c ? bc : null,
    growth1: g1b, growth2: c ? g2b : null,
    totalBytes, totalCount: (c ? cc : cb) - ca,
  };
}

// Shared retainer/symbolication hint attachment for the top candidates.
// boost=true (HeapScope): global holders raise the score. boost=false
// (DevTools mode): the flag is display-only, ranking stays pure size delta.
function attachRetainers(snaps, top, { boost = true } = {}) {
  if (!top.length) return;
  const baselineIds = snaps[0].snap.idSet();
  const last = snaps[snaps.length - 1].snap;
  const sums = snaps.map(s => s.summary || summarize(s.snap));
  for (const cand of top) {
    const g = sums[sums.length - 1].get(cand.key);
    let rep = g && (g._rep || g.nodes[g.nodes.length - 1]);
    if (g) {
      const fresh = (g.nodes || []).find(n => !baselineIds.has(n.id));
      if (fresh) rep = fresh;
    }
    if (rep) {
      const path = last.retainerPath(rep.i);
      cand.retainer = path;
      cand.retainerText = path && path.hops
        ? path.hops.map(h => h.edge ? `${h.node} --[${h.edge}]--> ` : h.node).join('')
        : '';
      // global / timer / subscription holders are much more suspicious
      if (/global|native|window|timer|interval|timeout|listener|subscription|emitter|bridge|__react|fiber|root/i.test(cand.retainerText)) {
        if (boost) cand.score *= 1.4;
        cand.globalHolder = true;
      }
      // Every code position reachable around this group: sample nodes,
      // retainer chain, neighbours. Symbolication picks the business one.
      const hintNodes = new Set([rep.i]);
      for (const n of g.nodes || []) hintNodes.add(n.i);
      for (const i of (path && path.hopIndices) || []) hintNodes.add(i);
      cand.siteHints = collectSiteHints(last, [...hintNodes], { maxHints: 10 });
    }
    if (!cand.site && rep && cand.siteHints && cand.siteHints.length) {
      const h = cand.siteHints[0];
      cand.site = h.site;
      cand.siteVia = `${h.via}（关联位置）`;
    }
  }
  if (boost) top.sort((x, y) => y.score - x.score);
}

// Chrome DevTools Comparison semantics: constructor grouping, pairwise
// comparison of the first vs the last snapshot, #New / #Deleted / Size Delta,
// ranked purely by size delta. No monotonic scoring, no holder weighting.
function devtoolsDiff(snaps, { topN = 30, withRetainers = true }) {
  const a0 = snaps[0].snap, b0 = snaps[snaps.length - 1].snap;
  const aIds = a0.idSet(), bIds = b0.idSet();
  // Per-snapshot constructor counts so the report can show A→B→C→D even though
  // the DevTools-style score is still a first/last pairwise delta.
  const sums = snaps.map(s => s.summary || summarize(s.snap));
  const locs = b0.locations;
  const groups = new Map();
  const ensure = (key, type, name) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, type, name, site: null, countA: 0, countB: 0, bytesA: 0, bytesB: 0, newCount: 0, deletedCount: 0, samples: [], rep: null };
      groups.set(key, g);
    }
    return g;
  };
  const siteOf = (snap, n) => {
    const loc = snap.locations.get(n.i);
    return parseSiteFromName(n.name) || (loc && loc.line != null
      ? { file: `script#${loc.scriptId}`, line: loc.line, column: loc.column }
      : null);
  };
  for (const n of a0.nodes) {
    const name = normalizeName(n.type, n.name);
    const g = ensure(`${n.type}|${name}`, n.type, name);
    g.countA++; g.bytesA += n.selfSize;
    if (!bIds.has(n.id)) g.deletedCount++;
    if (!g.site) g.site = siteOf(a0, n);
  }
  for (const n of b0.nodes) {
    const name = normalizeName(n.type, n.name);
    const g = ensure(`${n.type}|${name}`, n.type, name);
    g.countB++; g.bytesB += n.selfSize;
    if (!aIds.has(n.id)) g.newCount++;
    if (!g.site) g.site = siteOf(b0, n);
    if (n.type !== 'string' && n.name) {
      if (!g.samples.length || g.samples.length < 4) g.samples.push(String(n.name).slice(0, 100));
    }
    if (!g.rep || n.selfSize > g.rep.size) g.rep = { i: n.i, id: n.id, size: n.selfSize };
  }
  const candidates = [];
  for (const g of groups.values()) {
    const deltaBytes = g.bytesB - g.bytesA;
    const deltaCount = g.countB - g.countA;
    if (deltaBytes <= 0 && deltaCount <= 0) continue; // shrink/release: not leak material
    candidates.push({
      key: g.key, type: g.type, name: g.name, site: g.site, samples: g.samples,
      score: Math.max(1, deltaBytes),
      countA: g.countA, countB: g.countB, countC: null,
      bytesA: g.bytesA, bytesB: g.bytesB, bytesC: null,
      growth1: deltaBytes, growth2: null,
      totalBytes: deltaBytes, totalCount: deltaCount,
      newCount: g.newCount, deletedCount: g.deletedCount,
      trend: sums.map(m => (m.get(g.key)?.count || 0)),
      trendBytes: sums.map(m => (m.get(g.key)?.bytes || 0)),
    });
  }
  candidates.sort((x, y) => y.score - x.score);
  const top = candidates.slice(0, topN);
  if (withRetainers) attachRetainers(snaps, top, { boost: false });
  return {
    candidates: top,
    totalCandidates: candidates.length,
    totals: snaps.map(s => ({ label: s.label, ...s.snap.totals() })),
  };
}

function diffSnapshots(snaps, { topN = 30, withRetainers = true, algorithm = 'heapscope' } = {}) {
  if (snaps.length < 2) throw new Error('diff needs at least 2 snapshots');
  if (algorithm === 'devtools') return devtoolsDiff(snaps, { topN, withRetainers });
  const sums = snaps.map(s => s.summary || summarize(s.snap));
  const keys = new Set();
  for (const m of sums) for (const k of m.keys()) keys.add(k);
  const baselineIds = snaps[0].snap.idSet();
  const last = snaps[snaps.length - 1].snap;
  const candidates = [];
  for (const key of keys) {
    const a = sums[0].get(key), b = sums[snaps.length > 2 ? snaps.length - 2 : 1].get(key);
    // In 3-snapshot mode a group vanishing from the last snapshot is a RELEASE,
    // not a leak. Pass an explicit zero group so scoreOf does not treat it as a 2-snapshot run.
    const c = snaps.length > 2
      ? (sums[sums.length - 1].get(key) || { count: 0, bytes: 0, type: b?.type || a?.type, name: b?.name || a?.name, samples: [], nodes: [] })
      : null;
    const stats = scoreOf(a, b, c || undefined);
    if (!stats || stats.score <= 0) continue;
    if (snaps.length > 3) {
      // scoreOf applies a three-point multiplier; replace it with one that
      // accounts for every interval, including regressions in middle rounds.
      const previousMultiplier = stats.growth1 > 0 && stats.growth2 > 0 ? 2.2
        : stats.growth1 > 0 && stats.growth2 === 0 ? 1.1 : 0.55;
      const bytes = sums.map(m => m.get(key)?.bytes || 0);
      const deltas = bytes.slice(1).map((v, i) => v - bytes[i]);
      const multiplier = deltas.every(d => d > 0) ? 2.2
        : deltas.some(d => d > 0) && deltas.every(d => d >= 0) ? 1.1 : 0.55;
      stats.score = stats.score / previousMultiplier * multiplier;
    }
    const g = (c && c.count ? c : b || a);
    if (!g) continue;
    candidates.push({
      key, type: g.type, name: g.name, site: g.site || b?.site || a?.site || null,
      samples: g.samples || [], ...stats,
      trend: sums.map(m => (m.get(key)?.count || 0)),
      trendBytes: sums.map(m => (m.get(key)?.bytes || 0)),
    });
  }
  candidates.sort((x, y) => y.score - x.score);
  const top = candidates.slice(0, topN);
  if (withRetainers) attachRetainers(snaps, top, { boost: true });
  return {
    candidates: top,
    totalCandidates: candidates.length,
    totals: snaps.map(s => ({ label: s.label, ...s.snap.totals() })),
  };
}

// ---------- sampling heap profile (fallback for large heaps) ----------

function analyzeSamplingProfile(profile, { topN = 30 } = {}) {
  if (!profile || !profile.head) throw new Error('empty sampling heap profile');
  const m = new Map();
  // Keep paths from the sampling tree separate from snapshot retainer paths.
  const pending = [{ node: profile.head, frames: [] }];
  while (pending.length) {
    const { node, frames } = pending.pop();
    if (!node) continue;
    const cf = node.callFrame || {};
    const frame = { functionName: cf.functionName || '(anonymous)', url: cf.url || '', line: cf.lineNumber ?? 0, column: cf.columnNumber ?? 0 };
    const path = node === profile.head && frame.functionName === '(root)' ? frames : [...frames, frame];
    const key = `${frame.functionName}|${frame.url}|${frame.line}|${frame.column}`;
    const g = m.get(key) || { ...frame, selfSize: 0, hits: 0, callStacks: [] };
    const size = Number(node.selfSize) || 0;
    g.selfSize += size;
    g.hits += (node.samples || []).length || 0;
    if (path.length >= 2 && size > 0) {
      const pathKey = JSON.stringify(path);
      const existing = g.callStacks.find(stack => JSON.stringify(stack.frames) === pathKey);
      if (existing) existing.selfSize += size;
      else if (g.callStacks.length < 5) g.callStacks.push({ provenance: 'sampling', frames: path, selfSize: size });
      else {
        const smallest = g.callStacks.reduce((min, stack, i, arr) => stack.selfSize < arr[min].selfSize ? i : min, 0);
        if (size > g.callStacks[smallest].selfSize) g.callStacks[smallest] = { provenance: 'sampling', frames: path, selfSize: size };
      }
    }
    m.set(key, g);
    for (const child of node.children || []) pending.push({ node: child, frames: path });
  }
  const list = [...m.values()].sort((a, b) => b.selfSize - a.selfSize);
  const total = list.reduce((s, x) => s + x.selfSize, 0) || 1;
  return {
    totalAllocatedBytes: total,
    hotspots: list.slice(0, topN).map(x => ({ ...x, pct: (x.selfSize / total) * 100, human: fmtBytes(x.selfSize) })),
  };
}

// ---------- 重点关注标记 ----------
// 快照里大量候选是引擎内部对象（无分配点）或 dev 专属开销，人工逐条判断成本很高。
// 这里按「有没有真实分配点 + 增量够不够大 + 逐轮是否单调」三件事打分，
// 只把值得动手查的标成 high，其余降级为 watch / low 并给出原因。
const ENGINE_TYPES = new Set(['HiddenClass', 'CodeBlock', 'DictPropertyMap', 'PropertyAccessor', 'DescriptorArray']);
const ENGINE_NAME = /^(HiddenClass|CodeBlock|DictPropertyMap|PropertyAccessor|DescriptorArray|Code|ScopeInfo|FeedbackVector|JSWeakRef|ManagedChunkedList)$/;
const INTERNAL_TYPES = new Set(['native', 'code', 'synthetic', 'hidden']);
const DEV_ONLY_FILE = /react-refresh|deepFreezeAndThrowOnMutationInDev|ReactFabric-dev\.js|react\.development\.js|LogBox/;
const FOCUS_MIN_BYTES = 64 * 1024; // 重点关注：单组增量至少 64KB
const WATCH_MIN_BYTES = 16 * 1024; // 观察：至少 16KB

function markFocus(cands = []) {
  const summary = { high: 0, watch: 0, low: 0 };
  for (const c of cands) {
    const t = c.trend || [];
    const d1 = t.length > 1 ? t[1] - t[0] : 0;
    const deltas = t.slice(1).map((n, i) => n - t[i]);
    const d2 = t.length > 2 ? deltas[deltas.length - 1] : null;
    const rel = t.length > 1 ? (t[t.length - 1] - t[0]) / Math.max(1, t[0]) : 0;
    const linear = d2 != null && d1 > 0 && deltas.every(d => d > 0) && d2 / d1 >= 0.7 && rel >= 0.02;
    const plateau = d2 != null && d1 > 0 && deltas.every(d => d >= 0) && d2 / d1 <= 0.35;
    const file = (c.sourceDetail && c.sourceDetail.file) || '';
    const allocFile = (c.allocDetail && c.allocDetail.file) || '';
    const noSite = !c.sourceDetail || /^script#/.test(file);
    const associated = !!(c.siteVia && !/^allocation$/.test(c.siteVia));
    const engine = ENGINE_TYPES.has(c.type) || ENGINE_NAME.test(c.name || '') || INTERNAL_TYPES.has(c.type);
    const primitive = c.type === 'string' || c.type === 'number' || /^<string|^<number/.test(c.name || '');
    const devOnly = DEV_ONLY_FILE.test(file) || DEV_ONLY_FILE.test(allocFile);
    const bytes = c.totalBytes || 0;
    const big = bytes >= FOCUS_MIN_BYTES;
    const mid = bytes >= WATCH_MIN_BYTES;

    let level = 'low';
    let reason = '';
    if (engine) {
      reason = '引擎内部 / native 对象（HiddenClass、CodeBlock、chunk 等），快照无分配点';
    } else if (noSite) {
      reason = '无源码位置，只能看 GC root 持有链';
    } else if (devOnly) {
      reason = 'dev 专属开销（release 包不存在）';
    } else if (!mid) {
      reason = `增量小（${fmtBytes(bytes)}），不足以判定`;
    } else if (primitive) {
      level = big && linear ? 'watch' : 'low';
      reason = `字符串/数字没有可靠分配点（+${fmtBytes(bytes)}${linear ? '，逐轮线性' : ''}），仅作参考`;
    } else if (big && linear) {
      level = 'high';
      reason = `真实分配点 · 逐轮线性增长 +${fmtBytes(bytes)}${associated ? '（位置为关联，非分配点）' : ''}`;
      if (c.globalHolder) reason += ' · 全局持有';
    } else if (big && c.globalHolder) {
      level = 'high';
      reason = `真实分配点 · 全局持有者 +${fmtBytes(bytes)}`;
    } else if (big && plateau) {
      level = 'watch';
      reason = `增量 +${fmtBytes(bytes)} 但末轮已趋平，疑似一次性预热`;
    } else if (big && d2 == null) {
      level = 'watch';
      reason = `增量 +${fmtBytes(bytes)}，仅 2 份快照无法判定单调性`;
    } else if (mid && linear) {
      level = 'watch';
      reason = `逐轮线性 +${fmtBytes(bytes)}，但总量不足 64KB，暂列观察`;
    } else if (big) {
      level = 'watch';
      reason = `增量 +${fmtBytes(bytes)}，趋势放缓需更多轮次确认`;
    } else {
      reason = `增量小（${fmtBytes(bytes)}）且趋势不支持，忽略`;
    }
    c.focus = level;
    c.focusReason = reason;
    summary[level]++;
  }
  return summary;
}

module.exports = {
  HeapSnapshot, summarize, diffSnapshots, analyzeSamplingProfile, markFocus,
  normalizeName, parseSiteFromName, associateSite, collectSiteHints, siteKey,
};
