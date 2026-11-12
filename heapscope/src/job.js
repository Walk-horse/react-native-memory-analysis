'use strict';
// Capture orchestration shared by the CLI and the web service.
// The only difference between the two hosts is the `gate`: the CLI waits for
// the Enter key, the web service waits for a POST /continue from the browser.

const fs = require('node:fs');
const path = require('node:path');

const { fmtBytes, sleep, stampSecond } = require('./lib');
const {
  readStats, takeHeapSnapshot, startAllocationTracking, startSampling, stopSampling,
} = require('./capture');
const { connectTarget, reconnectTarget, runAnalysis, detectRnVersion } = require('./pipeline');
const watchman = require('./watchman');
const { validateOptions } = require('./config');

const noop = () => {};

// 快照文件名为 snap-YYYYMMDDHHmmss.heapsnapshot；同一秒内连拍时追加 -2、-3 保唯一。
function snapshotPath(dir) {
  const base = path.join(dir, `snap-${stampSecond()}`);
  let f = `${base}.heapsnapshot`;
  for (let n = 2; fs.existsSync(f); n++) f = `${base}-${n}.heapsnapshot`;
  return f;
}

const STAGES = ['connecting', 'connected', 'waiting', 'snapshot', 'analyzing', 'done', 'error'];

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function runCaptureJob(opts = {}, hooks = {}) {
  const {
    metro, target, project = null, out,
    steps = 3, mode: requestedMode = 'auto', interval = 0,
    top = 30, doGc = true, maxSnapshotMB = 160, snapshotTimeout = 180000,
    trackAlloc = true, samplingSeconds = 15, samplingInterval = 65536,
    platform = null, symbolicate = true, saveSourceMap = true,
    lineBase = 1, bundleUrl, sourcemap,
    keepSnapshots = false, writeHtml = true, algorithm = 'devtools',
  } = opts;

  validateOptions({ steps, mode: requestedMode, interval, top, maxSnapshotMB, snapshotTimeout, samplingSeconds, samplingInterval, platform, lineBase, algorithm });
  if (!out) throw new Error('缺少输出目录');
  const onStage = hooks.onStage || noop;
  const onLogRaw = hooks.onLog || noop;
  const onProgress = hooks.onProgress || noop;
  const gate = hooks.gate || (async () => 'next');
  const onSnapshot = hooks.onSnapshot || noop;
  const checkCancelled = () => { if (hooks.isCancelled?.()) throw new Error('已手动取消'); };

  const log = msg => onLogRaw(`${stamp()}  ${msg}`);
  const warnings = [];
  const statsSeries = [];
  const snapFiles = [];
  const profileFiles = [];

  const stage = (name, extra = {}) => onStage({ stage: name, ...extra });

  fs.mkdirSync(out, { recursive: true });

  let cdp = null, tracker = null;
  try {
    stage('connecting', { metro });
    const fpBefore = project ? watchman.fingerprint(project) : { method: 'none', digest: 'n/a', files: 0 };
    log(`源码指纹 [${fpBefore.method}] ${fpBefore.digest} · ${fpBefore.files} files`);

    const connOpts = { probe: true, log, warn: w => { warnings.push(w); log(`! ${w}`); } };
    let conn;
    try {
      conn = await connectTarget({ metro, target }, connOpts);
    } catch (e) {
      if (/target not found/i.test(e.message)) throw new Error(`所选设备已离线或目标 ID 已变化（${target}）；请刷新设备列表并重新选择，避免误连其他设备。`);
      throw e;
    }
    cdp = conn.cdp;
    checkCancelled();
    if (hooks.onCdp) hooks.onCdp(cdp);
    let cap = conn.cap;

    try { await cdp.evaluate('1', { timeout: 6000 }); }
    catch (e) {
      throw new Error(`inspector 通道健康检查失败：${e.message}。请唤醒设备上的 App，确认 DevTools 可连后再采集`);
    }

    let mode = String(requestedMode || 'auto');
    if (mode === 'auto') mode = cap?.supports.snapshots ? 'snapshot' : 'sampling';
    if (mode === 'sampling' && !cap?.supports.sampling) throw new Error('当前运行时不支持 HeapProfiler sampling');

    stage('connected', {
      target: conn.target.title || conn.target.id,
      engine: cap?.runtime?.engine || 'unknown',
      bridgeless: !!cap?.runtime?.bridgeless,
      mode, steps,
    });
    log(`第 ${steps - 1} 轮场景复现 · 输出 ${out}`);

    const snapOpts = {
      timeout: snapshotTimeout,
      maxMB: maxSnapshotMB,
      doGc,
      onProgress: p => { onProgress({ ...p, stage: 'snapshot' }); },
    };

    let degraded = false, quit = false, channelDead = false;

    if (trackAlloc) {
      tracker = await startAllocationTracking(cdp);
      if (tracker.ok) log('allocation tracking 已启用（HeapStatsUpdate 轻量时间序列）');
      else { warnings.push(`allocation tracking 不可用: ${tracker.error}`); log(`! allocation tracking 不可用: ${tracker.error}`); }
    }

    if (!doGc) warnings.push('本次采集未主动执行 GC，快照差异可能包含尚未回收的对象。');
    for (let i = 0; mode === 'snapshot' && i < steps && !quit; i++) {
      checkCancelled();
      if (i > 0) {
        stage('waiting', { round: i, steps, hint: `第 ${i}/${steps - 1} 轮：请在 App 里复现一次进入/退出场景` });
        log(`等待第 ${i}/${steps - 1} 轮场景复现 ...`);
        let action = 'next';
        if (interval > 0) {
          const deadline = Date.now() + interval * 1000;
          let timer;
          const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ action: 'next', timeout: true }), interval * 1000); });
          const r = await Promise.race([gate({ round: i, steps, deadline, mode: 'timed' }), timeout]);
          clearTimeout(timer);
          if (r.timeout) hooks.onGateExpired?.({ round: i, mode: 'timed' });
          action = r.action || 'next';
          if (!r.timeout) log(`收到「${action}」，提前结束本轮等待`);
        } else {
          const r = await gate({ round: i, steps, mode: 'manual' });
          action = r.action || 'next';
        }
        checkCancelled();
        if (action === 'quit') { quit = true; log('用户结束采集'); break; }
      }

      const st = await readStats(cdp);
      statsSeries.push(st);
      if (st?.allocatedBytes != null) log(`stats heap=${fmtBytes(st.heapSize)} alloc=${fmtBytes(st.allocatedBytes)} gc=${st.numGCs ?? '?'}`);
      else if (st?.error) {
        warnings.push(`stats 读取失败: ${st.error}`);
        log(`! stats 读取失败: ${st.error}`);
        if (/closed|timeout|disconnect|ECONN/i.test(st.error)) {
          throw new Error(`inspector 通道已断开（${st.error}）：设备可能锁屏 / App 切后台 / 连接中断，请唤醒 App 后重试`);
        }
      }

      if (mode !== 'snapshot') continue;

      stage('snapshot', { index: i, phase: 'start' });
      log(`拍摄快照 ${i}/${steps - 1}（App 会卡顿 10~15s，请勿操作）`);
      const f = snapshotPath(out);
      const r = await takeHeapSnapshot(cdp, { ...snapOpts, outputFile: f });
      checkCancelled();
      onProgress({ stage: 'snapshot', done: true, bytes: r.bytes, chunks: r.chunks, index: i });

      if (r.ok) {
        if (doGc && r.gc !== true) warnings.push(`快照 ${i} 前 GC 失败：${r.gc}；对象可能尚未回收。`);
        snapFiles.push(f);
        onSnapshot({ index: i, file: f, bytes: r.bytes, chunks: r.chunks });
        stage('snapshot', { index: i, phase: 'done', bytes: r.bytes, chunks: r.chunks, file: f });
        log(`✓ 快照 ${i} ${fmtBytes(r.bytes)} · ${r.chunks} chunks · ${path.basename(f)}`);
        if (r.oversize) {
          warnings.push(`快照 ${i} 超过 ${maxSnapshotMB}MB 预警线 (${fmtBytes(r.bytes)})；仍传输成功，若后续断连将自动降级 sampling`);
        }
      } else {
        warnings.push(`快照 ${i} 失败: ${r.error}`);
        log(`! 快照 ${i} 失败: ${r.error}`);
        if (r.likelyChannelLimit) {
          degraded = true; mode = 'sampling';
          warnings.push('快照流不完整或连接中断，原因未确定；尝试重新连接并降级为 sampling，需重新复现场景。');
          log('→ 等待原设备重新连接（最长约 30 秒），随后尝试低开销 sampling；请保持 App 在前台，采样开始后重新复现场景');
          tracker?.dispose(); tracker = null;
          try {
            cdp.close();
            // 重连不能复用旧 target id：App reload 后 id 会变，必须按设备身份重新解析。
            const retry = await reconnectTarget(
              { metro, prev: conn.target, attempts: 31, delayMs: 1000 },
              { probe: true, log, warn: w => warnings.push(w), isCancelled: () => !!hooks.isCancelled?.() },
            );
            cdp = retry.cdp; cap = retry.cap; conn.target = retry.target;
            hooks.onCdp?.(cdp);
            if (!cap?.supports.sampling) throw new Error(`重连后的运行时（${retry.target.title || retry.target.id}）不支持 HeapProfiler sampling`);
          } catch (e) {
            checkCancelled();
            channelDead = true;
            warnings.push(`重新连接或采样能力探测失败：${e.message}；已保留已完成快照（${snapFiles.length} 份）。可回「开始分析」刷新设备列表，选择原设备并直接使用「仅采样」重新采集。`);
            if (!snapFiles.length) throw new Error(warnings[warnings.length - 1]);
          }
          break;
        } else if (r.disconnected || r.timedOut) {
          channelDead = true; quit = true;
          warnings.push(`快照 ${i} 期间 inspector 通道异常（${r.error}）；未收到数据，不判定为大堆限制。常见原因：设备锁屏 / App 切后台 / 网络抖动，请唤醒 App 重连后重试`);
          if (i === 0) throw new Error(`首个快照因 inspector 通道异常失败：${r.error}`);
          break;
        } else if (i === 0) {
          throw new Error(`首个快照即失败，终止采集：${r.error}`);
        }
      }
    }

    // Sampling is a single window: start before the scenario, stop after.
    checkCancelled();
    if (mode === 'sampling' && !channelDead && cap?.supports.sampling !== false) {
      stage('sampling', { seconds: interval > 0 ? samplingSeconds : 0 });
      await startSampling(cdp, samplingInterval);
      log(`sampling 开始${interval > 0 ? `，${samplingSeconds}s 后自动结束` : '，等待手动结束'}`);
      if (interval > 0) await sleep(samplingSeconds * 1000);
      else {
        const r = await gate({ round: 0, steps: 0, mode: 'sampling' });
        if (r.action === 'quit') log('用户结束采样');
      }
      checkCancelled();
      const profile = await stopSampling(cdp);
      const f = path.join(out, `sampling-${stampSecond()}.json`);
      fs.writeFileSync(f, JSON.stringify(profile));
      profileFiles.push(f);
      log(`✓ sampling profile · ${path.basename(f)}`);
    }

    checkCancelled();
    stage('analyzing', { snapshots: snapFiles.length });
    log('分析中：差分 + 符号化 + 生成报告 ...');

    const fpAfter = project ? watchman.fingerprint(project) : { method: 'none', digest: 'n/a', files: 0 };
    const meta = {
      metro, target: conn.target.title || conn.target.id,
      engine: cap?.runtime?.engine || 'unknown',
      bridgeless: !!cap?.runtime?.bridgeless,
      rnVersion: detectRnVersion(project),
      mode: degraded ? 'snapshot→sampling (degraded)' : mode,
      project: project || null, gcRequested: doGc, rawArtifactsRetained: keepSnapshots,
    };

    const result = await runAnalysis({
      snapFiles, profileFiles, statsSeries,
      allocTracking: tracker ? tracker.summary() : null,
      meta, warnings, sourceCheck: watchman.compare(fpBefore, fpAfter), metro,
      symbolication: symbolicate, bundleUrl, lineBase, top, out, project, platform,
      mapFile: typeof sourcemap === 'string' ? sourcemap : null,
      enableMap: sourcemap !== false,
      saveMap: saveSourceMap,
      writeHtml,
      algorithm,
      log,
    });

    // 分析成功后清理大体积中间产物（失败时保留，便于离线重分析）。
    // 报告的唯一持久产物是 analysis.json（几 KB）；report.html 由服务端
    // 按需从 JSON 实时渲染，不落盘。
    let freedBytes = 0;
    const rmQuiet = f => {
      try { freedBytes += fs.statSync(f).size; fs.unlinkSync(f); } catch { /* gone */ }
    };
    if (!keepSnapshots) {
      snapFiles.forEach(rmQuiet);
      profileFiles.forEach(rmQuiet);
      const sm = path.join(out, 'sourcemap.json');
      if (fs.existsSync(sm)) rmQuiet(sm);
      if (freedBytes > 0) {
        log(`✓ 已清理中间产物（快照/采样/sourcemap），释放 ${fmtBytes(freedBytes)}；报告以 analysis.json 存储${writeHtml ? '' : '，HTML 打开时实时渲染'}`);
      }
    }

    stage('done', { htmlPath: result.htmlPath, jsonPath: result.jsonPath, candidates: result.analysis.candidates.length });
    log(`✓ 报告 ${result.htmlPath}`);

    return {
      ok: true, out,
      analysis: result.analysis, htmlPath: result.htmlPath, jsonPath: result.jsonPath,
      warnings, snapshots: snapFiles.map(f => path.basename(f)),
      meta: result.analysis.meta, degraded,
    };
  } catch (e) {
    stage('error', { message: e.message });
    log(`✗ ${e.message}`);
    throw e;
  } finally {
    tracker?.dispose();
    try { cdp?.close(); } catch { /* already gone */ }
  }
}

module.exports = { runCaptureJob, STAGES };
