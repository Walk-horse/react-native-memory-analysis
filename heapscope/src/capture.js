'use strict';
// Capture layer: full heap snapshots (streamed), allocation sampling (fallback),
// and lightweight Hermes stats polling - all over CDP, zero source changes.

const fs = require('node:fs');

const { sleep, safeJson, fmtBytes, flatHeapStats, RUNTIME_PROBE } = require('./lib');

const STATS_EXPR = RUNTIME_PROBE;

async function collectGarbage(cdp, timeout = 30000) {
  try { await cdp.send('HeapProfiler.collectGarbage', {}, { timeout }); return true; }
  catch (e) { return `gc unavailable: ${e.message}`; }
}

// RN 0.81.5 / Hermes does NOT implement HeapProfiler.enable (-32601), yet
// takeHeapSnapshot and startSampling work fine. Enable is a browser-ism here.
async function ensureHeapProfiler(cdp) {
  try { await cdp.send('HeapProfiler.enable', {}, { timeout: 8000 }); return true; }
  catch (e) {
    if (/Unsupported|not (found|supported)|-32601|Unknown method/i.test(e.message)) return false;
    // enable is optional on Hermes. A timeout here means the inspector link
    // itself is stalling (app backgrounded / device locked / wifi drop), NOT
    // that a big snapshot hit a payload ceiling. Verify liveness and fail fast
    // with an accurate reason instead of being misclassified as a size limit.
    if (e.timedOut || e.disconnected || /timeout|closed/i.test(e.message)) {
      try { await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, { timeout: 4000 }); }
      catch { throw new Error(`inspector 通道无响应（${e.message}）：设备可能锁屏 / App 在后台 / 连接中断，请唤醒 App 后重试`); }
      return false;
    }
    throw e;
  }
}

async function readStats(cdp) {
  try {
    const r = await cdp.evaluate(STATS_EXPR, { timeout: 15000 });
    if (!r) return null;
    const flat = flatHeapStats(r.instrumentedStats);
    const pick = re => {
      for (const [k, v] of Object.entries(flat)) if (re.test(k)) return v;
      return null;
    };
    return {
      ts: Date.now(), engine: r.engine, bridgeless: r.bridgeless,
      heapSize: pick(/heapSize|heap_size/i),
      allocatedBytes: pick(/allocatedBytes|allocated_bytes/i),
      numGCs: pick(/numGCs|num_gcs|GCCount/i),
      raw: flat,
    };
  } catch (e) { return { ts: Date.now(), error: e.message }; }
}

// Hermes emits the snapshot as HeapProfiler.addHeapSnapshotChunk events.
// Chunks are appended to a file stream instead of being kept in one JS string.
async function takeHeapSnapshot(cdp, {
  timeout = 180000, gcTimeout = 30000, maxMB = 0, quietMs = 150, doGc = true,
  onProgress = () => {}, outputFile = null,
} = {}) {
  const chunks = [];
  const partial = outputFile ? `${outputFile}.partial` : null;
  let fd = partial ? fs.openSync(partial, 'wx') : null;
  let chunkCount = 0, writeError = null, pendingSurrogate = '';
  const writeChunk = text => {
    if (writeError) return;
    try { fs.writeFileSync(fd, text); } catch (e) { writeError = e; }
  };
  let bytes = 0, lastChunkAt = 0, oversize = false;
  const off = cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
    if (typeof chunk !== 'string') return;
    if (fd != null) {
      let text = pendingSurrogate + chunk;
      pendingSurrogate = '';
      const tail = text.charCodeAt(text.length - 1);
      if (tail >= 0xd800 && tail <= 0xdbff) { pendingSurrogate = text.slice(-1); text = text.slice(0, -1); }
      writeChunk(text);
    } else chunks.push(chunk);
    chunkCount++;
    bytes += Buffer.byteLength(chunk);
    lastChunkAt = Date.now();
    if (maxMB && bytes > maxMB * 1024 * 1024) oversize = true;
    if (chunkCount % 50 === 0) onProgress({ bytes, chunks: chunkCount });
  });
  try {
    await ensureHeapProfiler(cdp);
    const gc = doGc ? await collectGarbage(cdp, gcTimeout) : 'GC disabled';
    try {
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, { timeout });
    } catch (e) {
      // Some Hermes builds reject unknown params outright.
      if (!e.disconnected && /param|argument|Invalid/i.test(e.message)) {
        await cdp.send('HeapProfiler.takeHeapSnapshot', {}, { timeout });
      } else throw e;
    }
    // Command response may precede the last chunks on Hermes.
    const waitStarted = Date.now();
    const deadline = waitStarted + Math.min(10000, Math.max(3000, quietMs * 4));
    while (Date.now() < deadline) {
      await sleep(200);
      if (lastChunkAt && Date.now() - lastChunkAt >= quietMs) break;
      if (!lastChunkAt && Date.now() - waitStarted > 1500) break;
    }
    if (fd != null && pendingSurrogate) writeChunk(pendingSurrogate);
    if (writeError) throw writeError;
    if (fd != null) { fs.closeSync(fd); fd = null; }
    // Validate before publishing; the parser still requires memory proportional to one snapshot.
    const text = partial ? fs.readFileSync(partial, 'utf8') : chunks.join('');
    const json = safeJson(text);
    if (!json || !json.snapshot) {
      return {
        ok: false, bytes, chunks: chunkCount, text,
        error: `snapshot stream incomplete (${fmtBytes(bytes)}, ${chunkCount} chunks). The stream ended before valid snapshot JSON was received; the cause is unknown.`,
        likelyChannelLimit: true,
      };
    }
    if (partial) fs.renameSync(partial, outputFile);
    return { ok: true, bytes, chunks: chunkCount, ...(partial ? { file: outputFile } : { json }), oversize, gc };
  } catch (e) {
    const missingInstrumentation = /memory instrumentation/i.test(e.message);
    return {
      ok: false, bytes, chunks: chunkCount, oversize, missingInstrumentation,
      error: `${e.message}${bytes ? ` (received ${fmtBytes(bytes)} before failure)` : ''}${missingInstrumentation ? ' | 该 Hermes 构建未开启 HERMES_MEMORY_INSTRUMENTATION：完整快照与 sampling 均不可用，只能走 allocation tracking / stats 轮询' : ''}`,
      disconnected: !!e.disconnected, timedOut: !!e.timedOut,
      likelyChannelLimit: !!e.disconnected && bytes > 16 * 1024 * 1024,
    };
  } finally {
    off();
    if (fd != null) fs.closeSync(fd);
  }
}

// HeapProfiler.startTrackingHeapObjects emits small HeapStatsUpdate events
// (3 ints per fragment) - a cheap allocation timeline even when full snapshots
// are impossible. Hermes implements it behind the same instrumentation flag.
// NOTE: we never call stopTrackingHeapObjects - it emits a FULL heap snapshot
// and would hit the same device->Metro payload ceiling. Hermes stops tracking
// when the CDP agent is torn down on disconnect.
async function startAllocationTracking(cdp) {
  const updates = [];
  let lastSeenObjectId = null;
  const offStats = cdp.on('HeapProfiler.heapStatsUpdate', p => {
    if (Array.isArray(p.statsUpdate)) {
      updates.push({ ts: Date.now(), fragments: Math.floor(p.statsUpdate.length / 3) });
    }
  });
  const offId = cdp.on('HeapProfiler.lastSeenObjectId', p => { lastSeenObjectId = p.lastSeenObjectId; });
  try {
    await cdp.send('HeapProfiler.startTrackingHeapObjects', {}, { timeout: 10000 });
    return {
      ok: true,
      dispose: () => { offStats(); offId(); },
      summary: () => ({ events: updates.length, lastSeenObjectId, samples: updates.slice(0, 500) }),
    };
  } catch (e) {
    offStats(); offId();
    return {
      ok: false, error: e.message, dispose: () => {},
      summary: () => ({ events: 0, error: e.message }),
    };
  }
}

async function startSampling(cdp, samplingInterval = 65536) {
  await ensureHeapProfiler(cdp);
  try { await cdp.send('HeapProfiler.startSampling', { samplingInterval }, { timeout: 10000 }); }
  catch (e) {
    if (/param|argument|Invalid/i.test(e.message)) await cdp.send('HeapProfiler.startSampling', {}, { timeout: 10000 });
    else throw e;
  }
}

async function stopSampling(cdp) {
  const r = await cdp.send('HeapProfiler.stopSampling', {}, { timeout: 60000 });
  if (!r || !r.profile) throw new Error('stopSampling returned no profile');
  return r.profile;
}

// Runtime-only probe. Injects a JS object into the Hermes global; touches no files.
const PROBE_SRC = `(() => {
  const g = globalThis;
  if (g.__HEAPSCOPE_PROBE__) return { status: 'already-installed' };
  if (typeof WeakRef !== 'function') return { status: 'unsupported', reason: 'WeakRef missing' };
  const entries = new Map();
  let seq = 0;
  const p = {
    track(obj, label) {
      const id = ++seq;
      const key = String(label || ('obj#' + id));
      entries.set(key, new WeakRef(obj));
      return key;
    },
    alive() {
      const out = [];
      for (const [k, ref] of entries) if (ref.deref() !== undefined) out.push(k);
      return out;
    },
    count() { return entries.size; },
    clear() { entries.clear(); },
  };
  g.__HEAPSCOPE_PROBE__ = p;
  return { status: 'installed', weakRef: true, finalizationRegistry: typeof FinalizationRegistry === 'function' };
})()`;

async function installProbe(cdp) {
  return await cdp.evaluate(PROBE_SRC, { timeout: 10000 });
}

async function probeAlive(cdp) {
  await collectGarbage(cdp);
  const expr = `(() => { const p = globalThis.__HEAPSCOPE_PROBE__; return p ? { total: p.count(), alive: p.alive() } : { error: 'probe not installed' }; })()`;
  return await cdp.evaluate(expr, { timeout: 15000 });
}

module.exports = {
  collectGarbage, ensureHeapProfiler, readStats, takeHeapSnapshot, startAllocationTracking,
  startSampling, stopSampling, installProbe, probeAlive, PROBE_SRC,
};
