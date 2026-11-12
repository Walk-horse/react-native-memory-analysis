'use strict';
// Metro / CDP transport layer. Zero third-party deps on Node >= 22.

const http = require('node:http');
const https = require('node:https');

const DEFAULT_METRO = 'http://127.0.0.1:8081';
const MB = 1024 * 1024;

function now() { return new Date().toISOString(); }
const p2 = n => String(n).padStart(2, '0');
// 本地时区时间戳：目录名用 analysis-YYYYMMDDHHmm，快照名用 snap-YYYYMMDDHHmmss
function stampMinute(d = new Date()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`;
}
function stampSecond(d = new Date()) {
  return `${stampMinute(d)}${p2(d.getSeconds())}`;
}
function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const a = Math.abs(n);
  if (a >= MB) return (n / MB).toFixed(2) + ' MB';
  if (a >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return String(n) + ' B';
}
function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(url, { method = 'GET', body, timeout = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request(u, {
      method,
      headers: {
        ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${url}: ${text.slice(0, 300)}`));
        resolve({ status: res.statusCode, text, json: safeJson(text) });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

// ---------- Metro inspector proxy ----------

function toWsBase(metro) {
  const u = new URL(metro);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString().replace(/\/$/, '');
}

function normalizeTarget(t, metro) {
  const wsBase = toWsBase(metro);
  let wsUrl = t.webSocketDebuggerUrl;
  // RN >= 0.76 (@react-native/dev-middleware): the debugger connects to
  // /inspector/debug?device=<logicalDeviceId>&page=<pageId>.
  // /inspector/device is the DEVICE-side socket, never connect to it as a debugger.
  if (!wsUrl) {
    const idStr = String(t.id || '');
    const dash = idStr.lastIndexOf('-');
    const deviceId = t.reactNative?.logicalDeviceId ?? t.deviceId ?? (dash > 0 ? idStr.slice(0, dash) : null);
    const pageId = t.pageId ?? (dash > 0 ? idStr.slice(dash + 1) : null);
    if (deviceId != null && pageId != null) {
      wsUrl = `${wsBase}/inspector/debug?device=${encodeURIComponent(deviceId)}&page=${encodeURIComponent(pageId)}`;
    }
  }
  if (wsUrl && wsUrl.startsWith('/')) wsUrl = wsBase + wsUrl;
  return {
    id: t.id,
    title: t.title || '',
    description: t.description || '',
    type: t.type || '',
    deviceName: t.deviceName || t.description || '',
    vm: t.vm || '',
    wsUrl,
    raw: t,
  };
}

async function metroList(metro = DEFAULT_METRO) {
  const { json } = await request(`${metro}/json/list`, { timeout: 8000 });
  if (!Array.isArray(json)) throw new Error(`/json/list did not return an array: ${JSON.stringify(json).slice(0, 200)}`);
  return json.map(t => normalizeTarget(t, metro));
}

async function metroVersion(metro = DEFAULT_METRO) {
  try { return (await request(`${metro}/json/version`, { timeout: 5000 })).json; }
  catch { return null; }
}

async function metroStatus(metro = DEFAULT_METRO) {
  try { return (await request(`${metro}/status`, { timeout: 5000 })).text; }
  catch { return null; }
}

// ---------- CDP client ----------

function pickWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return { WS: globalThis.WebSocket, impl: 'node:builtin' };
  try {
    // Optional fallback for Node 18/20
    return { WS: require('ws'), impl: 'ws' };
  } catch {
    throw new Error('WebSocket unavailable. Use Node >= 22, or run: npm i ws');
  }
}

// ---------- minimal WebSocket client (zero-dep) ----------

// RN 0.81 dev-middleware's /inspector/debug endpoint runs verifyClient origin
// checks and answers 401 to clients that send no Origin header — Node's builtin
// WebSocket never sends one. This client always sends Origin, so the debugger
// handshake passes. Implements just what the CDP class needs: text frames,
// fragmentation, ping/pong, close.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_MESSAGE = 512 * MB;

class MiniWebSocket {
  constructor(url) {
    const u = new URL(url);
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._listeners = new Map();
    this._rx = Buffer.alloc(0);
    this._frag = null;
    this._socket = null;
    this._established = false;

    if (u.protocol !== 'ws:') throw new Error(`MiniWebSocket only supports ws:// (got ${u.protocol}); use builtin WebSocket for wss://`);
    const key = require('node:crypto').randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Host: u.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Origin: `http://${u.host}`,
      },
    });
    req.setTimeout(30000, () => this._fail('websocket handshake timeout (30s)'));
    req.on('upgrade', (res, socket, head) => {
      if (res.statusCode !== 101) {
        socket.destroy();
        let body = '';
        res.on('data', d => { body += d; if (body.length > 300) res.destroy(); });
        res.on('end', () => this._fail(`HTTP ${res.statusCode} on websocket handshake${body ? `: ${body.trim().slice(0, 200)}` : ''}`));
        res.on('error', () => this._fail(`HTTP ${res.statusCode} on websocket handshake`));
        return;
      }
      const expected = require('node:crypto').createHash('sha1').update(key + WS_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        return this._fail('bad Sec-WebSocket-Accept in handshake response');
      }
      this._socket = socket;
      this._established = true;
      this.readyState = 1;
      if (head && head.length) this._rx = Buffer.concat([this._rx, head]);
      socket.on('data', d => this._onData(d));
      socket.on('error', e => this._fail(e.message));
      socket.on('close', () => this._onSocketClose(1006, 'connection closed'));
      socket.setNoDelay(true);
      this._dispatch('open', {});
    });
    req.on('response', res => {
      let body = '';
      res.on('data', d => { body += d; if (body.length > 300) res.destroy(); });
      res.on('end', () => this._fail(`HTTP ${res.statusCode} on websocket handshake${body ? `: ${body.trim().slice(0, 200)}` : ''}`));
    });
    req.on('error', e => this._fail(e.message));
    req.end();
    this._req = req;
  }

  // WebSocket-ish event API (addEventListener + on/off)
  addEventListener(type, fn) { (this._listeners.get(type) || this._listeners.set(type, []).get(type)).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type); if (!l) return;
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  on(type, fn) { this.addEventListener(type, fn); }
  off(type, fn) { this.removeEventListener(type, fn); }
  _dispatch(type, ev) {
    for (const fn of (this._listeners.get(type) || []).slice()) {
      try { fn(ev); } catch { /* listener errors are the caller's problem */ }
    }
  }
  _fail(message) {
    if (this._established || this.readyState >= 2) return;
    this.readyState = 3;
    try { this._req.destroy(); } catch { /* ignore */ }
    this._dispatch('error', { message });
    this._dispatch('close', { code: 1006, reason: message });
  }
  _onSocketClose(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._dispatch('close', { code, reason });
  }

  _onData(chunk) {
    this._rx = Buffer.concat([this._rx, chunk]);
    while (true) {
      const buf = this._rx;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_MESSAGE)) return this._fail('ws frame too large');
        len = Number(big); off = 10;
      }
      if (len > MAX_WS_MESSAGE) return this._fail('ws frame too large');
      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      this._rx = buf.subarray(off + len);

      if (opcode === 0x9) { try { if (this.readyState === 1 && this._socket) this._frame(0xA, payload); } catch { /* late ping after close — drop */ } continue; } // ping → pong
      if (opcode === 0xA) continue;                                       // pong
      if (opcode === 0x8) {                                               // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.readyState = 3;
        try { this._socket.end(); } catch { /* ignore */ }
        this._dispatch('close', { code, reason });
        return;
      }
      if ((opcode === 0x1 || opcode === 0x2) && this.readyState !== 1) continue; // data after close — drop
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {           // data
        if (!this._frag) {
          if (opcode === 0x0) continue; // stray continuation without start — drop
          this._frag = { opcode, chunks: [payload], size: payload.length };
        } else {
          this._frag.chunks.push(payload);
          this._frag.size += payload.length;
        }
        if (this._frag.size > MAX_WS_MESSAGE) return this._fail('ws message too large');
        if (!fin) continue;
        const full = Buffer.concat(this._frag.chunks);
        this._frag = null;
        this._dispatch('message', { data: full.toString('utf8') });
        continue;
      }
      // unknown opcode — ignore
    }
  }

  _frame(opcode, payload) {
    if (!this._socket || this.readyState !== 1) throw new Error('websocket not open');
    const mask = require('node:crypto').randomBytes(4);
    let header;
    const len = payload.length;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    if (this.readyState !== 1) throw new Error('websocket not open');
    this._frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    try { this._frame(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])); } catch { /* ignore */ }
    this.readyState = 2;
    setTimeout(() => {
      try { this._socket.destroy(); } catch { /* ignore */ }
      this._onSocketClose(code, 'client close');
    }, 100).unref();
  }
}

function messageToString(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map(Buffer.from)).toString('utf8');
  return String(data);
}

class CDP {
  constructor(ws, impl) {
    this.ws = ws;
    this.impl = impl;
    this.pending = new Map();
    this.listeners = new Map();
    this.seq = 0;
    this.closed = false;
    this.closeInfo = null;
    this.lastMessageAt = Date.now();
  }

  static async connect(wsUrl, { timeout = 15000 } = {}) {
    // Prefer MiniWebSocket: it sends an Origin header, which RN 0.81's
    // dev-middleware verifyClient requires (builtin WebSocket omits it → 401).
    let ws;
    try {
      ws = new MiniWebSocket(wsUrl);
    } catch (e) {
      // wss:// or construction failure — fall back to the builtin client.
      const { WS } = pickWebSocket();
      try { ws = new WS(wsUrl); }
      catch (e2) { throw new Error(`cannot open ${wsUrl}: ${e2.message}`); }
    }
    const cdp = new CDP(ws, 'mini');
    const bind = (type, fn) => {
      if (typeof ws.addEventListener === 'function') ws.addEventListener(type, fn);
      else ws.on(type, fn);
    };
    bind('message', ev => cdp._onMessage(ev && ev.data !== undefined ? ev.data : ev));
    bind('error', ev => { if (!cdp._opened) cdp._openError = (ev && ev.message) || 'websocket error'; });
    bind('close', ev => cdp._onClose(ev));
    await cdp._ready(timeout);
    cdp._opened = true;
    return cdp;
  }

  _ready(timeout) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (ws.readyState === 1) return resolve();
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout (${timeout}ms); ${this._openError || ''}`)), timeout);
      const onOpen = () => { clearTimeout(timer); cleanup(); resolve(); };
      const onErr = e => { clearTimeout(timer); cleanup(); reject(new Error(`CDP connect failed: ${(e && e.message) || this._openError || 'unknown'}`)); };
      const cleanup = () => {
        if (typeof ws.removeEventListener === 'function') {
          ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onErr);
        } else { ws.off('open', onOpen); ws.off('error', onErr); }
      };
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen); ws.addEventListener('error', onErr);
      } else { ws.on('open', onOpen); ws.on('error', onErr); }
    });
  }

  _onMessage(data) {
    this.lastMessageAt = Date.now();
    let msg;
    try { msg = JSON.parse(messageToString(data)); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)} (code ${msg.error.code})`));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      const list = this.listeners.get(msg.method);
      if (list) for (const fn of list.slice()) {
        try { fn(msg.params || {}); } catch (e) { process.stderr.write(`[listener ${msg.method}] ${e.message}\n`); }
      }
    }
  }

  _onClose(ev) {
    this.closed = true;
    this.closeInfo = { code: ev && ev.code, reason: ev && ev.reason };
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(`${p.method}: websocket closed (${JSON.stringify(this.closeInfo)})`), { disconnected: true }));
    }
    this.pending.clear();
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => this.off(method, fn);
  }
  off(method, fn) {
    const list = this.listeners.get(method);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  send(method, params = {}, { timeout = 30000 } = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error(`${method}: websocket closed`), { disconnected: true }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method}: timeout after ${timeout}ms`), { timedOut: true }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        reject(Object.assign(new Error(`${method}: send failed: ${e.message}`), { disconnected: true }));
      }
    });
  }

  async evaluate(expression, { timeout = 15000, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue, awaitPromise: false, userGesture: true,
    }, { timeout });
    if (r.exceptionDetails) throw new Error(`Runtime.evaluate threw: ${r.exceptionDetails.text || ''}`);
    return r.result && r.result.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------- capabilities ----------

const RUNTIME_PROBE = `(() => {
  const g = globalThis;
  const h = g.HermesInternal;
  const out = {
    engine: h ? 'hermes' : (typeof g.HermesInternal === 'undefined' ? 'jsc-or-v8' : 'unknown'),
    hasHermesInternal: !!h,
    runtimeProperties: null,
    instrumentedStats: null,
    bridgeless: !!g.__turboModuleProxy || !!g.RN$Bridgeless,
    hasReactDevToolsHook: !!g.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    hasWeakRef: typeof WeakRef === 'function',
    hasFinalizationRegistry: typeof FinalizationRegistry === 'function',
    hasHeapSnapshotProbe: false,
  };
  try { if (h && typeof h.getRuntimeProperties === 'function') out.runtimeProperties = h.getRuntimeProperties(); } catch (e) { out.propsError = String(e); }
  try { if (h && typeof h.getInstrumentedStats === 'function') out.instrumentedStats = h.getInstrumentedStats(); }
  catch (e) { try { if (h && typeof h.getInstrumentedStatistics === 'function') out.instrumentedStats = h.getInstrumentedStatistics(); } catch (e2) { out.statsError = String(e); } }
  return out;
})()`;

function flatHeapStats(stats) {
  if (!stats || typeof stats !== 'object') return {};
  const out = {};
  const walk = (o, prefix = '') => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') walk(v, key);
      else if (typeof v === 'number') out[key] = v;
    }
  };
  walk(stats);
  return out;
}

// Hermes inspector starts in RunningDetached. Debugger.enable moves it to
// Running, otherwise Runtime.evaluate / HeapProfiler commands may be ignored.
async function ensureRuntime(cdp) {
  const state = {};
  for (const method of ['Debugger.enable', 'Runtime.enable']) {
    try { await cdp.send(method, {}, { timeout: 8000 }); state[method] = { ok: true }; }
    catch (e) { state[method] = { ok: false, error: e.message }; }
  }
  return state;
}

async function probeCapabilities(cdp, { runGc = false } = {}) {
  const cap = { runtime: null, commands: {}, errors: [] };
  Object.assign(cap.commands, await ensureRuntime(cdp));
  try { cap.runtime = await cdp.evaluate(RUNTIME_PROBE); }
  catch (e) { cap.errors.push(`Runtime.evaluate: ${e.message}`); }

  const checks = [
    ['HeapProfiler.enable', {}, 8000],
    ['HeapProfiler.collectGarbage', {}, runGc ? 20000 : 8000],
    ['HeapProfiler.startSampling', { samplingInterval: 262144 }, 8000],
    ['HeapProfiler.stopSampling', {}, 8000],
  ];
  for (const [method, params, timeout] of checks) {
    if (method === 'HeapProfiler.collectGarbage' && !runGc) continue;
    try {
      const r = await cdp.send(method, params, { timeout });
      cap.commands[method] = { ok: true, resultKeys: Object.keys(r || {}) };
    } catch (e) {
      cap.commands[method] = { ok: false, error: e.message, unsupported: /not (found|supported)|Unknown method|Unrecognized|method/i.test(e.message) };
    }
  }
  // takeHeapSnapshot is expensive: infer, never execute during probe.
  // Hermes gates takeHeapSnapshot AND startSampling behind the same
  // HERMES_MEMORY_INSTRUMENTATION compile flag, so startSampling is a valid probe.
  // Do not rely on HeapProfiler.enable: some Hermes builds do not register it.
  const samplingOk = cap.commands['HeapProfiler.startSampling']?.ok === true;
  const enableOk = cap.commands['HeapProfiler.enable']?.ok === true;
  const missingInstrumentation = /memory instrumentation/i.test(cap.commands['HeapProfiler.startSampling']?.error || '');
  cap.commands['HeapProfiler.takeHeapSnapshot'] = {
    ok: !missingInstrumentation && (enableOk || samplingOk),
    inferred: true,
    note: 'Hermes gates takeHeapSnapshot/startSampling behind HERMES_MEMORY_INSTRUMENTATION; inferred from startSampling probe',
  };
  cap.supports = {
    snapshots: cap.commands['HeapProfiler.takeHeapSnapshot'].ok,
    sampling: samplingOk && !!cap.commands['HeapProfiler.stopSampling']?.ok,
    gc: runGc ? !!cap.commands['HeapProfiler.collectGarbage']?.ok : null,
    stats: !!cap.runtime?.instrumentedStats,
    memoryInstrumentation: !missingInstrumentation,
  };
  return cap;
}

module.exports = {
  DEFAULT_METRO, MB, now, stampMinute, stampSecond, fmtBytes, safeJson, sleep, request,
  metroList, metroVersion, metroStatus, normalizeTarget, toWsBase,
  CDP, ensureRuntime, probeCapabilities, RUNTIME_PROBE, flatHeapStats,
};
