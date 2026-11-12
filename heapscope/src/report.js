"use strict";
// Self-contained light-theme HTML report. No CDN, no runtime deps.

const { fmtBytes } = require("./lib");
const { diagnose } = require("./diagnosis");
const { sourceEvidence, validCallStacks } = require("./source-evidence");
const { markdownToHtml } = require("./markdown");

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sparkline(series, key, color) {
  const vals = series
    .map((s) => (s && typeof s[key] === "number" ? s[key] : null))
    .filter((v) => v != null);
  if (vals.length < 2) return `<div class="empty">no ${esc(key)} samples</div>`;
  const w = 520,
    h = 92,
    pad = 8;
  const min = Math.min(...vals),
    max = Math.max(...vals),
    span = max - min || 1;
  const pts = vals
    .map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
        const y = h - pad - ((v - min) / span) * (h - pad * 2);
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${color}"/>`;
      })
      .join("")}
  </svg>
  <div class="spark-legend">${esc(fmtBytes(min))} → ${esc(fmtBytes(max))} · ${vals.length} samples</div>`;
}

function depCell(c) {
  const a = c.allocDetail;
  if (!a) return "";
  const d = c.sourceDetail;
  if (d && a.file === d.file && a.line === d.line) return "";
  const short = a.shortFile || a.file;
  return `<div class="depro" title="${esc(a.file)}">↳ 分配点（依赖）: ${esc(short)}:${esc(a.line)}</div>`;
}

function evidenceBreadcrumb(e) {
  const parts = String(e.shortFile || e.file || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const segments = parts.map(p => `<span class="crumb-part">${esc(p)}</span>`);
  if (e.method) segments.push(`<span class="crumb-method">${esc(e.method)}</span>`);
  const loc = `第 ${esc(e.line)} 行${e.columnBase === 1 && e.column != null ? ` · 第 ${esc(e.column)} 列` : ''}`;
  segments.push(`<span class="crumb-line">${loc}</span>`);
  return `<div class="crumb" title="${esc(e.file)}">${segments.join('<span class="crumb-sep" aria-hidden="true">›</span>')}</div>`;
}

function chainHtml(c) {
  const chain = sourceEvidence(c);
  if (!chain.length) return `<div class="evidence-note">没有可解析的关联源码位置；请结合下方 GC Root 持有链检查。</div>${depCell(c)}`;
  const rows = chain.map((e) => {
    const tag = e.business === true ? '<span class="tag biz">业务</span>'
      : e.business === false ? '<span class="tag dep">依赖/非业务</span>' : '<span class="tag dep">归属未知</span>';
    const snippet = e.snippet?.length
      ? `<details><summary>查看已保存的源码上下文</summary><pre class="code">${e.snippet.map(l => `<span class="${l.hit ? 'hit' : ''}">${esc(String(l.n).padStart(5))}  ${esc(l.text)}</span>`).join('')}</pre></details>`
      : e.sourceLine ? `<pre class="evidence-line">${esc(e.sourceLine)}</pre>` : '<div class="evidence-note">报告未保存源码内容，仅有位置；可用同版本 source map 重新分析。</div>';
    return `<div class="evidence-row"><div class="evidence-via">${esc(e.via)} ${tag}</div>${evidenceBreadcrumb(e)}${e.editorUrl ? `<a class="evidence-editor" href="${esc(e.editorUrl)}" title="在浏览器所在电脑打开该路径；需安装 VS Code 并存在同版本源码">在 VS Code 中打开 ↗</a>` : ''}${snippet}${e.symbolicator ? `<div class="evidence-note">映射来源：${esc(e.symbolicator)}</div>` : ''}</div>`;
  }).join('');
  return `<details class="chainbox" open><summary>关联源码证据 ${chain.length} 项</summary><div class="evidence-note">每项是独立发现的位置；路径面包屑不是调用栈，关联位置也不等同于泄漏根因或分配点。</div>${rows}</details>`;
}

function callStackHtml(stacks) {
  return `<details class="chainbox" open><summary>采样调用栈 ${stacks.length} 条（最多展示 5 条）</summary><div class="evidence-note">采样分配路径，不代表泄漏根因；从调用方到分配热点。</div>${stacks.map(stack => `<div class="path">${stack.frames.map(frame => `<span>${esc(frame.functionName || '(anonymous)')}${frame.source || frame.url ? ` <small>${esc(frame.source || `${frame.url}:${Number(frame.line) + 1}`)}</small>` : ''}</span>`).join(' <span aria-hidden="true">›</span> ')}</div>`).join('')}</details>`;
}

function srcBlock(c) {
  const stacks = validCallStacks(c);
  if (stacks.length) return callStackHtml(stacks);
  const d = c.sourceDetail;
  const via =
    c.siteVia && c.siteVia !== "allocation"
      ? `<div class="via">↳ 关联位置 · ${esc(c.siteVia)}（非分配点）</div>`
      : "";
  if (!d)
    return `<div class="mono">${esc(c.source || "-")}</div>${via}${chainHtml(c)}`;
  const kind = /node_modules/i.test(d.file || "")
    ? '<span class="tag dep">依赖</span>'
    : '<span class="tag biz">业务</span>';
  const code =
    d.snippet && d.snippet.length
      ? `<details><summary>源码上下文</summary><pre class="code">${d.snippet
          .map(
            (l) =>
              `<span class="${l.hit ? "hit" : ""}">${String(l.n).padStart(5)}  ${esc(l.text)}</span>`,
          )
          .join("")}</pre></details>`
      : "";
  return `<div class="srcloc" title="${esc(d.file)}">${esc(c.source)} ${kind}</div>
    ${d.sourceLine ? `<div class="srcline">${esc(d.sourceLine.trim())}</div>` : ""}${via}${chainHtml(c)}${code}`;
}

function fmtCount(n) {
  if (n == null) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 逐轮数量趋势仅作线索，不代表泄漏结论。
function trendCell(c) {
  const t = c.trend || [];
  if (t.length < 2)
    return '<td class="num mono" title="该报告由旧版本生成，不含逐轮数据；重新采集后可显示">-<div class="samples">旧报告</div></td>';
  const d1 = t[1] - t[0];
  const deltas = t.slice(1).map((n, i) => n - t[i]);
  const d2 = t.length > 2 ? deltas[deltas.length - 1] : null;
  let tag = "仅 2 份";
  let cls = "mid";
  if (t[t.length - 1] <= t[0]) {
    tag = "无净增长";
    cls = "flat";
  } else if (d2 == null) {
    tag = "仅 2 份";
    cls = "mid";
  } else if (deltas.some(d => d < 0)) {
    tag = "波动";
    cls = "flat";
  } else if ((t[t.length - 1] - t[0]) / Math.max(1, t[0]) < 0.02) {
    // 全程相对增长 <2%：比例再"线性"也没有泄漏意义（大基数微抖动）
    tag = "平稳";
    cls = "flat";
  } else if (d1 <= 0) {
    tag = "后期增长";
    cls = "mid";
  } else if (d2 / d1 >= 0.7 && deltas.every(d => d > 0)) {
    tag = "线性↑";
    cls = "rise";
  } else if (d2 / d1 <= 0.35) {
    tag = "趋平";
    cls = "flat";
  } else {
    tag = "放缓";
    cls = "mid";
  }
  const line = t.map(fmtCount).join(" → ");
  return `<td class="num mono tline"><span class="tnum" title="${esc(t.join(" → "))}">${esc(line)}</span><span class="ttag ${cls}">${tag}</span></td>`;
}

function issueCell(c) {
  const d = c.issue || diagnose(c);
  const cls = d.severity === 'high' ? 'issue-high' : d.severity === 'watch' ? 'issue-watch' : 'issue-low';
  return `<td class="issue ${cls}"><strong>${esc(d.label)}</strong><div>${esc(d.summary)}</div><small>${esc((d.signals || []).slice(0, 2).join(' · '))}</small></td>`;
}

function focusBadge(c) {
  if (c.focus === "high") return ` <span class="tag hot" title="${esc(c.focusReason || "")}">重点关注</span>`;
  if (c.focus === "watch") return ` <span class="tag watch" title="${esc(c.focusReason || "")}">观察</span>`;
  return "";
}

// 顶部「重点关注」清单：只列 high，给出编号锚点，点一下跳到对应候选行
function focusCard(a) {
  const cands = a.candidates || [];
  const hot = cands.map((c, i) => ({ c, i })).filter(x => x.c.focus === "high");
  const watch = cands.filter(c => c.focus === "watch").length;
  const totals = a.totals || [];
  const first = totals[0];
  const last = totals[totals.length - 1];
  const net = first && last ? last.shallowBytes - first.shallowBytes : 0;
  const body = hot.length
    ? `<table class="focustbl"><tbody>${hot.map(({ c, i }) => `<tr>
        <td class="num mono"><a href="#cand${i}">${i + 1}</a></td>
        <td><strong>${esc(c.name)}</strong> <code>${esc(c.type)}</code></td>
        <td class="mono">${esc((c.sourceDetail && `${c.sourceDetail.shortFile || c.sourceDetail.file}:${c.sourceDetail.line}`) || c.source || "-")}</td>
        <td class="num mono">+${esc(fmtBytes(c.totalBytes))}</td>
        <td class="why">${esc(c.focusReason || "")}</td>
      </tr>`).join("")}</tbody></table>`
    : `<div class="clean">✓ 本轮没有需要重点关注的对象：整堆 ${esc(fmtBytes(first && first.shallowBytes))} → ${esc(fmtBytes(last && last.shallowBytes))}（${net >= 0 ? "+" : ""}${esc(fmtBytes(net))}）。
      Top 候选均为引擎内部对象 / dev 专属开销 / 一次性预热 / 小增量，没有「真实分配点 + 增量 ≥ 64KB + 逐轮线性」的组合。${watch ? `另有 ${watch} 项「观察」需要多跑几轮确认。` : ""}</div>`;
  return `<div class="card focuscard"><h2>重点关注 ${hot.length ? `（${hot.length} 项）` : ""}</h2>
    <div class="sub">按「有真实分配点 + 增量 ≥ 64KB + 逐轮线性增长」筛出；引擎内部 / native 对象（HiddenClass、CodeBlock、chunk）、字符串、dev 专属开销、一次性预热都不计入。</div>
    ${body}</div>`;
}

function candidateRows(cands) {
  if (!cands.length)
    return '<tr><td colspan="9" class="empty">No growing object groups found. Heap looks stable across the captured rounds.</td></tr>';
  return cands
    .map((c, i) => {
      const trend =
        c.growth2 == null
          ? `${fmtBytes(c.growth1)} / 1 interval`
          : `${fmtBytes(c.growth1)} → ${fmtBytes(c.growth2)}`;
      const pct = c.bytesA
        ? ((c.totalBytes / Math.max(1, c.bytesA)) * 100).toFixed(0)
        : "new";
      return `<tr class="crow${c.globalHolder ? " suspect" : ""}${c.focus === "high" ? " hot" : ""}" id="cand${i}" data-i="${i}">
      <td class="num"><span class="caret">▸</span>${i + 1}</td>
      <td><code>${esc(c.type)}</code></td>
      <td><strong>${esc(c.name)}</strong>${focusBadge(c)}${c.samples && c.samples.length ? `<div class="samples">${esc(c.samples.slice(0, 2).join(" | "))}</div>` : ""}</td>
      <td class="num">${c.countA} → ${c.countB}${c.countC != null ? ` → ${c.countC}` : ""}${c.newCount != null ? `<div class="samples">new +${c.newCount} · del -${c.deletedCount}</div>` : ""}</td>
      ${trendCell(c)}
      <td class="num">${esc(fmtBytes(c.totalBytes))}<div class="samples">${pct === "new" ? "new group" : `+${pct}%`}</div></td>
      <td class="num mono">${esc(trend)}</td>
      <td class="num">${Math.round(c.score).toLocaleString()}</td>
      ${issueCell(c)}
    </tr>
    <tr class="xrow" id="xrow${i}" hidden><td colspan="9"><div class="xgrid">
      <div><div class="xh">源码位置</div>${srcBlock(c)}</div>
      <div><div class="xh">GC root 持有链</div><div class="path">${esc(c.retainerText || "n/a")}</div></div>
    </div></td></tr>`;
    })
    .join("");
}

function hotspotRows(sampling) {
  if (!sampling || !sampling.hotspots.length)
    return '<tr><td colspan="5" class="empty">No allocation sampling data captured.</td></tr>';
  return sampling.hotspots
    .slice(0, 20)
    .map((h, i) => {
      const kind = h.sourceDetail
        ? /node_modules/i.test(h.sourceDetail.file || "")
          ? '<span class="tag dep">依赖</span>'
          : '<span class="tag biz">业务</span>'
        : "";
      return `<tr>
    <td class="num">${i + 1}</td>
    <td><strong>${esc(h.functionName)}</strong></td>
    <td class="mono">${validCallStacks(h).length ? callStackHtml(validCallStacks(h)) : `${esc(h.source || (h.url ? `${h.url}:${h.line + 1}` : "-"))} ${kind}${h.sourceDetail?.sourceLine ? `<div class="srcline">${esc(h.sourceDetail.sourceLine.trim())}</div>` : ""}<div class="evidence-note">无采样调用栈</div>`}</td>
    <td class="num">${esc(h.human)}</td>
    <td class="num">${h.pct.toFixed(1)}%</td>
  </tr>`;
    })
    .join("");
}

function aiCard(ai) {
  if (!ai || typeof ai.markdown !== "string" || !ai.markdown.trim()) return "";
  const bits = [
    ai.model ? `模型 ${ai.model}` : null,
    ai.generatedAt ? `生成 ${ai.generatedAt}` : null,
    ai.usage && ai.usage.total_tokens ? `tokens ${ai.usage.total_tokens}` : null,
    ai.deep ? `深度证据 ${ai.deep.snapshots || 0} 份快照 / ${ai.deep.sourceFiles || 0} 个源码片段${ai.deep.truncated ? " · 已裁剪" : ""}` : null,
  ].filter(Boolean);
  const disclaimer = ai.deep
    ? "AI 结论基于报告摘要与本机对保留快照、项目源码片段的解析推导；原始 .heapsnapshot 未上传，源码可能已与采集时不一致，请人工复核。"
    : "AI 结论仅基于本报告摘要推导（该次分析未启用深度证据），属启发式判断，请结合 .heapsnapshot 与源码人工复核。";
  return `<div class="card ai-card" id="ai-analysis"><h2>AI 分析${bits.length ? ` <span class="ai-meta">${esc(bits.join(" · "))}</span>` : ""}</h2>
<div class="md">${markdownToHtml(ai.markdown)}</div>
<div class="ai-disclaimer">${esc(disclaimer)}</div></div>`;
}

function render(a, opts = {}) {
  const meta = a.meta || {};
  const totals = a.totals || [];
  const last = totals[totals.length - 1];
  const first = totals[0];
  const delta = last && first ? last.shallowBytes - first.shallowBytes : 0;
  const warnings = (a.warnings || []).concat(
    a.sourceCheck && a.sourceCheck.clean === false
      ? [a.sourceCheck.reason]
      : [],
  );
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeapScope · RN JS 堆泄漏分析</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--line:#e5e8ee;--text:#1b1f27;--muted:#6b7280;--accent:#2563eb;--warn:#b45309;--warnbg:#fffbeb;--bad:#b91c1c;--badbg:#fef2f2;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.wrap{margin:0;padding:28px 32px 64px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:0 0 14px;letter-spacing:.2px}
.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.chip{background:#eef2f8;border:1px solid #dfe6f0;border-radius:6px;padding:4px 9px;font-size:12px;color:#374151}
.chip b{color:var(--text);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.kpi .value{font-size:22px;font-weight:650;margin-top:4px}
.kpi .foot{color:var(--muted);font-size:11px;margin-top:2px}
.warn{background:var(--warnbg);border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-bottom:10px;color:var(--warn);font-size:13px}
.clean{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;color:var(--ok);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;background:#f3f5f9;color:#4b5563;font-weight:600;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid #f0f2f6;vertical-align:top}
tr.suspect{background:#fffaf7}tr.suspect td:first-child{border-left:3px solid #f97316}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.mono,.path,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.samples{color:var(--muted);font-size:11px;margin-top:2px;word-break:break-all}
details summary{cursor:pointer;color:var(--accent);font-size:11.5px}
.path{margin-top:6px;background:#f8fafc;border:1px solid var(--line);border-radius:6px;padding:8px;word-break:break-all;color:#334155}
.srcloc{color:#1d4ed8;font-weight:600;word-break:break-all}
.srcline{color:#475569;font-size:11px;margin-top:2px;word-break:break-all}
.via{color:#b45309;font-size:10.5px;margin-top:2px}
.depro{color:#64748b;font-size:10.5px;margin-top:2px;word-break:break-all}
details.chainbox{margin-top:4px;border:1px solid var(--line);border-radius:6px;background:#fbfcfe}
details.chainbox summary{color:var(--muted);font-size:10.5px;padding:3px 7px}
.chainrow{display:flex;align-items:baseline;gap:6px;padding:2px 7px;font-size:10.5px;border-top:1px dashed #eef1f6}
.chainrow .viak{color:#b45309;min-width:110px;flex-shrink:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.chainrow .chainloc{color:#1d4ed8;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chainrow .fn{color:#64748b}
tr.crow{cursor:pointer}tr.crow:hover td{background:#f6f8fc}
.caret{display:inline-block;width:13px;color:var(--muted);transition:transform .12s}tr.crow.open .caret{transform:rotate(90deg)}
.tline{white-space:nowrap}
.focuscard{border-color:#fecaca;background:linear-gradient(180deg,#fffafa,#fff)}
.focustbl{width:100%;border-collapse:collapse;font-size:12px}
.focustbl td{padding:5px 6px;border-bottom:1px solid #f3e8e8;vertical-align:top}
.focustbl td.why{color:#7f1d1d;font-size:11.5px}
.focustbl a{color:#b91c1c;font-weight:700;text-decoration:none}
.focustbl code{color:#64748b;font-size:10.5px}
.tag.hot{color:#b91c1c;background:#fef2f2;border-color:#fecaca;font-weight:700}
.tag.watch{color:#b45309;background:#fffbeb;border-color:#fde68a}
tr.crow.hot td{background:#fffafa}
tr.crow.hot td:first-child{box-shadow:inset 3px 0 0 #dc2626}
.tline .tnum{color:#334155}
.ttag{display:inline-block;margin-left:6px;font-size:10px;padding:0 4px;border-radius:4px;border:1px solid transparent}
.ttag.rise{color:#b91c1c;background:#fef2f2;border-color:#fecaca}
.ttag.flat{color:#15803d;background:#f0fdf4;border-color:#bbf7d0}
.ttag.mid{color:#b45309;background:#fffbeb;border-color:#fde68a}
tr.xrow td{background:#fbfcfe;padding:12px 16px}
.xgrid{display:grid;grid-template-columns:1fr;gap:14px}
.xh{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);font-weight:650;margin-bottom:6px}
pre.code{margin:6px 0 0;background:#f8fafc;border:1px solid var(--line);border-radius:6px;padding:7px 8px;overflow-x:auto;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#475569}
pre.code span{display:block;white-space:pre}pre.code span.hit{background:#fef3c7;color:#7c2d12;font-weight:600}
.tag{display:inline-block;font:10px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:1px 5px;border-radius:4px;border:1px solid;white-space:nowrap}
.tag.biz{color:#15803d;background:#f0fdf4;border-color:#bbf7d0}
.tag.dep{color:#64748b;background:#f8fafc;border-color:#e2e8f0}
.tag.leak{color:#b45309;background:#fffbeb;border-color:#fcd34d}
.evidence-editor{display:inline-block;font-size:11px;margin-top:4px;color:#1d4ed8}.evidence-row{border-top:1px dashed var(--line);padding:8px}.evidence-via{color:#9a5b08;font-size:11px}.evidence-note{color:#64748b;font-size:11px;margin:5px 8px;line-height:1.5}.crumb{display:flex;flex-wrap:wrap;gap:3px;align-items:baseline;margin-top:4px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.crumb-part,.crumb-method{color:#1d4ed8;overflow-wrap:anywhere}.crumb-sep{color:#94a3b8}.crumb-line{color:#334155;font-weight:600}.evidence-line{white-space:pre-wrap;overflow-wrap:anywhere;background:#f8fafc;border-radius:4px;padding:5px;margin:5px 0 0;font:11px/1.5 ui-monospace,monospace}.issue{min-width:180px;max-width:280px;line-height:1.45}.issue strong{display:block;font-weight:700;margin-bottom:2px}.issue small{display:block;color:#64748b;margin-top:3px}.issue-high{color:#991b1b;background:#fef2f2}.issue-watch{color:#92400e;background:#fffbeb}.issue-low{color:#475569;background:#f8fafc}
.empty{color:var(--muted);text-align:center;padding:18px}
.spark{width:100%;height:92px;display:block}
.spark-legend{color:var(--muted);font-size:11px;margin-top:2px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}
ul.tips{margin:0;padding-left:18px;color:#374151;font-size:12.5px}ul.tips li{margin-bottom:5px}
.ai-card{border-color:#c7d7f5;background:linear-gradient(180deg,#fbfdff,#fff)}
.ai-meta{font-size:11px;font-weight:400;color:var(--muted);margin-left:8px}
.ai-disclaimer{margin-top:14px;padding-top:10px;border-top:1px dashed var(--line);color:var(--muted);font-size:11px}
.md{font-size:13px;line-height:1.7;overflow-wrap:anywhere}
.md h1,.md h2,.md h3,.md h4{margin:16px 0 8px;line-height:1.35}
.md h1{font-size:18px}.md h2{font-size:16px}.md h3{font-size:14px}.md h4{font-size:13px}
.md p{margin:6px 0}.md ul,.md ol{margin:6px 0;padding-left:22px}.md li{margin:3px 0}
.md code{background:#f1f5f9;border-radius:4px;padding:1px 4px;color:#1d4ed8}
.md pre.md-code{background:#f8fafc;border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto}
.md pre.md-code code{background:none;padding:0;color:#334155;font-size:11.5px}
.md blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid #c7d7f5;background:#f8fafc;color:var(--muted)}
.md hr{border:0;border-top:1px solid var(--line);margin:14px 0}
.md a{color:var(--accent)}
.md .md-table{border-collapse:collapse;margin:8px 0;font-size:12px}.md .md-table td{border:1px solid var(--line);padding:5px 8px}
footer{color:var(--muted);font-size:11px;margin-top:24px;text-align:center}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1>HeapScope · RN JS 堆泄漏分析</h1>
<div class="sub">生成 ${esc(a.generatedAt || "")} · 零侵入 CDP 采集 · Hermes / V8 heapsnapshot 差分</div>
<div class="chips">
  <span class="chip">target <b>${esc(meta.target || "offline")}</b></span>
  <span class="chip">engine <b>${esc(meta.engine || "unknown")}</b></span>
  <span class="chip">RN <b>${esc(meta.rnVersion || "n/a")}</b></span>
  <span class="chip">arch <b>${esc(meta.bridgeless ? "New (bridgeless)" : "legacy / unknown")}</b></span>
  <span class="chip">mode <b>${esc(meta.mode || "snapshot")}</b></span>
  <span class="chip">算法 <b>${esc(a.algorithm === "devtools" ? "DevTools 对比式" : "HeapScope 加权")}</b></span>
  <span class="chip">snapshots <b>${totals.length}</b></span>
  <span class="chip">原始文件 <b>${meta.rawArtifactsRetained === true ? "已保留" : meta.rawArtifactsRetained === false ? "分析后清理" : "状态未知"}</b></span>
  <span class="chip">source <b>${esc((a.sourceCheck && a.sourceCheck.method) || "n/a")}</b></span>
  <span class="chip">symbolication <b>${esc(meta.symbolication || "bundle line only")}</b></span>
  ${meta.siteCoverage ? `<span class="chip">候选定位率 <b>${esc(meta.siteCoverage)}</b></span>` : ""}
  ${(opts.ai || a.ai)?.markdown ? `<span class="chip"><a href="#ai-analysis" style="color:var(--accent);text-decoration:none">AI 分析 <b>已生成 ↓</b></a></span>` : ""}
</div>
${warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
${a.sourceCheck?.clean === true ? '<div class="clean">✓ 源码指纹未变化；仍需确认 bundle 与 source map 匹配</div>' : a.sourceCheck?.clean === false ? '' : '<div class="warn">⚠ 未校验采集期间源码是否变化，无法确认符号化可信度</div>'}
<div class="grid">
  <div class="kpi"><div class="label">基线 shallow</div><div class="value">${esc(fmtBytes(first && first.shallowBytes))}</div><div class="foot">${first ? (first.nodes ?? first.nodeCount ?? 0).toLocaleString() : "-"} nodes</div></div>
  <div class="kpi"><div class="label">末次 shallow</div><div class="value">${esc(fmtBytes(last && last.shallowBytes))}</div><div class="foot">${last ? (last.nodes ?? last.nodeCount ?? 0).toLocaleString() : "-"} nodes</div></div>
  <div class="kpi"><div class="label">净增长</div><div class="value" style="color:${delta > 0 ? "var(--bad)" : "var(--ok)"}">${delta > 0 ? "+" : ""}${esc(fmtBytes(delta))}</div><div class="foot">快照中的浅层大小差异；是否经过 GC 请查看采集警告</div></div>
  <div class="kpi"><div class="label">泄漏候选</div><div class="value">${(a.candidates || []).length}</div><div class="foot">共 ${a.totalCandidates || 0} 个增长组</div></div>
</div>
<div class="card"><h2>堆趋势（Hermes stats 轮询）</h2>
${a.allocTracking ? `<div class="sub">allocation tracking: ${esc(a.allocTracking.events)} 个 HeapStatsUpdate 事件 · lastSeenObjectId ${esc(a.allocTracking.lastSeenObjectId ?? "-")}${a.allocTracking.error ? " · " + esc(a.allocTracking.error) : ""}</div>` : ""}
<div class="two">
  <div><div class="sub">allocatedBytes</div>${sparkline(a.statsSeries || [], "allocatedBytes", "#2563eb")}</div>
  <div><div class="sub">heapSize</div>${sparkline(a.statsSeries || [], "heapSize", "#7c3aed")}</div>
</div></div>
${a.business ? "" : ""}${focusCard(a)}
${aiCard(opts.ai || a.ai)}
<div class="card"><h2>泄漏候选（${a.algorithm === "devtools" ? "构造器分组 · 首末快照 Size Δ 排序，与 Chrome DevTools Comparison 一致" : "按单调增长 × 字节增量 × 全局持有者加权排序"} · 点击行展开源码位置与持有链）</h2>
<table><thead><tr><th>#</th><th>类型</th><th>对象组</th><th>数量 A→B→C</th><th>逐轮数量</th><th>Δ bytes</th><th>增长 1→2</th><th>${a.algorithm === 'devtools' ? 'size Δ 排序' : 'score'}</th><th>问题判断</th></tr></thead>
<tbody>${candidateRows(a.candidates || [])}</tbody></table></div>
<div class="card"><h2>分配热点（sampling heap profiler，低开销）</h2>
<table><thead><tr><th>#</th><th>函数</th><th>位置</th><th>self size</th><th>占比</th></tr></thead>
<tbody>${hotspotRows(a.sampling)}</tbody></table></div>
<div class="card"><h2>判读建议</h2><ul class="tips">
<li>分析算法二选一：<b>DevTools 对比式</b>（默认）——构造器分组 + 首末快照 pairwise，#New/#Deleted/Size Δ 纯字节增量排序，与 Chrome DevTools Comparison 语义一致；<b>HeapScope 加权</b>——多轮 A→B→C 单调增长 ×2.2、全局持有者 ×1.4、业务优先，适合多轮复现后的精排。</li>
<li>「逐轮数量」是判断泄漏的核心：每轮增量基本恒定（标 <b>线性↑</b>）才是泄漏；第一轮暴涨、第二轮几乎不动（标 <b>趋平</b>）说明是一次性预热。两种算法都会给出这一列，DevTools 对比式的排序仍只看首末增量。</li>
<li>逐轮增长只是泄漏线索，并非泄漏证明；请结合 GC 状态、持有链和重复实验验证。</li>
<li>重点看「GC root 持有链」里出现 <code>global / emitter / listeners / timer / native</code> 的行 —— 标橙的就是被全局单例挂住的。</li>
<li>FiberNode / closure 成组增长，通常对应组件卸载后 effect 订阅未清理、闭包被事件源引用。</li>
<li>通道上限取决于实现与平台：RN dev tool 侧曾在 ~75MB 断连，本工具在 iOS / RN 0.81.5 直连 CDP 实测 140MB / 62s 完整通过；一旦断连会自动切 sampling 模式。</li>
<li>「业务 / 依赖」标签按 <code>--project</code> 判定：项目内、非 <code>node_modules</code>/静态资源的源码行标为业务。</li>
<li>定位不到业务代码时，凡能解析出的 node 包位置都会展示：主位置显示为「依赖」，或在关联位置下方以「↳ 分配点（依赖）」列出，依赖包内的分配点本身就是重要线索。</li>
<li>「源码位置」由 Metro dev source map（<code>/index.map</code>）解码得到，展开可看该行前后源码；若显示 <code>index.bundle:行号</code>，说明该分配点没有 debug 位置信息或未找到 source map。</li>
<li>shallow size 不等于 retained size；确认根因请在 Chrome DevTools 里打开同批次 .heapsnapshot 做 Retainers 复核。</li>
</ul></div>
<footer>HeapScope · React Native 0.81+ · Metro / CDP / watchman · 未修改被测 App 任何源码</footer>
</div>
<script>
document.querySelectorAll('tr.crow').forEach(function (tr) {
  tr.addEventListener('click', function (e) {
    if (e.target.closest('summary')) return;
    var x = document.getElementById('xrow' + tr.dataset.i);
    if (!x) return;
    x.hidden = !x.hidden;
    tr.classList.toggle('open', !x.hidden);
  });
});
</script>
</body></html>`;
}

module.exports = { render };
