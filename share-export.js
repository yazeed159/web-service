// share-export.js — builds a single, fully self-contained static HTML file
// ("shareable mini-page") for either one trade or a filtered set of trades,
// and triggers a browser download of it. No fetch()es of local data files:
// everything the page needs is embedded inline, so the result can be
// opened straight from disk, emailed, or uploaded anywhere as one file.
//
// Used by trade.js (single-trade "Share" button) and journal.html's inline
// script (filtered-set "Share this view" button).
window.TradeLogShare = (function () {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    v = Number(v) || 0;
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function fmtPct(v) {
    return (Number(v) || 0).toFixed(1) + "%";
  }
  function toUnix(t) {
    return Math.floor(new Date(String(t).replace(" ", "T")).getTime() / 1000);
  }
  function nowStamp() {
    const d = new Date();
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // Shared dark theme, lifted from core.css's design tokens, kept minimal
  // and inlined so the exported file has zero dependency on this app's
  // stylesheets living at some relative path.
  const BASE_CSS = `
    :root{
      --bg:#0a0b0f; --panel:#14161c; --panel-2:#191c24; --border:#262a34; --border-soft:#1b1e26;
      --text:#eceef2; --text-dim:#8b8fa3; --text-faint:#565a6b;
      --green:#2fd08a; --green-soft:rgba(47,208,138,.12);
      --red:#f2555a; --red-soft:rgba(242,85,90,.12);
      --blue:#5b93f0; --amber:#e8a94c;
      --primary:#8b7cf6; --primary-2:#6e5bf0;
      --mono:'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --sans:-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
      --radius:10px;
    }
    *{box-sizing:border-box;}
    body{margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); font-size:14px; line-height:1.5;}
    .wrap{max-width:900px; margin:0 auto; padding:28px 20px 60px;}
    .brand{display:flex; align-items:center; gap:8px; text-decoration:none; color:var(--text); font-weight:700; font-size:15px; margin-bottom:18px;}
    .brand .mark{width:22px; height:22px; border-radius:6px; background:linear-gradient(120deg,var(--primary),var(--blue)); display:flex; align-items:center; justify-content:center; font-size:12px; color:#fff;}
    .muted{color:var(--text-faint); font-weight:500;}
    .card{background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:16px 18px; margin-bottom:16px;}
    h1{font-size:22px; margin:0 0 4px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;}
    h2{font-size:14px; margin:0 0 12px;}
    .badge{font-size:12px; font-weight:700; padding:3px 9px; border-radius:999px; letter-spacing:.02em;}
    .badge.up{background:var(--green-soft); color:var(--green);}
    .badge.down{background:var(--red-soft); color:var(--red);}
    .up{color:var(--green);} .down{color:var(--red);}
    .meta{color:var(--text-dim); font-size:12.5px; margin-bottom:18px;}
    .meta-standout{color:var(--text); font-weight:600;}
    .pnl-grid{display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--border); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; margin-bottom:18px;}
    .pnl-grid .cell{background:var(--panel); padding:12px 14px;}
    .pnl-grid .label{font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.03em; margin-bottom:4px;}
    .pnl-grid .value{font-size:17px; font-weight:700; font-variant-numeric:tabular-nums;}
    .verdict-text{font-size:13px; line-height:1.6; color:var(--text-dim); margin-bottom:10px;}
    .setup-tag{display:inline-block; font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; background:rgba(139,124,246,.14); color:var(--primary);}
    .walk-away{margin-top:12px; font-size:12.5px; padding:10px 12px; background:var(--panel-2); border-radius:8px; border:1px solid var(--border-soft);}
    .better-row{display:flex; gap:10px; align-items:baseline; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06);}
    .better-row .tag{font-size:10px; font-weight:700; letter-spacing:.03em; opacity:.65; min-width:38px; flex-shrink:0;}
    .better-row .price-line{font-size:12.5px; font-weight:600;}
    .better-row .reason{font-size:11.5px; opacity:.75; margin-top:1px;}
    .no-better{font-size:12px; opacity:.7;}
    .lessons-list{margin:0; padding-left:18px;}
    .lessons-list li{margin-bottom:8px; font-size:12.5px;}
    .lesson-tag{display:inline-block; font-size:10px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; padding:1px 6px; border-radius:3px; background:rgba(91,147,240,.15); color:var(--blue); margin-left:6px; vertical-align:middle;}
    .legend{display:flex; flex-wrap:wrap; gap:12px; font-size:11px; color:var(--text-faint); margin-bottom:8px;}
    .legend-item{display:flex; align-items:center; gap:4px;}
    .legend-swatch{width:9px; height:9px; border-radius:2px; display:inline-block;}
    #candle-chart{width:100%; height:380px;}
    .footer-note{margin-top:22px; font-size:11.5px; color:var(--text-faint); border-top:1px solid var(--border-soft); padding-top:14px;}
    .stat-row{display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--border); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; margin-bottom:18px;}
    .stat-row .cell{background:var(--panel); padding:12px 14px;}
    .stat-row .label{font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.03em; margin-bottom:4px;}
    .stat-row .value{font-size:17px; font-weight:700; font-variant-numeric:tabular-nums;}
    table.data-table{width:100%; border-collapse:collapse; font-size:12.5px;}
    table.data-table th{text-align:left; color:var(--text-faint); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.02em; padding:8px 10px; border-bottom:1px solid var(--border);}
    table.data-table td{padding:8px 10px; border-bottom:1px solid var(--border-soft);}
    .pill{display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px;}
    .pill.win{background:var(--green-soft); color:var(--green);}
    .pill.loss{background:var(--red-soft); color:var(--red);}
    .filters-summary{font-size:12.5px; color:var(--text-dim); margin-bottom:18px;}
    svg.equity-svg{width:100%; height:140px; display:block;}
  `;

  function pageShell({ title, headExtra, bodyHtml, scriptExtra }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
${headExtra || ""}
<style>${BASE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="mark">T</span> trade<span class="muted">.log</span> <span class="muted" style="font-weight:500; font-size:12px;">· static export</span></div>
  ${bodyHtml}
</div>
${scriptExtra || ""}
</body>
</html>`;
  }

  // ---- single trade ---------------------------------------------------

  function betterRowHtml(label, b) {
    if (!b || !b.price) return "";
    return `<div class="better-row">
      <div class="tag">${escapeHtml(label.toUpperCase())}</div>
      <div class="content" style="flex:1; min-width:0;">
        <div class="price-line">$${Number(b.price).toFixed(2)}${b.time ? ` @ ${escapeHtml(String(b.time).split("T").pop())}` : ""}</div>
        ${b.reason ? `<div class="reason">${escapeHtml(b.reason)}</div>` : ""}
      </div>
    </div>`;
  }

  function lessonItemHtml(l) {
    if (typeof l === "string") return `<li>${escapeHtml(l)}</li>`;
    const tagBadge = l.tag ? `<span class="lesson-tag">${escapeHtml(String(l.tag).replace(/_/g, " "))}</span>` : "";
    return `<li>${escapeHtml(l.lesson || l.text || "")}${tagBadge}</li>`;
  }

  function buildTradeSharePage(trade) {
    const win = !!trade.win;
    const bars = Array.isArray(trade.bars) ? trade.bars : [];
    // Trim each bar down to just what the standalone chart needs, so the
    // embedded JSON blob doesn't drag along fields (macd, etc.) unused here.
    const chartBars = bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vwap: b.vwap, ema9: b.ema9, ema20: b.ema20 }));

    const bodyHtml = `
      <h1>
        ${escapeHtml(trade.symbol)}
        <span class="badge ${win ? "up" : "down"}">${win ? "WIN" : "LOSS"} · ${fmtMoney(trade.pnl_after_comm)}</span>
      </h1>
      <div class="meta">
        ${escapeHtml(trade.trade_date)} &nbsp;·&nbsp; entry ${escapeHtml(trade.entry_time)} @ $${Number(trade.entry_price).toFixed(2)}
        &nbsp;→&nbsp; exit ${escapeHtml(trade.exit_time)} @ $${Number(trade.exit_price).toFixed(2)}
        &nbsp;·&nbsp; <span class="meta-standout">${escapeHtml(trade.shares)} sh</span>
        ${trade.time_in_trade ? ` &nbsp;·&nbsp; held <span class="meta-standout">${escapeHtml(trade.time_in_trade)}</span>` : ""}
      </div>

      <div class="pnl-grid">
        <div class="cell"><div class="label">Gross P&amp;L</div><div class="value ${trade.pnl_before_comm >= 0 ? "up" : "down"}">${fmtMoney(trade.pnl_before_comm)}</div></div>
        <div class="cell"><div class="label">Commission</div><div class="value">-$${Number(trade.commission || 0).toFixed(2)}</div></div>
        <div class="cell"><div class="label">Net P&amp;L</div><div class="value ${trade.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(trade.pnl_after_comm)}</div></div>
        <div class="cell"><div class="label">Setup</div><div class="value" style="font-size:13px;">${escapeHtml((trade.setup_type || "—").toString().replace(/_/g, " "))}</div></div>
      </div>

      ${chartBars.length ? `
      <div class="card">
        <div class="legend">
          <span class="legend-item"><span class="legend-swatch" style="background:#e8a94c"></span>VWAP</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#9aa8a1"></span>EMA9</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#5b93f0"></span>EMA20</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#2fd08a"></span>entry</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#f2555a"></span>exit</span>
          ${trade.better_entry && trade.better_entry.price ? `<span class="legend-item"><span class="legend-swatch" style="background:#8b7cf6"></span>better entry</span>` : ""}
          ${trade.better_exit && trade.better_exit.price ? `<span class="legend-item"><span class="legend-swatch" style="background:#ec6cad"></span>better exit</span>` : ""}
        </div>
        <div id="candle-chart"></div>
      </div>` : ""}

      <div class="card">
        <h2>Verdict</h2>
        <div class="verdict-text">${escapeHtml(trade.verdict || "No verdict recorded.")}</div>
        ${trade.setup_type ? `<span class="setup-tag">${escapeHtml(String(trade.setup_type).replace(/_/g, " "))}</span>` : ""}
        ${trade.walk_away_rule ? `<div class="walk-away"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}
      </div>

      ${(trade.better_entry && trade.better_entry.price) || (trade.better_exit && trade.better_exit.price) ? `
      <div class="card">
        <h2>What you should've done</h2>
        ${betterRowHtml("Entry", trade.better_entry)}
        ${betterRowHtml("Exit", trade.better_exit)}
      </div>` : ""}

      ${Array.isArray(trade.lessons) && trade.lessons.length ? `
      <div class="card">
        <h2>Lessons from this trade</h2>
        <ul class="lessons-list">${trade.lessons.map(lessonItemHtml).join("")}</ul>
      </div>` : ""}

      <div class="footer-note">
        Static snapshot of trade <span style="font-family:var(--mono);">${escapeHtml(trade.id || "")}</span>, exported from trade.log on ${nowStamp()}.
        This is a read-only copy for sharing — replay, AI chat, and support/resistance analysis aren't included.
      </div>
    `;

    const headExtra = chartBars.length
      ? `<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>`
      : "";

    const scriptExtra = chartBars.length
      ? `<script>
(function(){
  var bars = ${JSON.stringify(chartBars)};
  var trade = ${JSON.stringify({
        entry_time: trade.entry_time, exit_time: trade.exit_time, trade_date: trade.trade_date,
        entry_price: trade.entry_price, exit_price: trade.exit_price,
        better_entry: trade.better_entry, better_exit: trade.better_exit,
      })};
  function toUnix(t){ return Math.floor(new Date(String(t).replace(" ","T")).getTime()/1000); }
  function barAt(u){ var best = bars[0]; for (var i=0;i<bars.length;i++){ if (toUnix(bars[i].t) <= u) best = bars[i]; else break; } return best; }
  var el = document.getElementById("candle-chart");
  var chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: 380,
    layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
    grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
    rightPriceScale: { borderColor: "#232830" },
    timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: false },
  });
  var candleSeries = chart.addCandlestickSeries({ upColor:"#2fd08a", downColor:"#f2555a", borderVisible:false, wickUpColor:"#2fd08a", wickDownColor:"#f2555a" });
  candleSeries.setData(bars.map(function(b){ return { time: toUnix(b.t), open:b.o, high:b.h, low:b.l, close:b.c }; }));
  chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.14, bottom: 0.18 } });
  var volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  volSeries.setData(bars.map(function(b){ return { time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" }; }));
  chart.addLineSeries({ color:"#e8a94c", lineWidth:1, priceLineVisible:false, lastValueVisible:false }).setData(bars.map(function(b){ return { time: toUnix(b.t), value: b.vwap }; }));
  chart.addLineSeries({ color:"#9aa8a1", lineWidth:1, priceLineVisible:false, lastValueVisible:false }).setData(bars.map(function(b){ return { time: toUnix(b.t), value: b.ema9 }; }));
  chart.addLineSeries({ color:"#5b93f0", lineWidth:1, priceLineVisible:false, lastValueVisible:false }).setData(bars.map(function(b){ return { time: toUnix(b.t), value: b.ema20 }; }));

  var markers = [];
  var entryUnix = toUnix(barAt(toUnix(trade.trade_date + " " + trade.entry_time)).t);
  var exitUnix = toUnix(barAt(toUnix(trade.trade_date + " " + trade.exit_time)).t);
  markers.push({ time: entryUnix, position: "belowBar", color: "#2fd08a", shape: "arrowUp", text: "entry $" + Number(trade.entry_price).toFixed(2) });
  markers.push({ time: exitUnix, position: "aboveBar", color: "#f2555a", shape: "arrowDown", text: "exit $" + Number(trade.exit_price).toFixed(2) });
  if (trade.better_entry && trade.better_entry.price) {
    markers.push({ time: entryUnix, position: "belowBar", color: "#8b7cf6", shape: "circle", text: "better entry $" + Number(trade.better_entry.price).toFixed(2) });
  }
  if (trade.better_exit && trade.better_exit.price) {
    markers.push({ time: exitUnix, position: "aboveBar", color: "#ec6cad", shape: "circle", text: "better exit $" + Number(trade.better_exit.price).toFixed(2) });
  }
  markers.sort(function(a,b){ return a.time - b.time; });
  candleSeries.setMarkers(markers);
  chart.timeScale().fitContent();
  window.addEventListener("resize", function(){ chart.applyOptions({ width: el.clientWidth }); });
})();
</script>`
      : "";

    return pageShell({ title: `${trade.symbol} ${win ? "win" : "loss"} — trade.log`, headExtra, bodyHtml, scriptExtra });
  }

  // ---- filtered set -----------------------------------------------------

  // Small inline SVG equity-curve sparkline (no chart library dependency,
  // so the multi-trade export works completely offline, unlike the
  // single-trade page which needs the lightweight-charts CDN for its
  // candlesticks).
  function equitySvg(points) {
    if (points.length < 2) return "";
    const w = 860, h = 140, pad = 6;
    const ys = points.map((p) => p.cum);
    const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
    const range = max - min || 1;
    const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = (v) => h - pad - ((v - min) / range) * (h - pad * 2);
    const zeroY = y(0);
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(" ");
    const last = points[points.length - 1].cum;
    const stroke = last >= 0 ? "#2fd08a" : "#f2555a";
    return `<svg class="equity-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <line x1="0" y1="${zeroY.toFixed(1)}" x2="${w}" y2="${zeroY.toFixed(1)}" stroke="#262a34" stroke-width="1"/>
      <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2"/>
    </svg>`;
  }

  function buildSetSharePage(trades, opts) {
    opts = opts || {};
    const title = opts.title || `${trades.length} trade${trades.length === 1 ? "" : "s"} — trade.log`;
    const filtersSummary = opts.filtersSummary || "";

    const netPnl = trades.reduce((s, r) => s + (Number(r.pnl_after_comm) || 0), 0);
    const wins = trades.filter((r) => r.win);
    const losses = trades.filter((r) => !r.win);
    const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
    const avgWin = wins.length ? wins.reduce((s, r) => s + (Number(r.pnl_after_comm) || 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, r) => s + (Number(r.pnl_after_comm) || 0), 0) / losses.length : 0;

    // Cumulative P&L for just this filtered set, in chronological order --
    // deliberately recomputed rather than reusing each row's `equity_after`
    // (that field is the running account balance across ALL trades, which
    // would be misleading to show as "the curve for this subset").
    const chrono = trades.slice().sort((a, b) => (a.trade_date + (a.entry_time || "")).localeCompare(b.trade_date + (b.entry_time || "")));
    let cum = 0;
    const curvePoints = chrono.map((r) => { cum += Number(r.pnl_after_comm) || 0; return { cum, row: r }; });

    const sorted = trades.slice().sort((a, b) => (b.trade_date + (b.entry_time || "")).localeCompare(a.trade_date + (a.entry_time || "")));

    const bodyHtml = `
      <h1>${escapeHtml(title)}</h1>
      ${filtersSummary ? `<div class="filters-summary">${escapeHtml(filtersSummary)}</div>` : ""}

      <div class="stat-row">
        <div class="cell"><div class="label">Net P&amp;L</div><div class="value ${netPnl >= 0 ? "up" : "down"}">${fmtMoney(netPnl)}</div></div>
        <div class="cell"><div class="label">Win rate</div><div class="value">${fmtPct(winRate)}</div></div>
        <div class="cell"><div class="label">Avg win</div><div class="value up">${wins.length ? fmtMoney(avgWin) : "—"}</div></div>
        <div class="cell"><div class="label">Avg loss</div><div class="value down">${losses.length ? fmtMoney(avgLoss) : "—"}</div></div>
      </div>

      ${curvePoints.length > 1 ? `<div class="card"><h2>Cumulative P&amp;L (this set, chronological)</h2>${equitySvg(curvePoints)}</div>` : ""}

      <div class="card" style="padding:0;">
        <div style="padding:14px 18px 0;"><h2 style="margin:0;">${trades.length} trade${trades.length === 1 ? "" : "s"}</h2></div>
        <div style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Symbol</th><th>Setup</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th><th>Result</th></tr></thead>
          <tbody>
            ${sorted.map((r) => `
              <tr>
                <td>${escapeHtml(r.trade_date)}</td>
                <td>${escapeHtml(r.symbol)}</td>
                <td>${escapeHtml((r.setup_type || "—").toString().replace(/_/g, " "))}</td>
                <td>$${Number(r.entry_price).toFixed(2)}</td>
                <td>$${Number(r.exit_price).toFixed(2)}</td>
                <td class="${r.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(r.pnl_after_comm)}</td>
                <td><span class="pill ${r.win ? "win" : "loss"}">${r.win ? "WIN" : "LOSS"}</span></td>
              </tr>`).join("")}
          </tbody>
        </table>
        </div>
      </div>

      <div class="footer-note">Static snapshot of ${trades.length} filtered trade${trades.length === 1 ? "" : "s"}, exported from trade.log on ${nowStamp()}. Fully self-contained — no data files or internet connection required to view it.</div>
    `;

    return pageShell({ title, bodyHtml });
  }

  // ---- download ----------------------------------------------------------

  function download(filename, htmlString) {
    const blob = new Blob([htmlString], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  return { buildTradeSharePage, buildSetSharePage, download, slug };
})();
