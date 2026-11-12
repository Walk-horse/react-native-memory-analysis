'use strict';
// Turns bundle line/column from a heap snapshot back into .tsx file:line.
//
// Chain: Metro /symbolicate (LogBox endpoint) → fallback to the full dev
// source map served at /index.map, decoded locally. RN 0.81 dev builds often
// echo frames back from /symbolicate, so the fallback is what actually gives
// exact source locations.

const { request } = require('./lib');
const { fetchSourceMap, loadSourceMap, platformFromBundleUrl } = require('./sourcemap');

const DEFAULT_BUNDLE_URL = 'http://localhost:8081/index.bundle?platform=android&dev=true&minify=false';

function normalizeSite(site, bundleUrl, lineBase = 1) {
  if (!site) return null;
  // Hermes closure names often look like "fnName@12:34" - that is a function
  // name, NOT a file. Only accept real URLs/paths; otherwise use the bundle URL.
  const raw = String(site.file || '');
  const looksLikeFile = /^(https?:|file:|\/)|[\\/]/.test(raw) || /\.bundle|\.jsbundle/.test(raw);
  const file = looksLikeFile && !/^script#/.test(raw) ? raw : bundleUrl;
  const line = Number(site.line) || 0;
  const column = Number(site.column) || 0;
  // Metro /symbolicate expects 1-based line, 0-based column.
  return { file, lineNumber: lineBase === 0 ? line + 1 : line, columnNumber: column, methodName: '' };
}

async function symbolicateBatch(metro, frames) {
  const { json } = await request(`${metro}/symbolicate`, {
    method: 'POST', body: { stack: frames }, timeout: 45000,
  });
  if (!json) throw new Error('/symbolicate returned non-JSON');
  const stack = Array.isArray(json) ? json : json.stack;
  if (!Array.isArray(stack)) throw new Error('/symbolicate returned no stack array');
  return stack;
}

async function symbolicate(metro, sites, { bundleUrl = DEFAULT_BUNDLE_URL, lineBase = 1 } = {}) {
  const out = new Map();
  const frames = [];
  const keys = [];
  for (const site of sites) {
    const key = site ? `${site.file}:${site.line}:${site.column}` : '';
    if (!site || out.has(key)) continue;
    const f = normalizeSite(site, bundleUrl, lineBase);
    if (!f) continue;
    keys.push(key);
    frames.push(f);
    out.set(key, null);
  }
  if (!frames.length) return out;

  const chunkSize = 150;
  for (let i = 0; i < frames.length; i += chunkSize) {
    const slice = frames.slice(i, i + chunkSize);
    let resolved;
    try { resolved = await symbolicateBatch(metro, slice); }
    catch (e) {
      for (let j = 0; j < slice.length; j++) out.set(keys[i + j], { raw: slice[j], error: e.message });
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const r = resolved[j] || slice[j];
      out.set(keys[i + j], {
        file: r.file || slice[j].file,
        line: (r.lineNumber != null ? Number(r.lineNumber) + 1 : slice[j].lineNumber),
        column: r.columnNumber ?? slice[j].columnNumber,
        method: r.methodName || '',
        bundle: slice[j].file,
        symbolicator: 'metro /symbolicate',
      });
    }
  }
  return out;
}

function isResolved(sym) {
  return !!sym && !sym.error && !!sym.file && !/index\.bundle|\.jsbundle/.test(String(sym.file));
}

function isUnsymbolicated(map) {
  const vals = [...map.values()].filter(Boolean);
  return vals.length > 0 && !vals.some(isResolved);
}

/**
 * Resolve allocation sites with the /symbolicate → /index.map fallback chain.
 * Returns { map, sourceMap, warnings }.
 */
async function resolveSites({
  metro, sites, bundleUrl = DEFAULT_BUNDLE_URL, lineBase = 1,
  project = null, platform = null, mapFile = null, enableMap = true, saveTo = null,
} = {}) {
  const warnings = [];
  let map = new Map();
  if (metro) {
    try { map = await symbolicate(metro, sites, { bundleUrl, lineBase }); }
    catch (e) { warnings.push(`Metro /symbolicate 失败: ${e.message}`); }
  }

  const unresolved = sites.filter(s => s && !isResolved(map.get(`${s.file}:${s.line}:${s.column}`)));
  let sourceMap = null;
  let smInstance = null;
  if (enableMap && unresolved.length) {
    try {
      const sm = mapFile
        ? loadSourceMap(mapFile, { project })
        : await fetchSourceMap(metro || 'http://127.0.0.1:8081', {
            platform: platform || platformFromBundleUrl(bundleUrl) || 'ios',
            saveTo, project,
          });
      smInstance = sm;
      const fallback = sm.resolve(unresolved, { lineBase });
      let merged = 0;
      for (const [key, sym] of fallback) {
        if (!sym) continue;
        map.set(key, sym);
        merged++;
      }
      sourceMap = {
        label: sm.label,
        generatedLines: sm.generatedLines,
        sources: sm.sources.length,
        hasSourcesContent: sm.contents.some(Boolean),
        attempted: unresolved.length,
        resolved: merged,
      };
      if (!merged && unresolved.length) warnings.push(`dev source map 未能匹配任何分配点（${sm.generatedLines} generated lines）；可能 bundle 与快照不同版本，请在同一 Metro 会话内重新采集`);
    } catch (e) {
      warnings.push(`dev source map 不可用: ${e.message}；报告仅显示 index.bundle 行号`);
    }
  }
  const stillRaw = sites.filter(s => s && !isResolved(map.get(`${s.file}:${s.line}:${s.column}`))).length;
  if (stillRaw && !sourceMap?.resolved) {
    warnings.push('源码级符号化不可用：报告显示 index.bundle 行号。可在 Chrome DevTools 打开同批 .heapsnapshot 复核，或用 --sourcemap 指定 .map 文件');
  }
  return { map, sourceMap, sm: smInstance, warnings, unresolvedCount: stillRaw };
}

// A resolved source file counts as "business" when it lives inside the project
// root and is not a dependency or a static asset. Used to prefer the app's own
// code when a leak candidate has several associated positions.
const NON_CODE_ASSET = /\.(svg|png|jpe?g|gif|webp|bmp|ico|json|css|scss|less|ttf|otf|woff2?|mp4|mp3|lottie)$/i;

function isBusinessFile(file, project) {
  const s = String(file || '');
  if (!s || s === '__prelude__' || /node_modules/i.test(s) || NON_CODE_ASSET.test(s)) return false;
  if (project) {
    const rel = require('node:path').relative(project, s);
    if (!rel || rel.startsWith('..') || require('node:path').isAbsolute(rel)) return false;
  }
  return true;
}

function pretty(sym, site) {
  if (isResolved(sym)) {
    const f = sym.shortFile || String(sym.file).replace(/^.*[/\\](?=[^/\\]+$)/, '');
    return `${f}:${sym.line}${sym.method ? ` (${sym.method})` : ''}`;
  }
  if (sym && sym.file && !sym.error) {
    return `index.bundle:${sym.line}${sym.method ? ` (${sym.method})` : ''}`;
  }
  if (site) {
    const f = String(site.file || '');
    if (/^script#/.test(f)) return `index.bundle:${site.line}:${site.column}`;
    return `${f}:${site.line}:${site.column}`;
  }
  return '-';
}

function detail(sym) {
  if (!isResolved(sym)) return null;
  return {
    file: sym.file, shortFile: sym.shortFile, line: sym.line, column: sym.column,
    method: sym.method || '', sourceLine: sym.sourceLine || '',
    snippet: sym.snippet || [], symbolicator: sym.symbolicator || '',
  };
}

module.exports = {
  symbolicate, resolveSites, pretty, detail, isUnsymbolicated, isResolved,
  isBusinessFile, DEFAULT_BUNDLE_URL,
};
