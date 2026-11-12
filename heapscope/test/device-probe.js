'use strict';
// One-shot real-device diagnostic: connect -> stats -> GC -> single heap snapshot.
// Usage: node test/device-probe.js [targetIndex]   (PROBE_TIMEOUT=ms)

const fs = require('node:fs');
const path = require('node:path');
const { metroList, CDP, ensureRuntime } = require('../src/lib');
const { takeHeapSnapshot, collectGarbage, readStats } = require('../src/capture');
const { HeapSnapshot } = require('../src/snapshot');

(async () => {
  const list = await metroList();
  const t = list[Number(process.argv[2] || 0)];
  if (!t) throw new Error(`target ${process.argv[2]} not found`);
  const cdp = await CDP.connect(t.wsUrl);
  console.log('connected:', t.title, t.wsUrl);

  const init = await ensureRuntime(cdp);
  console.log('init:', JSON.stringify(init));
  console.log('stats:', JSON.stringify(await readStats(cdp)));
  console.log('gc:', await collectGarbage(cdp));

  const t0 = Date.now();
  let last = 0;
  const r = await takeHeapSnapshot(cdp, {
    timeout: Number(process.env.PROBE_TIMEOUT || 180000),
    doGc: false, maxMB: 60,
    onProgress: p => {
      if (Date.now() - last > 2000) {
        last = Date.now();
        console.log(`  streaming ${p.chunks} chunks / ${(p.bytes / 1024 / 1024).toFixed(1)} MB`);
      }
    },
  });
  console.log('snapshot:', JSON.stringify({
    ok: r.ok, bytes: r.bytes, chunks: r.chunks, ms: Date.now() - t0,
    oversize: r.oversize, disconnected: r.disconnected,
    likelyChannelLimit: r.likelyChannelLimit, error: (r.error || '').slice(0, 500),
  }));

  if (r.ok) {
    const f = path.join(__dirname, '..', 'out', 'device-probe.heapsnapshot');
    fs.writeFileSync(f, JSON.stringify(r.json));
    const s = new HeapSnapshot(r.json, f);
    console.log('parsed:', JSON.stringify(s.totals()));
    console.log('meta.node_fields:', s.nodeFields.join(','));
    console.log('locations:', s.locations.size, 'strings:', s.strings.length);
    console.log('file:', f, fs.statSync(f).size, 'bytes');
  } else if (r.text) {
    const f = path.join(__dirname, '..', 'out', 'device-probe-partial.txt');
    fs.writeFileSync(f, r.text);
    console.log('partial written:', f);
  }
  cdp.close();
})().catch(e => { console.error('ERROR:', e.message); if (process.env.HEAPSCOPE_DEBUG) console.error(e.stack); process.exit(1); });
