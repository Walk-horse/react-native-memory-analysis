'use strict';
// Minimal Metro inspector-proxy + Hermes CDP simulator (no third-party deps).
// Used by test/integration.js to exercise the real HTTP + WebSocket path.

const http = require('node:http');
const crypto = require('node:crypto');
const { makeFixture, makeSamplingProfile } = require('../src/fixture');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 0x81) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = opcode;
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = !!(b1 & 0x80);
    const mask = masked ? buf.slice(off, off + 4) : null;
    off += masked ? 4 : 0;
    if (buf.length < off + len) break;
    let data = Buffer.from(buf.slice(off, off + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode, data: data.toString('utf8') });
    buf = buf.slice(off + len);
  }
  return { frames, rest: buf };
}

function createMockServer() {
  const fixtures = makeFixture();
  let snapIndex = 0;
  let deviceId = 'mockdev-1';
  let targetVisible = true;
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const json = obj => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/json/list' || u.pathname === '/json') {
      const host = req.headers.host || '127.0.0.1';
      if (!targetVisible) return json([]);
      return json([{
        id: deviceId,
        title: 'Hermes ABI51_0_0React Native (mock)',
        description: 'com.example.mockapp',
        type: 'node', deviceName: 'MockDevice',
        webSocketDebuggerUrl: `ws://${host}/inspector/debug?device=mockdev&page=1`,
        reactNative: { logicalDeviceId: 'mockdev', capabilities: {} },
      }]);
    }
    if (u.pathname === '/json/version') return json({ Browser: 'Mobile JavaScript', 'Protocol-Version': '1.1' });
    if (u.pathname === '/status') { res.end('packager-status:running'); return; }
    if (u.pathname === '/symbolicate' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let stack = [];
        try { stack = JSON.parse(body).stack || []; } catch { /* ignore */ }
        return json({ stack: stack.map(f => ({
          file: 'src/pages/StoreDetail.tsx',
          lineNumber: f.lineNumber, columnNumber: f.columnNumber,
          methodName: 'onStoreDetailScroll', collapse: false,
        })) });
      });
      return;
    }
    res.statusCode = 404; res.end('not found');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    const send = obj => { if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(obj))); };

    const handle = msg => {
      const { id, method } = msg;
      const ok = result => send({ id, result });
      switch (method) {
        case 'Debugger.enable':
        case 'Runtime.enable':
        case 'HeapProfiler.enable':
        case 'HeapProfiler.collectGarbage':
        case 'HeapProfiler.startSampling':
          return ok({});
        case 'HeapProfiler.startTrackingHeapObjects':
          ok({});
          send({ method: 'HeapProfiler.lastSeenObjectId', params: { lastSeenObjectId: 900 + snapIndex, timestamp: 1 } });
          return send({ method: 'HeapProfiler.heapStatsUpdate', params: { statsUpdate: [0, 3, 4096, 1, 7, 8192] } });
        case 'Runtime.evaluate':
          return ok({ result: { type: 'object', value: {
            engine: 'hermes', hasHermesInternal: true, bridgeless: true,
            hasWeakRef: true, hasFinalizationRegistry: true,
            instrumentedStats: {
              js_heapSize: (30 + snapIndex * 2) * 1024 * 1024,
              js_allocatedBytes: (12 + snapIndex * 3) * 1024 * 1024,
              js_numGCs: 5 + snapIndex,
            },
          } } });
        case 'HeapProfiler.stopSampling':
          return ok({ profile: makeSamplingProfile() });
        case 'HeapProfiler.takeHeapSnapshot': {
          const text = JSON.stringify(fixtures[Math.min(snapIndex, fixtures.length - 1)].data);
          snapIndex++;
          // Hermes emits all chunks BEFORE the OK response (100KB chunks in real builds).
          for (let i = 0; i < text.length; i += 4096) {
            send({ method: 'HeapProfiler.addHeapSnapshotChunk', params: { chunk: text.slice(i, i + 4096) } });
          }
          return ok({});
        }
        default:
          return ok({});
      }
    };

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 8) { socket.end(); return; }
        if (f.opcode === 9) { socket.write(encodeFrame(f.data, 0x8a)); continue; }
        if (f.opcode !== 1) continue;
        let msg; try { msg = JSON.parse(f.data); } catch { continue; }
        handle(msg);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  server.closeAll = () => { for (const s of sockets) s.destroy(); };
  // 模拟 App reload / Metro 重注册：target id 变化但设备身份（title/deviceName）不变。
  server.setTargetVisible = visible => { targetVisible = visible; };
  server.rotateTarget = () => { deviceId = `mockdev-${Math.random().toString(36).slice(2, 8)}`; return deviceId; };
  return server;
}

if (require.main === module) {
  const port = Number(process.argv[2] || 18081);
  const s = createMockServer();
  s.listen(port, '127.0.0.1', () => console.log(`mock metro on http://127.0.0.1:${port}`));
}

module.exports = { createMockServer };
