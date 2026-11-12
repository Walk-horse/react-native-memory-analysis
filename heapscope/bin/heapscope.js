#!/usr/bin/env node
'use strict';
// HeapScope CLI - zero-instrumentation JS heap leak analysis for RN 0.81+.

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_METRO, now, fmtBytes, sleep, stampMinute,
  metroList, metroVersion, metroStatus, CDP, probeCapabilities, ensureRuntime,
} = require('../src/lib');
const { takeHeapSnapshot, installProbe, probeAlive } = require('../src/capture');
const { diffSnapshots, parseSiteFromName } = require('../src/snapshot');
const { isBusinessFile } = require('../src/symbolicate');
const watchman = require('../src/watchman');
const { makeFixture, makeSamplingProfile } = require('../src/fixture');
const { SourceMap } = require('../src/sourcemap');
const { detectRnVersion, pickTarget, connectTarget, loadSnapshots, runAnalysis } = require('../src/pipeline');
const { runCaptureJob } = require('../src/job');
const { validateOptions } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' };
const say = (...a) => console.log(...a);
const warn = (...a) => console.error(`${C.y}!${C.x}`, ...a);
const fail = m => { console.error(`${C.r}x${C.x}`, m); process.exitCode = 1; };

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) { a[t.slice(2, eq)] = t.slice(eq + 1); continue; }
      const k = t.slice(2);
      if (k.startsWith('no-')) { a[k.slice(3)] = false; continue; }
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) { a[k] = next; i++; }
      else a[k] = true;
    } else if (t.startsWith('-') && t.length > 1) a[t.slice(1)] = true;
    else a._.push(t);
  }
  return a;
}

const HELP = `HeapScope · RN 0.81+ JS 堆泄漏分析（不改 App 源码）

用法: node heapscope/bin/heapscope.js <command> [options]

命令
  devices                 列出 Metro inspector 上的可调试设备/页面
  capabilities            探测引擎与 CDP 能力（Hermes / GC / snapshot / sampling）
  capture                 采集多轮堆快照并出报告（核心命令）
  serve                   启动 Web 服务（开始分析 / 状态 / 报告，浏览器操作）
  analyze <a> <b> [...]   离线分析已有 .heapsnapshot（至少 2 个文件）
  probe --install|--check  WeakRef 存活探针（验证某个对象是否被回收）
  selftest                用合成快照 + 假 CDP 跑通全链路
  ai-config               查看 / 修改 AI 配置（支持多个模型，密钥只显示掩码）
  ai-test                 测试 AI 接口连通性（--model 指定测试某个模型）
  ai-analyze <报告名>      用 AI 分析已有报告并保存结论（--model 指定模型，保留快照时自动深度分析）

AI 选项
  --ai-config FILE        AI 配置文件路径，默认 <out>/ai-config.json
  --base-url URL          OpenAI 兼容 Base URL（如 https://api.openai.com/v1）
  --api-key KEY           API Key（只写本地配置文件）
  --model NAME            模型名
  --provider ID           服务商预设：openai/deepseek/moonshot/dashscope/ollama/custom
  --max-candidates N      送进 prompt 的候选条数，默认 15
  --max-tokens N          生成上限，默认 2048
  --temperature N         默认 0.2
  --timeout SEC           空闲超时秒数（连续无数据才计时），默认 120
  --total-timeout MIN     单次分析总时长上限分钟数，0 = 不限，默认 30
  --clear-key             删除已保存的 API Key
  --enable / --disable    启用 / 停用 AI 分析
  --note TEXT             ai-analyze 的补充关注点
  --project PATH          RN 项目根；深度分析读取源码片段用（默认取报告 meta.project）
  --deep / --no-deep      单次强制开启 / 关闭深度分析（默认跟随 AI 配置）
  --deep-snapshots N      深度分析最多解析几份快照，默认 4
  --deep-candidates N     深挖前 N 个候选的精确持有链，默认 8
  --deep-files N          最多读取几个源码片段，默认 12
  --deep-radius N         每个片段的上下文行数（前后各 N 行），默认 12
  --deep-chars N          深度证据字符上限，默认 18000
  --deep-mb N             单份快照大小上限 MB，超过则跳过，默认 400
  环境变量 HEAPSCOPE_AI_BASE_URL / HEAPSCOPE_AI_API_KEY / HEAPSCOPE_AI_MODEL /
  HEAPSCOPE_AI_TIMEOUT_MS / HEAPSCOPE_AI_TOTAL_TIMEOUT_MS / HEAPSCOPE_AI_CONFIG 优先级最高

serve 选项
  --port N                监听端口，默认 7788
  --host ADDR             监听地址，默认 127.0.0.1（局域网共享用 0.0.0.0）
  --out DIR               报告与快照根目录，默认 ./out
  --metro URL             默认 Metro 地址
  --project PATH          默认 RN 项目路径
  --ai-config FILE        AI 配置文件路径，默认 <out>/ai-config.json

capture 选项
  --metro URL             Metro 地址，默认 ${DEFAULT_METRO}
  --target ID             目标 id / 序号 / 标题片段；多设备时必填
  --steps N               轮次数，默认 3（baseline + 2 次场景复现）
  --mode MODE             snapshot | sampling | auto（默认 auto）
  --interval SEC          每轮自动等待秒数；不填则每轮按回车
  --project PATH          RN 项目根，用于 watchman 源码指纹 + 读 RN 版本
  --out DIR               输出目录，默认 ./out
  --max-snapshot-mb N     单快照预警阈值，默认 160（iOS/RN0.81.5 实测 140MB 通过）
  --timeout MS            快照超时，默认 180000
  --sampling-interval N   samplingHeapProfiler 采样间隔字节，默认 65536
  --sampling-seconds N    降级后自动采样时长，默认 15
  --bundle-url URL        /symbolicate 用的 bundle URL（默认从快照自动提取）
  --sourcemap FILE        本地 Metro /index.map（离线复盘历史快照时用）
  --no-sourcemap          禁用 /index.map 回退，只保留 bundle 行号
  --no-save-sourcemap     capture 时不把 dev source map 存进 out/sourcemap.json
  --platform ios|android  拉 /index.map 用的平台，默认按 bundle URL 推断
  --project PATH          源码根；同时用于判定「业务侧代码」（项目内且非 node_modules）
  --line-base 0|1         快照里行号基准，默认 1
  --no-symbolicate        跳过全部符号化
  --no-gc                 每轮不主动触发 GC
  --no-track-alloc        关闭 HeapProfiler allocation tracking（默认开启）
  --keep-snaps            分析成功后保留 .heapsnapshot / sampling / sourcemap（默认自动清理，只留 analysis.json + report.html）
  --algorithm NAME        分析算法：devtools（默认，构造器分组 + 首末对比 #New/#Deleted/SizeΔ）| heapscope（多轮单调增长加权）
  --top N                 报告候选条数，默认 30

离线分析选项
  --metro URL             /symbolicate + /index.map 地址（可选，默认 127.0.0.1:8081）
  --sourcemap FILE        用某次采集保存的 out/sourcemap.json 精确复盘
  --out DIR / --top N / --no-symbolicate / --bundle-url / --line-base / --project

真机前置
  adb reverse tcp:8081 tcp:8081   # Android 真机
  Metro 运行中 + App 为 dev build + DevTools 已能连上
  curl http://127.0.0.1:8081/json/list   # 应能看到目标

业务/依赖判定
  --project 必填：项目内且非 node_modules/静态资源的源码行标为「业务」。
  泄漏候选表会优先选业务侧位置；找不到时回退到依赖或持有链位置（明确标注「关联位置」）。

示例
  heapscope devices
  heapscope capture --project /path/to/MallApp --steps 3
  heapscope analyze out/snap-A.heapsnapshot out/snap-B.heapsnapshot out/snap-C.heapsnapshot \\
      --sourcemap out/sourcemap.json --project /path/to/MallApp

安装 / 分发
  本机直接跑   node /path/to/heapscope/bin/heapscope.js ...
  全局命令     npm install -g ./heapscope-<ver>.tgz   (或 npm link)
  打成 tarball npm pack                          → 产物在 out/
  嵌入工具     require('heapscope').resolveSites  / .SourceMap / .takeHeapSnapshot
`;

function outDir(a) {
  const d = path.resolve(String(a.out || path.join(ROOT, 'out')));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function printSummary(analysis) {
  const t = analysis.totals;
  if (t.length >= 2) say(`  堆 ${fmtBytes(t[0].shallowBytes)} → ${fmtBytes(t[t.length - 1].shallowBytes)} (${t.length} 轮)`);
  say(`  泄漏候选 ${analysis.candidates.length} / ${analysis.totalCandidates} 组`);
  for (const [i, c] of analysis.candidates.slice(0, 8).entries()) {
    say(`  ${String(i + 1).padStart(2)}. ${c.globalHolder ? C.y + '★' + C.x : ' '} ${c.type} ${c.name.slice(0, 44).padEnd(44)} +${fmtBytes(c.totalBytes).padStart(10)}  ${c.countA}→${c.countB}${c.countC != null ? `→${c.countC}` : ''}`);
    if (c.retainerText) say(`      ${C.d}${c.retainerText.slice(0, 150)}${C.x}`);
  }
}

// ---------------- commands ----------------

async function cmdDevices(a) {
  const metro = String(a.metro || DEFAULT_METRO).replace(/\/$/, '');
  const [list, ver] = await Promise.all([metroList(metro), metroVersion(metro)]);
  say(`Metro ${metro} · ${ver?.Browser || 'unknown'} · protocol ${ver?.['Protocol-Version'] || '?'}`);
  if (!list.length) { warn('/json/list 为空。检查 adb reverse、Metro 是否运行、App 是否 dev build。'); return; }
  say(`发现 ${list.length} 个目标:`);
  list.forEach((t, i) => say(`  [${i}] id=${t.id || '-'}  ${t.title || ''}  ${t.description || ''}\n      ${t.wsUrl || '(no ws url)'}`));
  say(`\n${C.d}adb 状态:${C.x}`);
  const status = await metroStatus(metro);
  if (status) say(`  ${status.slice(0, 120)}`);
}

async function cmdCapabilities(a) {
  const { cdp, cap } = await connectTarget(a, { runGc: !!a.gc });
  say(JSON.stringify(cap, null, 2));
  if (cap.errors.length) warn(`探测异常: ${cap.errors.join('; ')}`);
  cdp.close();
}

function waitEnter(msg) {
  return new Promise(resolve => {
    process.stdout.write(`${C.b}>${C.x} ${msg} ${C.d}[按回车继续 / q+回车结束]${C.x} `);
    if (!process.stdin.isTTY) { process.stdout.write('\n'); return setTimeout(() => resolve('next'), 3000); }
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const done = data => {
      process.stdin.pause();
      process.stdin.removeListener('data', done);
      resolve(String(data || '').trim().toLowerCase() === 'q' ? 'quit' : 'next');
    };
    process.stdin.once('data', done);
  });
}

async function cmdCapture(a) {
  // 未指定 --out 时，一次采集落到独立目录 analysis-YYYYMMDDHHmm，便于按记录整目录删除。
  const out = a.out ? outDir(a) : path.join(outDir(a), `analysis-${stampMinute()}`);
  const project = a.project ? path.resolve(String(a.project)) : null;
  const steps = Number(a.steps ?? 3);
  const intervalSec = Number(a.interval ?? 0);
  const interactive = !intervalSec;

  const strip = line => line.replace(/^\d\d:\d\d:\d\d\s{2}/, '  ');
  const r = await runCaptureJob({
    metro: a.metro, target: a.target, project, out, steps,
    mode: String(a.mode || 'auto'), interval: intervalSec,
    top: Number(a.top || 30), doGc: a.gc !== false,
    maxSnapshotMB: Number(a['max-snapshot-mb'] || 160),
    snapshotTimeout: Number(a.timeout || 180000),
    trackAlloc: a['track-alloc'] !== false,
    samplingSeconds: Number(a['sampling-seconds'] || 15),
    samplingInterval: Number(a['sampling-interval'] || 65536),
    platform: a.platform ? String(a.platform) : null,
    symbolicate: a.symbolicate !== false,
    saveSourceMap: a['save-sourcemap'] !== false,
    lineBase: Number(a['line-base'] ?? 1),
    bundleUrl: a['bundle-url'] ? String(a['bundle-url']) : undefined,
    sourcemap: a.sourcemap === false ? false : a.sourcemap ? String(a.sourcemap) : undefined,
    keepSnapshots: a['keep-snaps'] === true,
    algorithm: a.algorithm == null ? 'devtools' : String(a.algorithm),
  }, {
    onStage: s => {
      if (s.stage === 'connected') {
        say(`采集模式 ${s.mode} · ${s.steps} 轮 · ${interactive ? '交互(按回车)' : `每轮 ${intervalSec}s`}`);
      }
    },
    onLog: line => say(`${strip(line)}${C.x}`),
    onProgress: p => {
      if (p.done) process.stdout.write('\r' + ' '.repeat(70) + '\r');
      else process.stdout.write(`\r  streaming ${fmtBytes(p.bytes)} / ${p.chunks} chunks`);
    },
    gate: async ({ round, steps: total, mode }) => {
      // Timed CLI capture must not create a competing stdin listener.
      if (mode === 'timed') return new Promise(() => {});
      return { action: await waitEnter(mode === 'sampling' ? '采样中：请复现场景，然后按回车结束采样' : `第 ${round}/${total - 1} 轮：请在 App 里复现一次进入/退出场景`) };
    },
  });

  say(`\n${C.g}✓${C.x} 报告 ${r.htmlPath}\n  ${r.jsonPath}`);
  if (r.warnings.length) r.warnings.forEach(w => warn(w));
  printSummary(r.analysis);
}

async function cmdServe(a) {
  const { createService } = require('../src/service/server');
  const v8 = require('node:v8');
  const out = outDir(a);
  const port = Number(a.port || 7788);
  const host = String(a.host || '127.0.0.1');
  const heapMB = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);

  const server = createService({
    outDir: out,
    metro: String(a.metro || DEFAULT_METRO),
    project: a.project ? path.resolve(String(a.project)) : null,
    aiConfigPath: a['ai-config'] ? String(a['ai-config']) : null,
    log: m => say(`${C.d}[srv]${C.x} ${m}`),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  }).catch(e => {
    if (e.code === 'EADDRINUSE') throw new Error(`端口 ${port} 已被占用，换 --port 7789 再试`);
    throw e;
  });

  say(`${C.g}✓${C.x} HeapScope web service  ${C.b}http://${host}:${port}${C.x}`);
  const aiMod = require('../src/ai');
  const aiCfg = aiMod.createConfigStore({ outDir: out, configPath: a['ai-config'] ? String(a['ai-config']) : null }).read();
  say(`  输出目录 ${out}`);
  say(`  AI ${aiMod.isReady(aiCfg) ? `已配置 · ${aiCfg.model}` : '未配置（浏览器「AI 配置」页可设置）'}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) warn('服务未启用身份认证；非本机监听会暴露报告、源码片段和删除操作，请仅用于可信网络');
  if (heapMB < 6000) {
    warn(`当前 V8 堆上限 ${heapMB}MB，3 份 180MB 快照的分析可能 OOM`);
    say(`  ${C.d}建议用 NODE_OPTIONS=--max-old-space-size=8192 重新启动${C.x}`);
  }
  say(`  ${C.d}Ctrl+C 停止${C.x}`);

  await new Promise(resolve => {
    const stop = () => { say('\n停止服务'); server.close(() => resolve()); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function cmdAnalyze(a) {
  const files = a._.slice(1).map(f => path.resolve(f));
  if (files.length < 2) throw new Error('需要至少 2 个 .heapsnapshot 文件');
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`文件不存在: ${f}`);
  validateOptions({ algorithm: a.algorithm ?? 'devtools', top: Number(a.top ?? 30), lineBase: Number(a['line-base'] ?? 1), platform: a.platform });
  const out = outDir(a);
  const metro = a.metro ? String(a.metro) : null;
  say(`离线分析 ${files.length} 份快照 ...`);
  const r = await runAnalysis({
    snapFiles: files, profileFiles: [], statsSeries: [], meta: { mode: 'offline', engine: 'hermes/v8 (inferred)' },
    warnings: [], sourceCheck: watchman.compare(null, null), metro,
    symbolication: a.symbolicate !== false,
    bundleUrl: a['bundle-url'] ? String(a['bundle-url']) : undefined,
    lineBase: Number(a['line-base'] ?? 1), top: Number(a.top || 30), out,
    project: a.project ? path.resolve(String(a.project)) : null,
    platform: a.platform ? String(a.platform) : null,
    mapFile: a.sourcemap ? String(a.sourcemap) : null,
    enableMap: a.sourcemap !== false,
    saveMap: false,
    algorithm: a.algorithm == null ? 'devtools' : String(a.algorithm),
  });
  say(`${C.g}✓${C.x} 报告 ${r.htmlPath}`);
  printSummary(r.analysis);
}

async function cmdProbe(a) {
  const { cdp } = await connectTarget(a, { probe: false });
  try {
    if (a.install) {
      const r = await installProbe(cdp);
      say(`探针: ${JSON.stringify(r)}`);
      say(`在 DevTools console 里执行: __HEAPSCOPE_PROBE__.track(suspectObject, 'my-label')`);
      say(`然后: node heapscope/bin/heapscope.js probe --check --metro ${a.metro || DEFAULT_METRO} --target ${a.target || ''}`);
    } else {
      const r = await probeAlive(cdp);
      say(JSON.stringify(r, null, 2));
      if (r.alive && r.alive.length) warn(`${r.alive.length}/${r.total} 个对象 GC 后仍存活 → 疑似泄漏: ${r.alive.join(', ')}`);
    }
  } finally { cdp.close(); }
}

async function cmdSelftest(a) {
  const out = path.join(outDir(a), 'selftest');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); say(`  ${ok ? C.g + 'PASS' : C.r + 'FAIL'}${C.x} ${name}${detail ? ' · ' + detail : ''}`); };

  // 1. fixture -> 3 V8-format snapshots
  const fixture = makeFixture();
  const files = fixture.map((s, i) => {
    const f = path.join(out, `snap-${'ABC'[i]}.heapsnapshot`);
    fs.writeFileSync(f, JSON.stringify(s.data));
    return f;
  });
  check('生成 3 份合成 heapsnapshot', files.every(f => fs.statSync(f).size > 100));

  // 2. parser tolerates meta-driven field layout
  const snaps = loadSnapshots(files);
  check('按 snapshot.meta 解析节点/边', snaps.every(s => s.snap.nodes.length > 0) && snaps[0].snap.totals().shallowBytes > 0,
    `${snaps.map(s => s.snap.nodes.length).join('/')} nodes`);

  // 3. diff + retainer path
  const diff = diffSnapshots(snaps, { topN: 30, withRetainers: true });
  const top = diff.candidates[0];
  check('差分识别出单调增长组', !!top && top.totalBytes > 0 && top.growth2 > 0,
    top ? `${top.name} A/B/C=${top.countA}/${top.countB}/${top.countC} +${fmtBytes(top.totalBytes)}` : 'none');
  check('retainer path 定位到全局 _listeners', diff.candidates.some(c => /_listeners/.test(c.retainerText || '')),
    top ? top.retainerText.slice(0, 110) : '');
  check('临时对象（已释放）不进候选', !diff.candidates.some(c => /TempCacheEntry/.test(c.name)));

  // 3b. dev source map decoding (VLQ + cross-line state + source snippet)
  const tinyMap = new SourceMap({
    version: 3,
    sources: ['/proj/src/StoreDetail.tsx'],
    names: ['onStoreDetailScroll'],
    sourcesContent: ['import React from "react";\nconst listener = new Set();\n// leak: never removed\n'],
    mappings: ';'.repeat(40) + 'AAAAA;EACA',
  }, { project: '/proj' });
  const mapped = tinyMap.resolve([
    { file: 'script#2', line: 41, column: 0 },
    { file: 'script#2', line: 42, column: 3 },
    { file: 'script#2', line: 9999, column: 0 },
  ], { lineBase: 1 });
  const m41 = mapped.get('script#2:41:0');
  check('source map v3 解码 + 跨行状态累积',
    !!m41 && m41.shortFile === 'src/StoreDetail.tsx' && m41.line === 1 && m41.method === 'onStoreDetailScroll'
    && mapped.get('script#2:42:3')?.line === 2 && mapped.get('script#2:9999:0') === null,
    m41 ? `${m41.shortFile}:${m41.line} (${m41.method})` : 'none');
  check('源码片段提取', !!m41?.snippet?.some(l => l.hit && /import React/.test(l.text)));
  check('拒绝把日期/日志串误判成分配位置',
    parseSiteFromName('2026-09-22 23:59:59') === null
    && parseSiteFromName('index.bundle:50152:47')?.line === 50152
    && parseSiteFromName('onScroll@41:7')?.file === 'onScroll');

  // 3c. business-file classification (drives the 业务/依赖 tag on candidates)
  check('业务/依赖判定（项目内、非依赖、非静态资源）',
    isBusinessFile('/proj/src/StoreDetail.tsx', '/proj')
    && !isBusinessFile('/proj/node_modules/react-native/index.js', '/proj')
    && !isBusinessFile('/proj/src/a.svg', '/proj')
    && !isBusinessFile('/other/StoreDetail.tsx', '/proj'));

  // 4. streaming CDP capture with delayed chunks (Hermes behaviour)
  const chunks = [];
  const text = JSON.stringify(fixture[0].data);
  for (let i = 0; i < text.length; i += 200) chunks.push(text.slice(i, i + 200));
  const handlers = new Map();
  const fakeCdp = {
    on(m, fn) { handlers.set(m, fn); return () => handlers.delete(m); },
    send(method) {
      if (method === 'HeapProfiler.takeHeapSnapshot') {
        setTimeout(() => { for (const c of chunks) handlers.get('HeapProfiler.addHeapSnapshotChunk')?.({ chunk: c }); }, 40);
      }
      return Promise.resolve({});
    },
  };
  const streamed = await takeHeapSnapshot(fakeCdp, { doGc: false, quietMs: 300, timeout: 5000 });
  check('CDP 分片流拼接（chunk 晚于 command response）', streamed.ok && !!streamed.json?.snapshot,
    `${fmtBytes(streamed.bytes)} / ${streamed.chunks} chunks`);

  // 5. channel-limit failure is classified correctly
  const brokenCdp = {
    on() { return () => {}; },
    send(method) {
      if (method === 'HeapProfiler.takeHeapSnapshot') {
        setTimeout(() => handlers.get('HeapProfiler.addHeapSnapshotChunk')?.({ chunk: '{"snapshot":' }), 1);
        return Promise.reject(Object.assign(new Error('websocket closed (1006)'), { disconnected: true }));
      }
      return Promise.resolve({});
    },
  };
  handlers.set('HeapProfiler.addHeapSnapshotChunk', () => {});
  const broken = await takeHeapSnapshot(brokenCdp, { doGc: false, timeout: 2000, quietMs: 100 });
  check('快照断连被识别为断开', !broken.ok && broken.disconnected === true);

  // 6. sampling profile + full report
  const profileFile = path.join(out, 'sampling.json');
  fs.writeFileSync(profileFile, JSON.stringify(makeSamplingProfile()));
  const r = await runAnalysis({
    snapFiles: files, profileFiles: [profileFile],
    statsSeries: [
      { allocatedBytes: 12 * 1024 * 1024, heapSize: 24 * 1024 * 1024 },
      { allocatedBytes: 15 * 1024 * 1024, heapSize: 27 * 1024 * 1024 },
      { allocatedBytes: 19 * 1024 * 1024, heapSize: 31 * 1024 * 1024 },
    ],
    meta: { mode: 'selftest', engine: 'hermes', rnVersion: '0.81.5', bridgeless: true, target: 'fixture' },
    warnings: [], sourceCheck: watchman.compare({ digest: 'abc', method: 'watchman' }, { digest: 'abc', method: 'watchman' }),
    metro: null, symbolication: false, top: 30, out,
  });
  check('分配热点解析', !!r.analysis.sampling && r.analysis.sampling.hotspots.length >= 3);
  check('HTML 报告生成', fs.existsSync(r.htmlPath) && fs.readFileSync(r.htmlPath, 'utf8').includes('泄漏候选'),
    fmtBytes(fs.statSync(r.htmlPath).size));

  say(`\n报告: ${r.htmlPath}`);
  const failed = results.filter(x => !x.ok);
  say(`${failed.length ? C.r : C.g}${results.length - failed.length}/${results.length} PASS${C.x}`);
  if (failed.length) process.exitCode = 1;
}

// ---------------- AI commands ----------------

function aiStore(a) {
  return require('../src/ai').createConfigStore({
    outDir: outDir(a),
    configPath: a['ai-config'] ? String(a['ai-config']) : null,
  });
}

async function cmdAiConfig(a) {
  const store = aiStore(a);
  const map = {
    'base-url': 'baseUrl', 'api-key': 'apiKey', model: 'model', provider: 'provider',
    'max-candidates': 'maxCandidates', 'max-tokens': 'maxTokens', temperature: 'temperature',
    timeout: 'timeoutMs', 'total-timeout': 'totalTimeoutMs', 'system-prompt': 'systemPrompt',
    'deep-snapshots': 'deepMaxSnapshots', 'deep-candidates': 'deepMaxCandidates',
    'deep-files': 'deepMaxSourceFiles', 'deep-radius': 'deepSourceRadius',
    'deep-chars': 'deepMaxChars', 'deep-mb': 'deepMaxSnapshotMB',
  };
  const numeric = new Set([
    'maxCandidates', 'maxTokens', 'temperature', 'deepMaxSnapshots', 'deepMaxCandidates',
    'deepMaxSourceFiles', 'deepSourceRadius', 'deepMaxChars', 'deepMaxSnapshotMB',
  ]);
  const patch = {};
  for (const [arg, key] of Object.entries(map)) {
    if (a[arg] == null) continue;
    patch[key] = numeric.has(key) ? Number(a[arg])
      : key === 'timeoutMs' ? Number(a[arg]) * 1000
      : key === 'totalTimeoutMs' ? Number(a[arg]) * 60000 : String(a[arg]);
  }
  if (a['system-prompt-file']) patch.systemPrompt = fs.readFileSync(String(a['system-prompt-file']), 'utf8');
  if (a['clear-key']) patch.clearApiKey = true;
  if (a.disable === true) patch.enabled = false;
  if (a.enable === true) patch.enabled = true;
  if (a.deep === false) patch.deepAnalysis = false;
  if (a.deep === true) patch.deepAnalysis = true;
  if (Object.keys(patch).length) { store.save(patch); say(`${C.g}✓${C.x} 配置已保存到 ${store.configPath}`); }
  const c = store.publicView();
  const modelsOut = (c.models || []).map(m => ({
    name: m.name, provider: m.provider, baseUrl: m.baseUrl, model: m.model,
    apiKey: m.hasApiKey ? m.apiKey : '(未设置)', isDefault: m.name === c.defaultModel,
  }));
  say(JSON.stringify({
    enabled: c.enabled, provider: c.provider, baseUrl: c.baseUrl, model: c.model,
    apiKey: c.hasApiKey ? c.apiKey : '(未设置)',
    modelCount: c.models?.length || 0, defaultModel: c.defaultModel, models: modelsOut,
    temperature: c.temperature,
    maxTokens: c.maxTokens, maxCandidates: c.maxCandidates,
    timeoutMs: c.timeoutMs, totalTimeoutMs: c.totalTimeoutMs,
    stream: c.stream, ready: c.ready, envOverrides: c.envOverrides, configPath: c.configPath,
    systemPromptChars: (c.systemPrompt || '').length,
    deepAnalysis: c.deepAnalysis, deepMaxSnapshots: c.deepMaxSnapshots,
    deepMaxCandidates: c.deepMaxCandidates, deepMaxSourceFiles: c.deepMaxSourceFiles,
    deepSourceRadius: c.deepSourceRadius, deepMaxChars: c.deepMaxChars,
    deepMaxSnapshotMB: c.deepMaxSnapshotMB,
  }, null, 2));
}

async function cmdAiTest(a) {
  const ai = require('../src/ai');
  const cfg = aiStore(a).read();
  const eff = ai.selectModel(cfg, a.model);
  if (a.model && eff.name !== a.model) warn(`未找到名为「${a.model}」的模型，已改用默认模型 ${cfg.defaultModel}`);
  const r = await ai.testConnection(eff);
  const label = eff.name && eff.name !== eff.model ? `${eff.name} / ${eff.model}` : (eff.name || eff.model);
  say(`${C.g}✓${C.x} AI 连接正常 · 模型 ${label} · ${r.latencyMs}ms · 回复「${r.reply}」`);
}

async function cmdAiAnalyze(a) {
  const name = a._[1];
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('用法: ai-analyze <报告名>（out 目录下的报告目录名）');
  const out = outDir(a);
  const jsonPath = path.join(out, name, 'analysis.json');
  if (!fs.existsSync(jsonPath)) throw new Error(`报告不存在: ${jsonPath}`);
  const { ensureFocus, saveAiResult } = require('../src/service/store');
  const { analyzeReport, deepOptions } = require('../src/ai');
  const { collectDeepEvidence } = require('../src/deep-evidence');
  const cfg = aiStore(a).read();
  const { selectModel } = require('../src/ai');
  const eff = selectModel(cfg, a.model);
  if (a.model && eff.name !== a.model) warn(`未找到名为「${a.model}」的模型，已改用默认模型 ${cfg.defaultModel}`);
  const analysis = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  ensureFocus(analysis);
  const modelLabel = eff.name && eff.name !== eff.model ? `${eff.name} / ${eff.model}` : (eff.name || eff.model);
  say(`AI 分析 ${name} · ${modelLabel} ...`);
  const deepWanted = a.deep == null ? cfg.deepAnalysis : a.deep !== false;
  let deep = null;
  if (deepWanted) {
    deep = await collectDeepEvidence({
      analysis, reportDir: path.join(out, name),
      project: a.project ? path.resolve(String(a.project)) : (analysis.meta?.project || null),
      options: deepOptions(cfg),
      onStage: (stage, info) => {
        if (stage === 'snapshot') say(`  ${C.d}[deep]${C.x} 解析快照 ${info.index}/${info.total} ${info.file}`);
        else if (stage === 'sources') say(`  ${C.d}[deep]${C.x} 项目 ${info.project} · 源码片段 ${info.files}`);
        else if (stage === 'done') say(`  ${C.d}[deep]${C.x} 证据就绪 ${info.snapshots} 份快照 / ${info.sourceFiles} 个源码片段 / ${info.chars} 字符`);
      },
    });
    if (!deep) say(`  ${C.y}!${C.x} 未找到保留快照，退回报告摘要模式`);
    for (const w of deep?.warnings || []) warn(`[deep] ${w}`);
  }
  const result = await analyzeReport({
    config: eff, analysis, note: String(a.note || ''), deep,
    onDelta: d => process.stdout.write(d),
  });
  saveAiResult(out, name, result);
  say(`\n\n${C.g}✓${C.x} 结论已保存 ${path.join(out, name, 'ai-analysis.json')} · ${result.markdown.length} 字符 · ${result.promptChars} 输入字符${deep ? ` · 深度证据 ${deep.meta.snapshots} 快照/${deep.meta.sourceFiles} 源码` : ''}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (a.version || a.v) { say(`heapscope ${require('../package.json').version} · node ${process.version}`); return; }
  if (!cmd || a.help || a.h) { say(HELP); return; }
  try {
    switch (cmd) {
      case 'devices': return await cmdDevices(a);
      case 'capabilities': return await cmdCapabilities(a);
      case 'capture': return await cmdCapture(a);
      case 'serve': return await cmdServe(a);
      case 'analyze': return await cmdAnalyze(a);
      case 'probe': return await cmdProbe(a);
      case 'selftest': return await cmdSelftest(a);
      case 'ai-config': return await cmdAiConfig(a);
      case 'ai-test': return await cmdAiTest(a);
      case 'ai-analyze': return await cmdAiAnalyze(a);
      default: throw new Error(`unknown command: ${cmd}\n${HELP}`);
    }
  } catch (e) {
    fail(e.message);
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(e.message)) {
      console.error('  → Metro 未运行或端口不通：先在 RN 项目启动 Metro（yarn start / npm start），'
        + 'Android 真机另需 adb reverse tcp:8081 tcp:8081，然后 curl http://127.0.0.1:8081/status 确认');
    }
    if (process.env.HEAPSCOPE_DEBUG) console.error(e.stack);
  }
}

main();
