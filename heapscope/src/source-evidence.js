'use strict';

function vscodeUrl(file, line, column, columnBase) {
  if (typeof file !== 'string' || !file.startsWith('/') || file.startsWith('//') || /[\x00-\x1f\x7f]/.test(file)) return null;
  const n = Number(line);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  const col = Number(column);
  return `vscode://file${encoded}:${n}${columnBase === 1 && Number.isSafeInteger(col) && col > 0 ? `:${col}` : ''}`;
}

// A sourceChain contains independently discovered nearby locations, not a call
// stack. Preserve provenance and only enrich matching stored locations; never
// read today's project files for a historical report.
function sourceEvidence(candidate = {}) {
  const chain = Array.isArray(candidate.sourceChain) ? candidate.sourceChain : [];
  const details = [candidate.sourceDetail, candidate.allocDetail].filter(Boolean);
  const entries = chain.length ? chain : candidate.sourceDetail ? [{
    ...candidate.sourceDetail,
    via: candidate.siteVia || '源码位置（来源未确认）',
    business: undefined,
  }] : [];
  return entries.filter(e => e && e.file && e.line != null).map(e => {
    const match = details.find(d => d.file === e.file && Number(d.line) === Number(e.line));
    return {
      via: e.via || '关联位置',
      file: e.file,
      shortFile: e.shortFile || e.file,
      line: e.line,
      column: e.column ?? match?.column ?? null,
      // /index.map returns one-based columns. Metro's returned columns are
      // preserved, but their display convention is not assumed here.
      columnBase: e.columnBase ?? (match?.symbolicator === 'metro /index.map' ? 1 : null),
      method: e.method || match?.method || '',
      sourceLine: e.sourceLine || match?.sourceLine || '',
      snippet: Array.isArray(e.snippet) && e.snippet.length ? e.snippet : match?.snippet || [],
      symbolicator: e.symbolicator || match?.symbolicator || '',
      business: typeof e.business === 'boolean' ? e.business : undefined,
      editorUrl: vscodeUrl(e.file, e.line, e.column ?? match?.column, e.columnBase ?? (match?.symbolicator === 'metro /index.map' ? 1 : null)),
    };
  });
}
function validCallStacks(record = {}) {
  return (Array.isArray(record.callStacks) ? record.callStacks : []).filter(stack =>
    stack && stack.provenance === 'sampling' && Array.isArray(stack.frames) &&
    stack.frames.length >= 2 && stack.frames.every(frame => frame && typeof frame === 'object'));
}
module.exports = { sourceEvidence, vscodeUrl, validCallStacks };
