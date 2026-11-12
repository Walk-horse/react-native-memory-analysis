'use strict';
// Shared analysis pipeline: connect -> capture rounds -> symbolicate -> render.
// Both the CLI (bin/heapscope.js) and the web service (src/service) drive this
// module, so there is exactly one implementation of the capture flow.

const fs = require('node:fs');
const path = require('node:path');

const { now, sleep, DEFAULT_METRO, metroList, CDP, ensureRuntime, probeCapabilities } = require('./lib');
const { HeapSnapshot, summarize, diffSnapshots, analyzeSamplingProfile, markFocus } = require('./snapshot');
const { resolveSites, pretty, detail, isBusinessFile, DEFAULT_BUNDLE_URL } = require('./symbolicate');
const { render } = require('./report');
const { validateOptions } = require('./config');
const { diagnose } = require('./diagnosis');

function detectRnVersion(project) {
  if (!project) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    const v = pkg.dependencies?.['react-native'] || pkg.devDependencies?.['react-native'];
    if (v) return v.replace(/^[\^~]/, '');
    const rnPkg = JSON.parse(fs.readFileSync(path.join(project, 'node_modules/react-native/package.json'), 'utf8'));
    return rnPkg.version || null;
  } catch { return null; }
}

function pickTarget(list, sel) {
  if (!list.length) throw new Error('no inspectable targets. Is Metro running and the dev app connected?');
  if (!sel) {
    if (list.length === 1) return list[0];
    throw new Error(`multiple targets (${list.length}); pass --target <id|index|title>`);
  }
  const s = String(sel);
  const t = list.find(x => x.id === s) || list[Number(s)] || list.find(x => `${x.title} ${x.description} ${x.deviceName}`.toLowerCase().includes(s.toLowerCase()));
  if (!t) throw new Error(`target not found: ${s}`);
  return t;
}

async function connectTarget(a, { probe = true, runGc = false, log = () => {}, warn = () => {} } = {}) {
  const metro = String(a.metro || DEFAULT_METRO).replace(/\/$/, '');
  const list = await metroList(metro);
  const target = pickTarget(list, a.target);
  log(`target ${target.title || target.id} · ${target.wsUrl}`);
  const cdp = await CDP.connect(target.wsUrl, { timeout: 15000 });
  const init = await ensureRuntime(cdp);
  if (!init['Debugger.enable']?.ok || !init['Runtime.enable']?.ok) {
    warn(`inspector 初始化部分失败: ${JSON.stringify(init)}`);
  }
  let cap = null;
  if (probe) {
    cap = await probeCapabilities(cdp, { runGc });
    log(`engine=${cap.runtime?.engine || '?'} bridgeless=${cap.runtime?.bridgeless || false} snapshot=${cap.supports.snapshots} sampling=${cap.supports.sampling} stats=${cap.supports.stats}`);
  }
  return { metro, target, cdp, cap };
}

// Never switch devices just because only one target remains. On reload the
// target id can change, but a replacement must still be unambiguous and must
// not contradict the previous device or page identity.
function matchTarget(list = [], prev = null) {
  if (!list.length) return null;
  if (!prev) return list.length === 1 ? list[0] : null;
  if (prev.id) {
    const exact = list.filter(x => x.id === prev.id);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  const key = s => String(s || '').trim().toLowerCase();
  const title = key(prev.title), device = key(prev.deviceName);
  if (!title && !device) return null;
  const candidates = list.filter(x => {
    const t = key(x.title), d = key(x.deviceName);
    if (title && t && title !== t) return false;
    if (device && d && device !== d) return false;
    return (title && t === title) || (device && d === device);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// 断连后重连：等待 Metro 重新注册设备，并按设备身份重新解析 target。
async function reconnectTarget(a = {}, { probe = true, log = () => {}, warn = () => {}, isCancelled = () => false } = {}) {
  const metro = String(a.metro || DEFAULT_METRO).replace(/\/$/, '');
  const prev = a.prev || null;
  const attempts = Math.max(1, Number(a.attempts) || 5);
  const delayMs = Math.max(0, Number(a.delayMs ?? 800));
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    if (isCancelled()) throw new Error('已手动取消');
    let list = [];
    try { list = await metroList(metro); }
    catch (e) { lastError = new Error(`Metro 不可达（${metro}）：${e.message}`); }

    if (list.length) {
      const target = matchTarget(list, prev);
      if (target) {
        if (target.id !== prev?.id) log(`目标 id 已变化（${prev?.id || '-'} → ${target.id}），按设备重新解析`);
        try {
          const r = await connectTarget({ metro, target: target.id }, { probe, log, warn });
          if (isCancelled()) { r.cdp.close(); throw new Error('已手动取消'); }
          if (i > 1) log(`重连成功（第 ${i} 次尝试）`);
          return r;
        } catch (e) { lastError = e; }
      } else if (!prev) {
        lastError = new Error(`未指定可用的目标，而 Metro 上有 ${list.length} 个设备（${list.map(t => t.title || t.id).join(' / ')}）；请刷新设备列表后重新选择`);
      } else {
        lastError = new Error(`无法唯一匹配原设备 ${prev.title || prev.id || '未知'}${prev.deviceName ? ` · ${prev.deviceName}` : ''}；Metro 当前目标：${list.map(t => `${t.title || t.id}${t.deviceName ? ` · ${t.deviceName}` : ''}`).join(' / ')}。请刷新设备列表重新选择`);
      }
    } else if (!lastError) {
      lastError = new Error('Metro /json/list 为空：App 可能已回到后台或 inspector 未注册');
    }

    if (i < attempts) {
      log(`重连第 ${i}/${attempts} 次失败：${lastError?.message || '未知错误'}；${delayMs}ms 后重试`);
      // Keep the cancel action responsive while waiting for the device to re-register.
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        if (isCancelled()) throw new Error('已手动取消');
        await sleep(Math.min(200, until - Date.now()));
      }
    }
  }
  if (isCancelled()) throw new Error('已手动取消');
  throw lastError || new Error('重连失败');
}

function loadSnapshots(files) {
  return files.map((f, i) => {
    const json = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { label: path.basename(f, path.extname(f)) || `S${i}`, file: f, snap: new HeapSnapshot(json, f), summary: null };
  }).map(s => ({ ...s, summary: summarize(s.snap) }));
}

async function runAnalysis({
  snapFiles = [], profileFiles = [], statsSeries = [], allocTracking = null,
  meta = {}, warnings = [], sourceCheck = null, metro = null,
  symbolication = true, bundleUrl, lineBase = 1, top = 30, out,
  project = null, platform = null, mapFile = null, enableMap = true, saveMap = false,
  writeHtml = true, algorithm = 'devtools',
  log = () => {},
}) {
  validateOptions({ top, algorithm, lineBase, platform });
  const snaps = loadSnapshots(snapFiles);
  let diff = null;
  if (snaps.length >= 2) {
    diff = diffSnapshots(snaps, { topN: top, withRetainers: true, algorithm });
    if (algorithm === 'devtools' && snaps.length > 2) {
      warnings.push(`devtools 算法按首末两份快照对比（本次 ${snaps.length} 份，取第 1 与第 ${snaps.length} 份）；中间轮次用于展示趋势`);
    }
  } else if (snaps.length === 1) {
    warnings.push('只有 1 份快照，无法做差分；仅输出概览。');
  }

  let sampling = null;
  for (const pf of profileFiles) {
    try {
      const r = analyzeSamplingProfile(JSON.parse(fs.readFileSync(pf, 'utf8')), { topN: top });
      sampling = r;
    } catch (e) { warnings.push(`sampling profile 解析失败 ${pf}: ${e.message}`); }
  }

  // Symbolicate candidate sites (allocation + associated hints).
  if (symbolication && (metro || enableMap) && (snaps.length >= 2 || sampling)) {
    const sites = [];
    for (const c of diff?.candidates || []) {
      if (c.site) sites.push(c.site);
      for (const h of c.siteHints || []) sites.push(h.site);
    }
    for (const h of sampling?.hotspots || []) {
      if (h.url) sites.push({ file: h.url, line: h.line + 1, column: h.column });
      for (const stack of h.callStacks || []) for (const frame of stack.frames) {
        if (frame.url) sites.push({ file: frame.url, line: frame.line + 1, column: frame.column });
      }
    }
    try {
      // Hermes snapshots carry the real device bundle URL in strings.
      const detected = snaps[0] ? snaps[0].snap.bundleUrls() : [];
      const effectiveBundle = bundleUrl
        || detected.find(u => /runModule=true/.test(u))
        || detected[0] || DEFAULT_BUNDLE_URL;
      meta.bundleUrl = effectiveBundle;
      const resolved = await resolveSites({
        metro: metro || (enableMap && !mapFile ? 'http://127.0.0.1:8081' : null),
        sites, bundleUrl: effectiveBundle, lineBase, project,
        platform: platform || undefined,
        mapFile: mapFile || undefined,
        enableMap,
        saveTo: saveMap ? path.join(out, 'sourcemap.json') : null,
      });
      warnings.push(...resolved.warnings);
      if (resolved.sourceMap) {
        meta.symbolication = resolved.sourceMap.attempted
          ? `${resolved.sourceMap.resolved}/${resolved.sourceMap.attempted} 站点 · Metro /index.map`
          : `Metro /index.map · ${resolved.sourceMap.sources} sources`;
        log(`源码级符号化 ${resolved.sourceMap.resolved}/${resolved.sourceMap.attempted} · ${resolved.sourceMap.sources} sources · ${resolved.sourceMap.generatedLines} bundle lines`);
      }
      for (const c of diff?.candidates || []) {
        const originalSiteVia = c.siteVia;
        const sym = c.site ? resolved.map.get(`${c.site.file}:${c.site.line}:${c.site.column}`) : null;
        c.source = c.site ? pretty(sym, c.site) : '-';
        c.sourceDetail = detail(sym);
        // The allocation site itself resolved to a node package — remember it
        // so the report can still show it even when a business association
        // takes over as the primary location (or when nothing business-side
        // can be found at all).
        if (c.sourceDetail && !isBusinessFile(c.sourceDetail.file, project)) {
          c.allocSource = c.source;
          c.allocDetail = c.sourceDetail;
        }
        // Prefer a business-code position among the associated hints (retainer
        // chain, holders, property values). Always labelled as associated so it
        // is never mistaken for the allocation site. Works without --project:
        // isBusinessFile already excludes node_modules / assets on its own.
        const primaryIsBiz = c.sourceDetail && isBusinessFile(c.sourceDetail.file, project);
        if ((!c.sourceDetail || !primaryIsBiz) && (c.siteHints || []).length) {
          let best = null, firstResolved = null;
          for (const h of c.siteHints) {
            const hs = resolved.map.get(`${h.site.file}:${h.site.line}:${h.site.column}`);
            if (!hs) continue;
            if (!firstResolved) firstResolved = { h, hs };
            if (isBusinessFile(hs.file, project)) { best = { h, hs }; break; }
          }
          // No business hint anywhere: fall back to the first resolvable
          // position (often a node package) instead of showing nothing — but
          // only when the allocation site itself has no resolved location.
          const pick = best || (!c.sourceDetail && firstResolved);
          if (pick) {
            c.source = pretty(pick.hs, null);
            c.sourceDetail = detail(pick.hs);
            c.siteVia = `${pick.h.via}${pick.h.node ? ` · ${pick.h.node}` : ''}（关联位置）`;
          }
        }
        if (c.siteVia === 'allocation') c.siteVia = null;
        // These locations are separate pieces of evidence found around sampled
        // nodes. They are not an ordered call stack or a single retainer path.
        const chain = [];
        const chainSeen = new Set();
        const addChain = (via, sym) => {
          const d = detail(sym);
          if (!d) return;
          const k = `${d.file}:${d.line}:${d.column ?? ""}:${via}`;
          if (chainSeen.has(k)) return;
          chainSeen.add(k);
          chain.push({
            via, file: d.file, shortFile: d.shortFile || d.file, line: d.line,
            column: d.column ?? null, columnBase: d.symbolicator === 'metro /index.map' ? 1 : null,
            method: d.method || '', sourceLine: d.sourceLine || '',
            snippet: d.snippet || [], symbolicator: d.symbolicator || '',
            business: isBusinessFile(d.file, project),
          });
        };
        if (c.site) addChain(originalSiteVia && /关联位置/.test(originalSiteVia) ? originalSiteVia : '快照记录位置（不一定是分配点）', sym);
        for (const h of c.siteHints || []) {
          const hs = resolved.map.get(`${h.site.file}:${h.site.line}:${h.site.column}`);
          if (hs) addChain(`${h.via}${h.node ? ` · ${h.node}` : ''}`, hs);
        }
        if (chain.length) c.sourceChain = chain;
      }
      for (const h of sampling?.hotspots || []) {
        const k = `${h.url}:${h.line + 1}:${h.column}`;
        const sym = resolved.map.get(k);
        h.source = pretty(sym, null);
        h.sourceDetail = detail(sym);
        for (const stack of h.callStacks || []) for (const frame of stack.frames) {
          const resolvedFrame = resolved.map.get(`${frame.url}:${frame.line + 1}:${frame.column}`);
          if (resolvedFrame) { frame.source = pretty(resolvedFrame, null); frame.sourceDetail = detail(resolvedFrame); }
        }
      }
      const withSource = (diff?.candidates || []).filter(c => c.sourceDetail).length;
      if (diff?.candidates?.length) {
        meta.siteCoverage = `${withSource}/${diff.candidates.length}`;
        if (withSource < diff.candidates.length) {
          warnings.push(`${diff.candidates.length - withSource} 个候选无源码位置：Hermes 仅为部分对象记录 debug location（string / array / native 常缺失）。这类对象请看「GC root 持有链」，并在 Chrome DevTools 打开同批 .heapsnapshot 查 Retainers`);
        }
      }
    } catch (e) { warnings.push(`符号化跳过: ${e.message}`); }
  }

  // 标记「重点关注」：符号化之后才知道有没有真实分配点、是业务还是依赖
  const focus = markFocus(diff?.candidates || []);
  for (const c of diff?.candidates || []) c.issue = diagnose(c);

  const analysis = {
    generatedAt: now(),
    meta, warnings, sourceCheck,
    algorithm,
    focus,
    totals: diff ? diff.totals : snaps.map(s => ({ label: s.label, ...s.snap.totals() })),
    totalCandidates: diff?.totalCandidates || 0,
    candidates: diff?.candidates || [],
    sampling, statsSeries, allocTracking,
    snapshotFiles: snapFiles, profileFiles,
  };
  fs.mkdirSync(out, { recursive: true });
  const jsonPath = path.join(out, 'analysis.json');
  const htmlPath = path.join(out, 'report.html');
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2));
  if (writeHtml) fs.writeFileSync(htmlPath, render(analysis));
  return { analysis, jsonPath, htmlPath };
}

module.exports = { detectRnVersion, pickTarget, matchTarget, connectTarget, reconnectTarget, loadSnapshots, runAnalysis };
