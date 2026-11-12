'use strict';
// Minimal, dependency-free Markdown -> HTML renderer for AI conclusions.
// Input is ALWAYS escaped first; only a deliberately small subset of syntax
// is turned back into tags, so model output can never inject HTML/JS.

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(raw) {
  let s = esc(raw);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Only http(s) links; javascript:/data: are left as plain text.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

function markdownToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;       // 'ul' | 'ol'
  let para = [];
  let inCode = false;
  let code = [];
  let quote = [];

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) { out.push(`<pre class="md-code"><code>${esc(code.join('\n'))}</code></pre>`); code = []; inCode = false; }
      else { flushAll(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { flushAll(); const n = head[1].length; out.push(`<h${n}>${inline(head[2])}</h${n}>`); continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      flushPara(); flushQuote();
      if (list !== want) { flushList(); list = want; out.push(`<${want}>`); }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) { flushPara(); flushList(); quote.push(bq[1]); continue; }

    if (!line.trim()) { flushAll(); continue; }
    // Simple pipe table: header row + delimiter row + body rows.
    if (/^\s*\|/.test(line) && !list && !quote.length) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
      if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue;
      flushAll();
      out.push(`<table class="md-table"><tbody><tr>${cells(line).map(c => `<td>${inline(c)}</td>`).join('')}</tr></tbody></table>`);
      continue;
    }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  if (inCode) out.push(`<pre class="md-code"><code>${esc(code.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

module.exports = { markdownToHtml, esc };
