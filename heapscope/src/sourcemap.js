'use strict';
// Metro dev source map (source map v3) resolver.
//
// RN 0.81's Metro /symbolicate echoes dev-bundle frames back unchanged, but
// the /index.map endpoint serves the full source map (with sourcesContent).
// Hermes heapsnapshot locations (script_id/line/column) refer to generated
// bundle coordinates, so decoding the map gives us exact .tsx file + line.
//
// Zero third-party deps. Mappings are scanned as a char stream (not split),
// because a MallApp dev map is ~25MB of mappings / 749k generated lines.

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./lib');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) VLQ[B64.charCodeAt(i)] = i;

function decodeSegment(m, from, to) {
  const vals = [];
  let v = 0, shift = 0, i = from;
  while (i < to) {
    const d = VLQ[m.charCodeAt(i++)];
    if (d == null || d < 0) return null;  // invalid char, skip whole segment
    v |= (d & 31) << shift;
    shift += 5;
    if (!(d & 32)) {
      vals.push(v & 1 ? -(v >> 1) : v >> 1);
      v = 0; shift = 0;
    }
  }
  return vals;
}

function shorten(file, project) {
  const f = String(file || '');
  if (project) {
    const rel = path.relative(project, f);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  const nm = f.lastIndexOf('node_modules/');
  if (nm >= 0) return f.slice(nm);
  const parts = f.split(/[/\\]/).filter(Boolean);
  return parts.slice(-3).join('/') || f || '(unknown)';
}

function readSourceLines(content, project, file, line0, radius = 2) {
  let text = content;
  if (text == null && file && fs.existsSync(file)) {
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  }
  if (!text) return null;
  const all = text.split('\n');
  if (line0 < 0 || line0 >= all.length) return null;
  const out = [];
  for (let n = Math.max(0, line0 - radius); n <= Math.min(all.length - 1, line0 + radius); n++) {
    out.push({ n: n + 1, text: all[n].replace(/\t/g, '  ').slice(0, 200), hit: n === line0 });
  }
  return out;
}

class SourceMap {
  constructor(json, { label = 'source map', project = null } = {}) {
    if (!json || typeof json.mappings !== 'string' || !Array.isArray(json.sources)) {
      throw new Error('invalid source map v3 (need mappings + sources)');
    }
    this.sources = json.sources;
    this.names = json.names || [];
    this.contents = json.sourcesContent || [];
    this.mappings = json.mappings;
    this.label = label;
    this.project = project;
    this._lines = null;
  }

  get generatedLines() {
    if (this._lines == null) {
      let n = 1;
      for (let i = 0; i < this.mappings.length; i++) if (this.mappings.charCodeAt(i) === 59) n++;
      this._lines = n;
    }
    return this._lines;
  }

  // sites: [{file, line, column}] where line follows `lineBase` (1 => 1-based).
  // Returns Map<`${file}:${line}:${column}`, resolvedSymbol|null>.
  resolve(sites, { lineBase = 1 } = {}) {
    const out = new Map();
    const byLine = new Map();
    for (const s of sites) {
      if (!s) continue;
      const key = `${s.file}:${s.line}:${s.column}`;
      if (out.has(key)) continue;
      out.set(key, null);
      // Hermes location columns are 0-based; source map lines are 1-based.
      const gl = (Number(s.line) || 0) + (lineBase === 0 ? 1 : 0);
      const gc = Number(s.column) || 0;
      if (gl < 1) continue;
      if (!byLine.has(gl)) byLine.set(gl, []);
      byLine.get(gl).push({ col: gc, key, site: s });
    }
    if (!byLine.size) return out;

    let maxLine = 0;
    for (const n of byLine.keys()) if (n > maxLine) maxLine = n;
    const m = this.mappings;
    let line = 1, genCol = 0, src = 0, origLine = 0, origCol = 0, name = 0;
    let segStart = 0;
    let lastState = null, lastMappedLine = -99;

    const self = this;
    function emit(key, state, genLine, genColumn, named) {
      const file = self.sources[state.src] || '(unknown)';
      const lines = readSourceLines(self.contents[state.src], self.project, file, state.origLine);
      out.set(key, {
        file,
        shortFile: shorten(file, self.project),
        line: state.origLine + 1,
        column: state.origCol + 1,
        method: named ? (self.names[state.name] || '') : '',
        snippet: lines,
        sourceLine: lines ? (lines.find(x => x.hit)?.text || '') : '',
        symbolicator: 'metro /index.map',
        generated: { line: genLine, column: genColumn },
      });
    }
    function state() { return { src, origLine, origCol, name }; }

    // Source-map semantics: a generated line with no segment of its own
    // inherits the last mapping from a preceding line. Hermes locations are
    // occasionally off by one line, so allow a small look-back.
    function seedLine(n) {
      const targets = byLine.get(n);
      if (!targets || !lastState || n - lastMappedLine > 3) return;
      for (const t of targets) emit(t.key, lastState, n, 0, true);
    }
    seedLine(1);

    for (let i = 0; i <= m.length && line <= maxLine; i++) {
      const cc = i < m.length ? m.charCodeAt(i) : 59; // treat EOF as line end
      if (cc !== 44 && cc !== 59) continue;           // ',' | ';'
      if (i > segStart) {
        const f = decodeSegment(m, segStart, i);
        if (f && f.length) {
          genCol += f[0];
          if (f.length >= 4) {
            src += f[1]; origLine += f[2]; origCol += f[3];
            if (f.length >= 5) name += f[4];
            lastState = state();
            lastMappedLine = line;
            const targets = byLine.get(line);
            if (targets) {
              for (const t of targets) {
                if (genCol > t.col) continue;
                emit(t.key, lastState, line, genCol, f.length >= 5);
              }
            }
          }
        }
      }
      segStart = i + 1;
      if (cc === 59) { line++; genCol = 0; seedLine(line); }
    }
    return out;
  }
}

async function fetchSourceMap(metro, { platform = 'ios', dev = true, minify = false, timeout = 60000, saveTo = null, project = null } = {}) {
  const url = `${metro}/index.map?platform=${encodeURIComponent(platform)}&dev=${dev}&minify=${minify}`;
  const { text } = await request(url, { timeout });
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`/index.map 返回非 JSON（前 120 字符: ${text.slice(0, 120)}）`); }
  // Keep an exact copy next to the snapshots: Metro re-generates maps on every
  // Fast Refresh, so offline re-analysis later needs the map from THIS run.
  if (saveTo && text) {
    try { fs.writeFileSync(saveTo, text); } catch { /* cache is best-effort */ }
  }
  return new SourceMap(json, { label: url, project });
}

function loadSourceMap(file, { project = null } = {}) {
  const p = path.resolve(file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new SourceMap(json, { label: p, project });
}

function platformFromBundleUrl(url) {
  const m = /[?&]platform=([^&]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

module.exports = { SourceMap, fetchSourceMap, loadSourceMap, shorten, platformFromBundleUrl };
