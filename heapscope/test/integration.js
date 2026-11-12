'use strict';
// Real HTTP + WebSocket integration test against a mock Metro/Hermes server.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMockServer } = require('./mock-metro');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin/heapscope.js');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ' · ' + detail : ''}`);
};

(async () => {
  const server = createMockServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const metro = `http://127.0.0.1:${port}`;
  // Must be async: the mock server lives in THIS process, so spawnSync would
  // block its event loop and every request would time out.
  const run = args => new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { p.kill(); resolve({ status: -1, stdout, stderr }); }, 90000);
    p.on('close', code => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });

  console.log(`mock Metro @ ${metro}`);
  try {
    let r = await run(['devices', '--metro', metro]);
    check('devices 列出 /json/list 目标', r.status === 0 && /mockdev-1/.test(r.stdout), (r.stderr || '').slice(0, 120));

    r = await run(['capabilities', '--metro', metro, '--target', '0']);
    check('capabilities 通过真实 WS 探测', r.status === 0 && /"snapshots": true/.test(r.stdout), (r.stderr || '').slice(0, 120));

    const out = path.join(ROOT, 'out', 'integration');
    fs.rmSync(out, { recursive: true, force: true });
    r = await run(['capture', '--metro', metro, '--target', '0', '--steps', '3', '--interval', '1', '--out', out]);
    if (r.status !== 0) console.log((r.stdout || '').slice(-1500), (r.stderr || '').slice(-800));
    check('capture 完成 3 轮采集', r.status === 0 && /报告/.test(r.stdout));

    const jsonPath = path.join(out, 'analysis.json');
    const htmlPath = path.join(out, 'report.html');
    check('产出 analysis.json + report.html', fs.existsSync(jsonPath) && fs.existsSync(htmlPath));
    if (!fs.existsSync(jsonPath)) return;

    const a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    check('3 份 heapsnapshot 落盘', a.snapshotFiles.length === 3, `${a.snapshotFiles.length} files`);
    check('快照命名为 snap-YYYYMMDDHHmmss', a.snapshotFiles.every(f => /^snap-\d{14}(-\d+)?\.heapsnapshot$/.test(path.basename(f))),
      a.snapshotFiles[0] ? path.basename(a.snapshotFiles[0]) : '-');
    check('差分得到泄漏候选', a.candidates.length > 0, `${a.candidates.length} groups`);
    check('retainer path 指向 _listeners', a.candidates.some(c => /_listeners/.test(c.retainerText || '')));
    check('Metro /symbolicate 还原源码位置', a.candidates.some(c => /StoreDetail\.tsx/.test(c.source || '')),
      a.candidates[0]?.source || '-');
    check('Hermes stats 时间序列', a.statsSeries.length === 3 && typeof a.statsSeries[0].allocatedBytes === 'number');
    check('allocation tracking 事件', !!a.allocTracking && a.allocTracking.events >= 1, JSON.stringify(a.allocTracking?.events));
    check('report.html 含候选与趋势', /泄漏候选/.test(fs.readFileSync(htmlPath, 'utf8')));

    // 断连重连：App reload 后 target id 会变，必须按设备身份重新解析，不能复用旧 id。
    const { reconnectTarget } = require('../src/pipeline');
    const rotated = server.rotateTarget();
    const reconn = await reconnectTarget(
      { metro, prev: { id: 'mockdev-1', title: 'Hermes ABI51_0_0React Native (mock)', deviceName: 'MockDevice' }, attempts: 2, delayMs: 200 },
      { log: () => {} },
    );
    check('target id 变化后按设备身份重连成功', reconn.target?.id === rotated && !!reconn.cdp, `${rotated}`);
    try { reconn.cdp.close(); } catch { /* ignore */ }

    server.setTargetVisible(false);
    setTimeout(() => server.setTargetVisible(true), 300);
    const delayed = await reconnectTarget(
      { metro, prev: reconn.target, attempts: 12, delayMs: 60 },
      { probe: false, log: () => {} },
    );
    check('设备延迟重新注册后可重连', delayed.target?.id === rotated);
    delayed.cdp.close();
    server.setTargetVisible(false);
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 50);
    const cancelStart = Date.now();
    let cancelError;
    try { await reconnectTarget({ metro, prev: reconn.target, attempts: 5, delayMs: 2000 }, { isCancelled: () => cancelled }); }
    catch (e) { cancelError = e; }
    check('等待设备重连期间可取消', /已手动取消/.test(cancelError?.message || '') && Date.now() - cancelStart < 1500);
    server.setTargetVisible(true);

    console.log(`\n报告: ${htmlPath}`);
  } finally {
    server.closeAll();
    server.close();
  }

  const failed = results.filter(x => !x.ok).length;
  console.log(`${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} PASS\x1b[0m`);
  process.exit(failed ? 1 : 0);
})();
