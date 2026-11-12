'use strict';
// watchman is used for one thing that actually matters here: proving the JS
// bundle (and therefore its source map) did not change between two snapshots.
// A Fast Refresh during a capture silently invalidates every symbolicated line.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const IGNORE = new Set(['node_modules', '.git', 'build', 'dist', 'coverage', '.gradle', 'Pods', 'DerivedData', '.expo', '.watchman-cookie']);
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.mjs', '.cjs']);

function wm(args, timeout = 15000, opts = {}) {
  const r = spawnSync('watchman', args, {
    encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024, ...opts,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 300) };
  // watchman -j / watch-project print PRETTY multi-line JSON. Taking the last
  // line would only yield "}" - parse the whole stdout instead.
  try { return { ok: true, data: JSON.parse((r.stdout || '').trim() || '{}') }; }
  catch (e) { return { ok: false, error: `unparseable watchman output: ${e.message}` }; }
}

function isWatchmanAvailable() {
  // `--version` prints plain text (not JSON), unlike `version`.
  const r = spawnSync('watchman', ['--version'], { encoding: 'utf8', timeout: 5000 });
  return !r.error && r.status === 0;
}

function watchProject(root) {
  const r = wm(['watch-project', root]);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, root: r.data.watch, relative: r.data.relative_path, watcher: r.data.watcher };
}

function digestOf(lines) {
  lines.sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

function fsFingerprint(root) {
  const entries = [];
  const walk = dir => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (IGNORE.has(it.name) || it.name.startsWith('.')) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) { walk(p); continue; }
      if (!EXTS.has(path.extname(it.name))) continue;
      try {
        const st = fs.statSync(p);
        entries.push(`${path.relative(root, p)}:${st.size}:${Math.round(st.mtimeMs)}`);
      } catch { /* vanished */ }
    }
  };
  walk(root);
  return { method: 'fs', files: entries.length, digest: digestOf(entries) };
}

// Expression: all files under the watched project, excluding generated dirs.
// Fields name/size/mtime_ms are enough to detect any edit or Fast Refresh rebuild.
const QUERY = {
  expression: ['suffix', ['js', 'jsx', 'ts', 'tsx', 'json', 'mjs', 'cjs']],
  fields: ['name', 'size', 'mtime_ms'],
};

function wmFingerprint(project) {
  // watchman CLI expects the command as a JSON array on stdin with -j.
  const r = wm(['-j'], 30000, { input: JSON.stringify(['query', project.root, QUERY]) });
  if (!r.ok) return null;
  const files = (r.data.files || []).filter(f => {
    const name = String(f.name || '');
    if (!EXTS.has(path.extname(name))) return false;
    return !name.split('/').some(seg => IGNORE.has(seg));
  });
  const lines = files.map(f => `${f.name}:${f.size}:${Math.round(f.mtime_ms || 0)}`);
  return { method: 'watchman', files: lines.length, watcher: project.watcher, digest: digestOf(lines) };
}

function fingerprint(root) {
  if (!root || !fs.existsSync(root)) return { method: 'none', files: 0, digest: 'n/a', note: 'project root not provided or missing' };
  if (isWatchmanAvailable()) {
    const p = watchProject(root);
    if (p.ok) {
      const f = wmFingerprint(p);
      if (f) return f;
    }
  }
  return fsFingerprint(root);
}

function compare(a, b) {
  if (!a || !b || a.method === 'none' || b.method === 'none' || !a.digest || !b.digest || a.digest === 'n/a' || b.digest === 'n/a') return { clean: null, reason: 'no project fingerprint available' };
  const clean = a.digest === b.digest;
  return {
    clean, before: a.digest, after: b.digest,
    reason: clean
      ? 'source tree unchanged during capture'
      : 'SOURCE CHANGED during capture - Fast Refresh may have invalidated source maps; do a full reload and re-run',
  };
}

module.exports = { isWatchmanAvailable, fingerprint, compare, watchProject };
