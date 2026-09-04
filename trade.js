(function () {
  "use strict";

  // Webhook for the optional "Support & Resistance" box below --
  // fires an n8n workflow that reads the symbol's prior daily bars and
  // returns support/resistance levels. Only ever called when the person
  // clicks the button on a trade page; never runs automatically, so it
  // never spends API tokens on its own. Point this at your own n8n
  // instance the same way #import-trades-link in trade.html is pointed at
  // its form URL. The actual URL lives in config.js (window.N8N_SR_URL) so
  // it only has to be set in one place.
  const SR_ANALYSIS_URL = window.N8N_SR_URL || "";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const content = document.getElementById("trade-content");

  // Set once buildCharts() creates the candlestick chart, so the S/R
  // button (added further down, after the chart already exists on the
  // page) can draw price lines onto it without re-plumbing chart creation.
  let srCandleSeries = null;
  // Every drawSrLevelsOnChart() call adds new createPriceLine()s without
  // ever removing the last batch -- clicking "Analyze support/resistance"
  // more than once (re-running after the first result, or just curiosity)
  // stacked a fresh set of support/resistance lines on top of the old
  // ones every time. Support lines are the same green (#2fd08a) as the
  // real entry price line, so a second run could leave what looked like
  // two overlapping green "entry" lines on the chart. Tracked here so
  // drawSrLevelsOnChart can clear its own previous lines first.
  let srPriceLines = [];

  // Set once the trade detail JSON loads, so the "Share trade" button
  // (static markup, lives outside #trade-content so it survives re-renders)
  // has something to export. Wired up here rather than inside renderTrade
  // so it only has to be attached once.
  let currentTrade = null;
  const shareBtn = document.getElementById("share-trade-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      if (!currentTrade || !window.TradeLogShare) return;
      const label = document.getElementById("share-trade-label");
      try {
        const html = TradeLogShare.buildTradeSharePage(currentTrade);
        const filename = `trade-${TradeLogShare.slug(currentTrade.symbol)}-${TradeLogShare.slug(currentTrade.trade_date)}.html`;
        TradeLogShare.download(filename, html);
        if (label) { label.textContent = "Downloaded!"; setTimeout(() => (label.textContent = "Share trade"), 1600); }
      } catch (e) {
        if (label) { label.textContent = "Couldn't export"; setTimeout(() => (label.textContent = "Share trade"), 1600); }
      }
    });
  }

  // Sibling (prev/next) nav needs the full index, sorted the same way the
  // publish pipeline sorts it (trade_date + entry_time). Fetching it is
  // best-effort — if it 404s or is missing, the page still renders fine
  // without nav arrows.
  let siblingsPromise = window.fetchTradesIndex()
    .catch(() => [])
    .then((rows) =>
      (Array.isArray(rows) ? rows : []).slice().sort((a, b) =>
        (a.trade_date + a.entry_time).localeCompare(b.trade_date + b.entry_time)
      )
    );

  if (!id) {
    content.innerHTML = `<div class="empty-state">No trade id in the URL — go back and pick one from the journal.</div>`;
  } else {
    Promise.all([
      window.fetchTradeDetail(id).then((trade) => {
        if (!trade) throw new Error("Not found");
        return trade;
      }),
      siblingsPromise,
    ])
      .then(([trade, siblings]) => { currentTrade = trade; renderTrade(trade, siblings); })
      .catch((err) => {
        content.innerHTML = `
          <div class="empty-state">
            Couldn't load this trade (${escapeHtml(String(err.message))}).<br>
            <span style="font-size:12.5px">If the pipeline's publish step for this trade hasn't run successfully yet, it won't be in your Supabase trades/trade_details tables.</span>
          </div>`;
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  // Net P&L per share, in cents -- e.g. $86 net on 200 shares is 43.0¢/share.
  function centsPerShare(pnlAfterComm, shares) {
    const cents = (pnlAfterComm / shares) * 100;
    const sign = cents >= 0 ? "+" : "-";
    return sign + Math.abs(cents).toFixed(1) + "¢";
  }
  function toUnix(t) {
    return Math.floor(new Date(t.replace(" ", "T") + "").getTime() / 1000);
  }
  // Compact share-count formatting for the About card -- 18,500,000 -> "18.5M".
  function fmtShares(n) {
    if (n === null || n === undefined) return null;
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return String(v);
  }
  const TAG_LABELS = {
    avgvol_under_500k: "Avg vol < 500K", avgvol_500k_1m: "Avg vol 500K–1M",
    avgvol_1m_5m: "Avg vol 1M–5M", avgvol_5m_20m: "Avg vol 5M–20M", avgvol_20m_plus: "Avg vol 20M+",
    rvol_under_1x: "RVol < 1x", rvol_1x_2x: "RVol 1x–2x", rvol_2x_5x: "RVol 2x–5x",
    rvol_5x_10x: "RVol 5x–10x", rvol_10x_plus: "RVol 10x+",
    float_micro_under_10m: "Float < 10M", float_low_10m_20m: "Float 10M–20M",
    float_mid_20m_50m: "Float 20M–50M", float_large_50m_200m: "Float 50M–200M", float_mega_200m_plus: "Float 200M+",
  };
  function tagLabel(tag) {
    return TAG_LABELS[tag] || String(tag).replace(/_/g, " ");
  }

  function siblingNav(trade, siblings) {
    if (!Array.isArray(siblings) || !siblings.length) return "";
    const key = (t) => (t.trade_date || "") + (t.entry_time || "");
    const idx = siblings.findIndex((r) => r.id === trade.id);
    const prev = idx > 0 ? siblings[idx - 1] : null;
    const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
    const link = (row, label, dir) =>
      row
        ? `<a href="trade.html?id=${encodeURIComponent(row.id)}" class="trade-nav-link" style="color:#8b98a5; text-decoration:none; font-size:12.5px; display:flex; align-items:center; gap:4px;">${dir === "prev" ? "←" : ""}${escapeHtml(label)}${dir === "next" ? "→" : ""}</a>`
        : `<span style="color:#3a4149; font-size:12.5px;">${dir === "prev" ? "←" : ""}${escapeHtml(label)}${dir === "next" ? "→" : ""}</span>`;
    return `<div class="trade-sibling-nav" style="display:flex; justify-content:space-between; margin-bottom:10px;">
      ${link(prev, prev ? `${prev.symbol} · ${prev.trade_date}` : "No earlier trade", "prev")}
      ${link(next, next ? `${next.symbol} · ${next.trade_date}` : "No later trade", "next")}
    </div>`;
  }

  function renderTrade(trade, siblings) {
    document.title = `${trade.symbol} — trade.log`;
    const win = trade.win;

    content.innerHTML = `
      ${siblingNav(trade, siblings || [])}
      <div class="trade-head">
        <h1>
          ${trade.symbol}
          <span class="verdict-badge ${win ? "up" : "down"}">${win ? "WIN" : "LOSS"} · ${fmtMoney(trade.pnl_after_comm)}</span>
        </h1>
        <div class="trade-meta">
          ${trade.trade_date} &nbsp;·&nbsp; entry ${trade.entry_time} @ $${trade.entry_price.toFixed(2)}
          &nbsp;→&nbsp; exit ${trade.exit_time} @ $${trade.exit_price.toFixed(2)}
          &nbsp;·&nbsp; <span class="meta-standout">${trade.shares} sh</span> &nbsp;·&nbsp; held <span class="meta-standout">${trade.time_in_trade || "—"}</span>
        </div>
        <div class="trade-meta" style="margin-top:6px; display:flex; align-items:center; gap:8px;" id="grade-row">
          <span style="color:var(--text-faint); font-size:12px;">Execution grade</span>
          <span id="grade-widget">${window.TradeGrade ? window.TradeGrade.starsHtml(window.TradeGrade.get(trade), { interactive: true, size: 16 }) : ""}</span>
          <span id="grade-label" style="color:var(--text-faint); font-size:11.5px;"></span>
        </div>
      </div>

      <div class="pnl-breakdown">
        <div class="cell">
          <div class="label">Gross P&amp;L</div>
          <div class="value ${trade.pnl_before_comm >= 0 ? "up" : "down"}">${fmtMoney(trade.pnl_before_comm)}</div>
        </div>
        <div class="cell">
          <div class="label">Commission</div>
          <div class="value">-$${trade.commission.toFixed(2)}</div>
        </div>
        <div class="cell">
          <div class="label">Net P&amp;L</div>
          <div class="value ${trade.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(trade.pnl_after_comm)}</div>
        </div>
        <div class="cell">
          <div class="label">Shares</div>
          <div class="value">${trade.shares != null ? trade.shares.toLocaleString() : "—"}</div>
        </div>
        <div class="cell">
          <div class="label">&cent;/Share</div>
          <div class="value ${trade.pnl_after_comm >= 0 ? "up" : "down"}">${trade.shares ? centsPerShare(trade.pnl_after_comm, trade.shares) : "—"}</div>
        </div>
      </div>

      <div class="chart-panel">
        <div class="chart-toolbar">
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#e8a94c"></span>VWAP</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#9aa8a1"></span>EMA9</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#5b93f0"></span>EMA20</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#2fd08a"></span>entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#f2555a"></span>exit</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#8b7cf6"></span>better entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#ec6cad"></span>better exit</span>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <span>Scroll to zoom · drag to pan</span>
            <a class="icon-btn icon-btn-visible" id="replay-btn" title="Rewind this trade" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px; text-decoration:none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              Rewind
            </a>
            <a class="icon-btn icon-btn-visible" id="practice-btn" title="Practice trading this symbol" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px; text-decoration:none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              Practice
            </a>
            <button class="icon-btn icon-btn-visible" id="export-chart-btn" title="Export chart as PNG" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              PNG
            </button>
          </div>
        </div>
        <div id="candle-chart"></div>
        <div id="macd-chart"></div>
      </div>

      <div class="detail-grid">
        <div class="card">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
            <h2 style="margin:0;">Verdict</h2>
            <button class="icon-btn icon-btn-visible" id="copy-verdict-btn" title="Copy verdict text" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span id="copy-verdict-label">Copy</span>
            </button>
          </div>
          <div class="verdict-text">${escapeHtml(trade.verdict || "No verdict recorded.")}</div>
          ${trade.setup_type ? `<span class="setup-tag">${escapeHtml(trade.setup_type)}</span>` : ""}
          ${rrStrip(trade)}
          ${trade.walk_away_rule ? `<div class="walk-away"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}
        </div>
        <div class="card better-card" style="padding:14px 16px;">
          <h2 style="font-size:12.5px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.03em; opacity:.75;">What you should've done</h2>
          ${betterRow("Entry", trade.better_entry)}
          ${betterRow("Exit", trade.better_exit)}
          ${!trade.better_entry && !trade.better_exit ? `<div class="no-better" style="font-size:12px; opacity:.7;">No better entry/exit flagged — this trade lined up with the plan.</div>` : ""}
        </div>

        <div class="card">
          <h2>Lessons from this trade</h2>
          ${Array.isArray(trade.lessons) && trade.lessons.length
            ? `<ul class="lessons-list" style="margin:0; padding-left:18px;">${trade.lessons.map((l) => lessonItem(l)).join("")}</ul>`
            : `<div class="no-better">No lessons recorded for this trade.</div>`}
        </div>

        ${trade.symbol_info && (trade.symbol_info.name || trade.symbol_info.description) ? `
        <div class="card symbol-card" style="grid-column: 1 / -1;">
          <h2>About ${escapeHtml(trade.symbol)}</h2>
          <div class="sym-head"><span class="sym-name">${escapeHtml(trade.symbol_info.name || trade.symbol)}</span></div>
          <div class="sym-meta-row">
            ${trade.symbol_info.country ? `<span class="pill">${escapeHtml(trade.symbol_info.country)}</span>` : ""}
            ${trade.symbol_info.sector ? `<span class="pill">${escapeHtml(trade.symbol_info.sector)}</span>` : ""}
            ${volumeFloatPills(trade)}
          </div>
          <div class="sym-desc">${escapeHtml(trade.symbol_info.description || "")}</div>
        </div>` : ""}

        <div class="card sr-box" style="grid-column: 1 / -1;">
          <div class="sr-head">
            <div>
              <h2 style="margin:0;">Support &amp; Resistance</h2>
              <div class="sr-sub">Reads this symbol's prior daily bars (before this trade) and draws support/resistance lines on the chart above. Off by default — runs only when you click, so it never spends API tokens on its own.</div>
            </div>
            <button class="sr-run-btn" id="sr-run-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M18.4 8.6 12 15l-3-3-4 4"></path></svg>
              Analyze support/resistance
            </button>
          </div>
          <div id="sr-result"></div>
        </div>
      </div>
    `;

    buildCharts(trade);

    // Self-graded execution quality (1-5 stars, separate from win/loss --
    // see grade.js). Persists to localStorage immediately on click; the
    // small label next to the stars just echoes what was picked so it
    // isn't purely a hover tooltip.
    const gradeRow = document.getElementById("grade-row");
    if (gradeRow && window.TradeGrade) {
      const gradeLabelEl = document.getElementById("grade-label");
      const current = window.TradeGrade.get(trade);
      const paintLabel = (g) => { gradeLabelEl.textContent = g ? window.TradeGrade.label(g) : "Not graded — click a star"; };
      paintLabel(current);
      window.TradeGrade.attachInteractive(gradeRow, trade.id, current, (next) => {
        trade.grade = next; // keep in sync for this render (siblingNav/etc. don't read it, but future code might)
        paintLabel(next);
      });
    }

    const copyBtn = document.getElementById("copy-verdict-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const label = document.getElementById("copy-verdict-label");
        const text = trade.verdict || "";
        const done = () => { label.textContent = "Copied!"; setTimeout(() => (label.textContent = "Copy"), 1500); };
        const fail = () => { label.textContent = "Couldn't copy"; setTimeout(() => (label.textContent = "Copy"), 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fail);
        } else {
          // Fallback for browsers without the async Clipboard API.
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (e) { fail(); }
          document.body.removeChild(ta);
        }
      });
    }

    const srBtn = document.getElementById("sr-run-btn");
    if (srBtn) {
      srBtn.addEventListener("click", () => runSupportResistance(trade, srBtn));
    }
  }

  // Manual, on-demand only -- fires the SR_ANALYSIS_URL webhook, which
  // reads the symbol's prior daily bars and (optionally) an LLM call to
  // pick out support/resistance levels. Nothing here runs unless the
  // person clicks the button, so a page view alone never costs an API call.
  let srRequestInFlight = false;
  function runSupportResistance(trade, btn) {
    if (srRequestInFlight) return;
    srRequestInFlight = true;
    const resultEl = document.getElementById("sr-result");
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Analyzing…";
    resultEl.innerHTML = `<div class="sr-status">Reading ${escapeHtml(trade.symbol)}'s prior daily bars and computing levels — this calls out to n8n, so it can take a few seconds…</div>`;

    fetch(SR_ANALYSIS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: trade.symbol, trade_date: trade.trade_date, lookback_days: 40 }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        renderSrResult(data);
        drawSrLevelsOnChart(data);
      })
      .catch((err) => {
        resultEl.innerHTML = `<div class="sr-status error">Couldn't get support/resistance levels (${escapeHtml(String(err.message))}). If SR_ANALYSIS_URL at the top of trade.js still says YOUR-N8N-SUBDOMAIN, point it at your own n8n webhook first.</div>`;
      })
      .finally(() => {
        srRequestInFlight = false;
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      });
  }

  // Shared with drawSrLevelsOnChart so the on-chart label matches the
  // "from" text shown in the card below (e.g. "3x touched", or whatever
  // label the LLM/webhook gave the level).
  function srLevelNote(lv) {
    return lv.label || (lv.touches ? lv.touches + "x touched" : "");
  }

  // The LLM-authored label can be a full sentence ("Tested three times
  // and lines up with the 50-day MA..."), which is fine in the sr-result
  // list below but overwhelms the chart's price-line tag. Keep the tag
  // to a short phrase and let the full text live in the list instead.
  function srChartTag(lv) {
    const note = srLevelNote(lv);
    if (!note) return "";
    const cut = note.split(/[.;,]/)[0].trim();
    const words = cut.split(/\s+/);
    let short = words.slice(0, 5).join(" ");
    if (words.length > 5 || short.length < cut.length) short += "…";
    return short.length > 28 ? short.slice(0, 27).trim() + "…" : short;
  }

  function renderSrResult(data) {
    const resultEl = document.getElementById("sr-result");
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    if (!support.length && !resistance.length) {
      resultEl.innerHTML = `<div class="sr-status">No clear levels came back for this symbol.</div>`;
      return;
    }
    const levelRow = (lv) => `<div class="lvl-row"><span>$${Number(lv.price).toFixed(2)}</span><span class="note">${escapeHtml(srLevelNote(lv))}</span></div>`;
    resultEl.innerHTML = `
      ${data.summary ? `<div class="sr-summary">${escapeHtml(data.summary)}</div>` : ""}
      <div class="sr-levels">
        <div class="col">
          <div class="col-label resistance">Resistance</div>
          ${resistance.length ? resistance.map(levelRow).join("") : `<div class="lvl-row"><span class="note">None found</span></div>`}
        </div>
        <div class="col">
          <div class="col-label support">Support</div>
          ${support.length ? support.map(levelRow).join("") : `<div class="lvl-row"><span class="note">None found</span></div>`}
        </div>
      </div>
      ${data.source === "computed_fallback" ? `<div class="sr-status">Showing computer-detected pivot levels (the level read didn't come back cleanly).</div>` : ""}
    `;
  }

  // Drawn as solid price lines on the same candlestick series used for the
  // entry/exit/better-entry markers, distinct colors from those (green/red
  // dashed = actual fills, purple/pink dotted = LLM's better fill) so all
  // four line types stay visually distinguishable on one chart.
  function drawSrLevelsOnChart(data) {
    if (!srCandleSeries) return;
    // Clear whatever this function drew last time before adding the new
    // batch -- see the note on srPriceLines above -- so re-running the
    // analysis replaces the lines instead of stacking a duplicate set on
    // top of them.
    srPriceLines.forEach((line) => srCandleSeries.removePriceLine(line));
    srPriceLines = [];
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    resistance.forEach((lv) => {
      const tag = srChartTag(lv);
      srPriceLines.push(srCandleSeries.createPriceLine({
        price: Number(lv.price), color: "#f2555a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, lineVisible: false,
        title: tag ? `resistance (${tag})` : "resistance",
      }));
    });
    support.forEach((lv) => {
      const tag = srChartTag(lv);
      srPriceLines.push(srCandleSeries.createPriceLine({
        price: Number(lv.price), color: "#2fd08a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, lineVisible: false,
        title: tag ? `support (${tag})` : "support",
      }));
    });
  }

  function rrStrip(trade) {
    if (!trade.suggested_stop && !trade.suggested_target && !trade.risk_reward) return "";
    return `<div class="rr-strip">
      ${trade.suggested_stop ? `<span><span class="k">Stop</span><span class="v down">$${Number(trade.suggested_stop).toFixed(2)}</span></span>` : ""}
      ${trade.suggested_target ? `<span><span class="k">Target</span><span class="v up">$${Number(trade.suggested_target).toFixed(2)}</span></span>` : ""}
      ${trade.risk_reward ? `<span><span class="k">R:R</span><span class="v">${escapeHtml(trade.risk_reward)}</span></span>` : ""}
    </div>`;
  }

  function betterRow(label, b) {
    if (!b || !b.price) return "";
    const how = b.how_to_know
      ? `<div class="how-to-know" style="font-size:11px; opacity:.65; margin-top:2px;">How you'd know: ${escapeHtml(b.how_to_know)}</div>`
      : "";
    return `<div class="better-row" style="display:flex; gap:10px; align-items:baseline; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06);">
      <div class="tag" style="font-size:10px; font-weight:700; letter-spacing:.03em; opacity:.65; min-width:38px; flex-shrink:0;">${label.toUpperCase()}</div>
      <div class="content" style="flex:1; min-width:0;">
        <div class="price-line" style="font-size:12.5px; font-weight:600;">$${Number(b.price).toFixed(2)}${b.time ? ` @ ${escapeHtml(String(b.time).split("T").pop())}` : ""}</div>
        ${b.reason ? `<div class="reason" style="font-size:11.5px; opacity:.75; margin-top:1px;">${escapeHtml(b.reason)}</div>` : ""}
        ${how}
      </div>
    </div>`;
  }

  // Float / avg-volume / relative-volume pills for the About card. Reads
  // from trade.indicators (see chart_service.py compute_volume_float_stats
  // -- these fields land there via /generate-chart, not on a separate
  // top-level key) and shows raw numbers alongside the bucketed tag label.
  function volumeFloatPills(trade) {
    const ind = trade.indicators || {};
    const parts = [];
    if (ind.float_shares) {
      parts.push(`<span class="pill floattag" title="Shares outstanding (float proxy)">Float ${fmtShares(ind.float_shares)}</span>`);
    }
    if (ind.avg_volume_30d) {
      parts.push(`<span class="pill avgvol" title="30-day average daily volume">Avg vol ${fmtShares(ind.avg_volume_30d)}</span>`);
    }
    if (typeof ind.relative_volume === "number") {
      parts.push(`<span class="pill rvol" title="Entry-day volume vs. 30-day average">RVol ${ind.relative_volume.toFixed(2)}x</span>`);
    }
    return parts.join("\n");
  }

  function lessonItem(l) {
    if (typeof l === "string") {
      // Lessons occasionally round-trip through a text column as a raw
      // JSON string instead of an object (e.g. a stringified array
      // element) -- parse it back into one so it renders the same as
      // any other lesson instead of dumping raw JSON text on the page.
      try {
        const parsed = JSON.parse(l);
        if (parsed && typeof parsed === "object") l = parsed;
      } catch (e) { /* genuinely plain text -- fall through below */ }
    }
    if (typeof l === "string") return `<li style="margin-bottom:6px; font-size:12.5px;">${escapeHtml(l)}</li>`;
    const how = l.how_to_know
      ? `<div style="font-size:11px; opacity:.65; margin-top:2px;">How you'd know: ${escapeHtml(l.how_to_know)}</div>`
      : "";
    const tagBadge = l.tag
      ? `<span class="lesson-tag" style="display:inline-block; font-size:10px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; padding:1px 6px; border-radius:3px; background:rgba(91,147,240,.15); color:#5b93f0; margin-left:6px; vertical-align:middle;">${escapeHtml(String(l.tag).replace(/_/g, " "))}</span>`
      : "";
    return `<li style="margin-bottom:8px; font-size:12.5px;">${escapeHtml(l.lesson || l.text || "")}${tagBadge}${how}</li>`;
  }

  function buildCharts(trade) {
    const bars = trade.bars;
    const candleData = bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volData = bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" }));
    const vwapData = bars.map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema20 }));
    const macdData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd }));
    const signalData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_signal }));
    const histData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_hist, color: b.macd_hist >= 0 ? "#2fd08a" : "#f2555a" }));

    const candleEl = document.getElementById("candle-chart");
    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      // minimumWidth guarantees room for the widest axis label we ever put
      // up -- "better entry" / "better exit" plus the price -- so those
      // price-line titles render in full instead of being squeezed by an
      // axis width that would otherwise auto-size to shorter labels like
      // the plain numeric entry/exit prices.
      rightPriceScale: { borderColor: "#232830", minimumWidth: 92 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const candleChart = LightweightCharts.createChart(candleEl, { ...commonOpts, width: candleEl.clientWidth, height: 420 });

    const candleSeries = candleChart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
      // Lightweight Charts draws its own dashed "last value" price line on
      // every series by default, colored to match the most recent
      // candle (green/red). Left on, it shows up as a stray dashed line
      // at whatever price the last bar happened to close at -- easy to
      // mistake for one of our own entry/exit/S-R lines. We draw all of
      // those explicitly (see createPriceLine calls below), so the
      // built-in one is redundant and just noise; turn it off.
      priceLineVisible: false,
    });
    candleSeries.setData(candleData);
    srCandleSeries = candleSeries;

    // The right price scale autoscales to candle highs/lows only. As you
    // zoom in, the visible range tightens around just the candles in view,
    // and the entry/exit pointer markers (drawn a fixed pixel offset off
    // their exact fill price) can end up right at the pane edge. Reserving
    // extra top/bottom margin gives them permanent headroom so they're
    // never fighting the autoscale for room, at any zoom level.
    candleChart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.14, bottom: 0.18 },
    });

    const volSeries = candleChart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    candleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(volData);

    candleChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    candleChart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    candleChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    // Find the candle a marker's timestamp falls ON, so we can compare the
    // fill price against THAT candle's actual high/low instead of guessing
    // position from the role (entry vs exit).
    //
    // Bars are 1-minute candles labeled by their START time (e.g. "09:59:00"
    // covers 09:59:00-09:59:59). Fill times carry seconds ("09:59:48"). A
    // *nearest*-by-absolute-diff match picks whichever bar boundary is
    // numerically closest -- for anything in the second half of the minute
    // (:31-:59) that's the START of the NEXT bar, not the one the fill
    // actually happened in. Floor-matching (last bar whose start time is
    // <= the fill time) is the correct rule for start-labeled bars.
    function barAt(unixTime) {
      let best = bars[0];
      for (const b of bars) {
        if (toUnix(b.t) <= unixTime) best = b;
        else break;
      }
      return best;
    }

    // better_entry.time / better_exit.time come from the LLM verdict step
    // and, unlike entry_time/exit_time, are never guaranteed to include a
    // date -- most of the time they're just "HH:MM:SS". Handing a bare time
    // straight to toUnix()/new Date() either parses as Invalid Date (NaN),
    // which makes barAt() silently fall through its whole loop and return
    // bars[0] -- the FIRST candle on the chart, regardless of when the
    // trade actually happened -- or, in engines that accept a bare time,
    // resolves it against *today's* date instead of the trade's date,
    // landing it off the visible range entirely. Either way the dotted
    // price line (which only depends on price) looks right while the
    // pointer (which depends on this) ends up nowhere near it. Detect a
    // bare time (no "YYYY-MM-DD" in it) and explicitly prepend the trade's
    // own date before parsing, so it always resolves against the right day.
    function betterUnix(timeStr) {
      if (!timeStr) return NaN;
      const hasDate = /\d{4}-\d{2}-\d{2}/.test(timeStr);
      return toUnix(hasDate ? timeStr : `${trade.trade_date} ${timeStr}`);
    }

    // The LLM's suggested time and suggested price are two independent
    // guesses, and they don't always agree with each other: it can name a
    // real minute that resolves to a real candle (so betterUnix/barAt above
    // both succeed) while the *price* it gave was never actually touched
    // in that candle -- the wick doesn't reach it. The pointer still lands
    // on a legitimate candle, just the wrong one: the dotted price line
    // keeps pointing at where that price really traded, while the pointer
    // sits one or more minutes off from it. Cross-check the two: if the
    // price isn't within [low, high] of the time-based candle, search
    // outward in both directions (by bar index, i.e. by time) for the
    // nearest candle whose range actually contains that price, and use
    // that instead -- so the pointer always lands on "the one the line
    // means" rather than wherever the LLM said. If literally no candle in
    // the session touched that price, there's nothing better to snap to,
    // so the time-based candle is kept as the closest available guess.
    function barForPrice(price, candidateBar) {
      const within = (b) => price <= b.h + 1e-6 && price >= b.l - 1e-6;
      if (within(candidateBar)) return candidateBar;
      const idx = bars.indexOf(candidateBar);
      for (let d = 1; d < bars.length; d++) {
        const before = bars[idx - d];
        const after = bars[idx + d];
        if (before && within(before)) return before;
        if (after && within(after)) return after;
        if (!before && !after) break;
      }
      return candidateBar;
    }

    // Small, clear pointer markers instead of a label box + connector stem
    // + full-width dashed price line: just a tiny triangle sitting right on
    // the exact fill point, pointing straight at it. Nothing else on the
    // chart competes with it for attention, and it never gets orphaned from
    // its own price line the way the old label system could.
    //
    // The pointer itself owns its tooltip -- a styled box (not the native
    // title attribute, which can't be styled and is easy to misread as
    // "cut off" since it wraps awkwardly at narrow widths) showing the
    // FULL price/time plus, for "better" markers, the full reason +
    // how_to_know text -- nothing truncated, so nothing has to be crammed
    // into the short on-chart tag. It opens on hover for mouse users and on
    // tap for touch users (hover doesn't fire on touchscreens), so there's
    // no separate "i" badge competing for space on the chart.
    //
    // Appended to `wrap` directly (not the pointer overlay, which clips its
    // contents to the chart's bounds via overflow:hidden) so the tooltip is
    // never cut off at the pane edge.
    function buildPointer(tooltipHtml, color) {
      const wrap = candleEl;
      wrap.style.position = "relative";
      let overlay = wrap.querySelector(".fill-pointer-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "fill-pointer-overlay";
        overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2;";
        wrap.appendChild(overlay);
      }
      const el = document.createElement("div");
      el.style.cssText = `
        position:absolute; width:0; height:0; pointer-events:auto;
        border-left:6px solid transparent; border-right:6px solid transparent;
        filter: drop-shadow(0 0 1.5px #0b0d10) drop-shadow(0 0 1.5px #0b0d10);
      `;
      overlay.appendChild(el);

      let tooltip = null;
      if (tooltipHtml) {
        tooltip = document.createElement("div");
        tooltip.className = "pointer-tooltip";
        tooltip.dataset.open = "0";
        tooltip.style.cssText = `
          position:absolute; display:none; width:220px; max-width:60vw;
          background:#181b22; border:1px solid ${color}; border-radius:8px;
          padding:10px 12px; font-size:12px; line-height:1.5; color:#eceef2;
          box-shadow:0 6px 20px rgba(0,0,0,.45); z-index:5; pointer-events:none;
        `;
        tooltip.innerHTML = tooltipHtml;
        wrap.appendChild(tooltip);

        const openTooltip = () => {
          wrap.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
          tooltip.dataset.open = "1";
          tooltip.style.display = "block";
          repositionPointers();
        };
        const closeTooltip = () => { tooltip.dataset.open = "0"; tooltip.style.display = "none"; };
        el.addEventListener("mouseenter", openTooltip);
        el.addEventListener("mouseleave", closeTooltip);
        // Tap-to-toggle so touch users (no mouseenter) can still reach it.
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tooltip.dataset.open === "1") closeTooltip(); else openTooltip();
        });
      }
      return { el, tooltip };
    }

    // Any click outside a pointer tooltip closes whichever one is pinned
    // open -- otherwise a tapped-open tooltip would just sit there covering
    // the chart. (Hover-opened tooltips already close on mouseleave.)
    document.addEventListener("click", () => {
      candleEl.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
    });

    const POINTER_H = 9; // triangle height in px -- also used to correct the tip offset in repositionPointers()

    const entryBar = barAt(toUnix(`${trade.trade_date} ${trade.entry_time}`));
    const exitBar = barAt(toUnix(`${trade.trade_date} ${trade.exit_time}`));

    // Chart-only tooltip content: marker + price + the how_to_know signal,
    // in full -- nothing truncated. This mirrors the older version of this
    // file -- the chart shows *why* to act (the observable signal), while
    // the "What you should've done" card (betterRow) carries the full
    // reason + how_to_know prose too. Using how_to_know here (not reason)
    // is what keeps the chart's wording genuinely different from the
    // card's, rather than a shorter copy of it. Returns HTML (escaped)
    // since it's dropped straight into the tooltip's innerHTML.
    function tooltipHtml(head, signal) {
      const headLine = `<div style="font-weight:700;${signal ? " margin-bottom:4px;" : ""}">${escapeHtml(head)}</div>`;
      return headLine + (signal ? `<div>${escapeHtml(signal)}</div>` : "");
    }

    function betterTooltip(kind, b) {
      return tooltipHtml(`better ${kind} $${Number(b.price).toFixed(2)}`, b.how_to_know || "");
    }

    // Same idea as betterTooltip, but for the ACTUAL fill: marker + price +
    // the entry_indicator/exit_indicator signal -- what was actually
    // visible in real time that justified acting at this price, not the
    // hypothetical better one.
    function actualTooltip(kind, price, indicator) {
      return tooltipHtml(`${kind.toUpperCase()} $${price.toFixed(2)}`, indicator || "");
    }

    const ACTUAL_ENTRY_COLOR = "#2fd08a"; // green, matches the entry pointer/legend
    const ACTUAL_EXIT_COLOR = "#f2555a"; // red, matches the exit pointer/legend

    // buildPointer returns { el, tooltip } -- el is the triangle marker,
    // tooltip is its hover/tap popup (null if there's no text to show).
    // mkPointer flattens that into one entry for the `pointers` array,
    // which repositionPointers() below reads by both el and tooltip.
    function mkPointer(time, price, color, above, tooltipHtmlText) {
      const { el, tooltip } = buildPointer(tooltipHtmlText, color);
      return { time, price, color, above, el, tooltip };
    }

    const pointers = [
      // Entry: triangle sits just above the fill, tip pointing down onto it.
      mkPointer(toUnix(entryBar.t), trade.entry_price, ACTUAL_ENTRY_COLOR, true,
        actualTooltip("entry", trade.entry_price, trade.entry_indicator)),
      // Exit: triangle sits just below the fill, tip pointing up onto it.
      mkPointer(toUnix(exitBar.t), trade.exit_price, ACTUAL_EXIT_COLOR, false,
        actualTooltip("exit", trade.exit_price, trade.exit_indicator)),
    ];
    // Better entry/exit get their own pointers, in colors that match their
    // legend swatches and dotted price lines below -- so color alone ties a
    // triangle to the right line without reading labels. These are their
    // own distinct hues (purple / pink) rather than a faded green/red, so a
    // "better" pointer never reads as just a dimmer copy of the actual
    // entry/exit pointer -- the two are unmistakably different markers even
    // at a glance. Each snaps to the bar its own suggested time falls on
    // (falling back to the actual entry/exit bar if no time was given)
    // rather than reusing the actual fill's x-position.
    const BETTER_ENTRY_COLOR = "#8b7cf6"; // purple
    const BETTER_EXIT_COLOR = "#ec6cad"; // pink

    if (trade.better_entry && trade.better_entry.price) {
      const b = trade.better_entry;
      const u = betterUnix(b.time);
      const bar = barForPrice(Number(b.price), Number.isFinite(u) ? barAt(u) : entryBar);
      pointers.push(mkPointer(toUnix(bar.t), Number(b.price), BETTER_ENTRY_COLOR, true, betterTooltip("entry", b)));
    }
    if (trade.better_exit && trade.better_exit.price) {
      const b = trade.better_exit;
      const u = betterUnix(b.time);
      const bar = barForPrice(Number(b.price), Number.isFinite(u) ? barAt(u) : exitBar);
      pointers.push(mkPointer(toUnix(bar.t), Number(b.price), BETTER_EXIT_COLOR, false, betterTooltip("exit", b)));
    }

    // A zero-size div with only border-bottom set renders a triangle whose
    // TIP sits at the box's OWN top edge, with the flat BASE extending
    // downward (by POINTER_H) from there; border-top-only is the mirror
    // image -- its tip sits POINTER_H *below* its own top edge, with the
    // base at the top. So "below" markers (border-bottom, tip pointing up)
    // can have their top set to the price-y directly, but "above" markers
    // (border-top, tip pointing down) need their top shifted up by
    // POINTER_H first, or the price ends up at the flat base instead of the
    // tip. See repositionPointers() below, which applies that shift.
    pointers.forEach((p) => {
      p.el.style.borderTop = p.above ? `${POINTER_H}px solid ${p.color}` : "";
      p.el.style.borderBottom = p.above ? "" : `${POINTER_H}px solid ${p.color}`;
    });

    function repositionPointers() {
      pointers.forEach((p) => {
        const x = candleChart.timeScale().timeToCoordinate(p.time);
        const y = candleSeries.priceToCoordinate(p.price);
        if (x === null || y === null) {
          p.el.style.display = "none";
          if (p.tooltip) { p.tooltip.style.display = "none"; p.tooltip.dataset.open = "0"; }
          return;
        }
        p.el.style.display = "block";
        p.el.style.left = `${x}px`;
        // "above" markers (border-top) have their tip POINTER_H below their
        // own top edge, so shift up by POINTER_H to land the tip -- not the
        // base -- on the price. "below" markers (border-bottom) already
        // have their tip at their own top edge, so no shift is needed.
        const pointerTop = p.above ? y - POINTER_H : y;
        p.el.style.top = `${pointerTop}px`;
        p.el.style.transform = "translateX(-50%)";
        // The tooltip only needs positioning while it's actually open --
        // offset to the side of the triangle (above-left for "above"
        // markers, below-left for "below" ones) so it never sits on top of
        // the marker it belongs to.
        if (p.tooltip && p.tooltip.dataset.open === "1") {
          p.tooltip.style.left = `${x + 8}px`;
          p.tooltip.style.top = `${p.above ? pointerTop - 8 : pointerTop + POINTER_H + 8}px`;
          p.tooltip.style.transform = p.above ? "translateY(-100%)" : "none";
        }
      });
    }

    candleChart.timeScale().subscribeVisibleLogicalRangeChange(repositionPointers);
    window.addEventListener("resize", repositionPointers);
    // priceToCoordinate depends on the right price scale's own autoscale,
    // which isn't settled until after setData/fitContent run -- a couple
    // of follow-up passes catch that instead of racing it.
    repositionPointers();
    requestAnimationFrame(repositionPointers);
    setTimeout(repositionPointers, 0);

    candleSeries.createPriceLine({
      price: trade.entry_price,
      color: "#2fd08a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lineVisible: false,
      axisLabelVisible: true,
      title: "",
    });
    candleSeries.createPriceLine({
      price: trade.exit_price,
      color: "#f2555a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lineVisible: false,
      axisLabelVisible: true,
      title: "",
    });

    // Dotted lines for the LLM's suggested better entry/exit, in the same
    // purple/pink as their pointers above -- distinct from the actual
    // entry/exit green/red so the two pairs never get confused. The axis
    // label stays a short, static "better entry"/"better exit" tag,
    // lowercase to match the legend -- the full how_to_know signal lives on
    // the pointer's own hover/tap tooltip instead (see betterTooltip
    // above), and the full reason + how_to_know text also lives in the
    // "What you should've done" card.
    if (trade.better_entry && trade.better_entry.price) {
      candleSeries.createPriceLine({
        price: Number(trade.better_entry.price),
        color: BETTER_ENTRY_COLOR,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        lineVisible: false,
        axisLabelVisible: true,
        title: "better entry",
      });
    }
    if (trade.better_exit && trade.better_exit.price) {
      candleSeries.createPriceLine({
        price: Number(trade.better_exit.price),
        color: BETTER_EXIT_COLOR,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        lineVisible: false,
        axisLabelVisible: true,
        title: "better exit",
      });
    }

    // "Rewind" (renamed from "Replay" to match where it actually goes) sends
    // this trade over to the Rewind page's own replay/practice experience
    // instead of duplicating a second, page-local scrub player here -- one
    // replay implementation instead of two slightly-different ones to keep
    // in sync. "Practice" is the same ?trade= deep-link convention, pointed
    // at the Practice page instead, so you can go straight from reviewing a
    // trade to trading that same chart live.
    const replayBtn = document.getElementById("replay-btn");
    if (replayBtn) replayBtn.href = `rewind.html?trade=${encodeURIComponent(trade.id)}`;
    const practiceBtn = document.getElementById("practice-btn");
    if (practiceBtn) practiceBtn.href = `practice.html?trade=${encodeURIComponent(trade.id)}`;

    const macdEl = document.getElementById("macd-chart");
    const macdChart = LightweightCharts.createChart(macdEl, { ...commonOpts, width: macdEl.clientWidth, height: 110 });
    macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 3 } }).setData(histData);
    macdChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(macdData);
    macdChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(signalData);

    candleChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range) macdChart.timeScale().setVisibleLogicalRange(range); });
    macdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range) candleChart.timeScale().setVisibleLogicalRange(range); });

    candleChart.timeScale().fitContent();
    macdChart.timeScale().fitContent();

    window.addEventListener("resize", () => {
      candleChart.applyOptions({ width: candleEl.clientWidth });
      macdChart.applyOptions({ width: macdEl.clientWidth });
    });

    const exportBtn = document.getElementById("export-chart-btn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        // takeScreenshot() renders the chart's current view (whatever
        // zoom/pan the user has it at) to a canvas -- export what they're
        // actually looking at, not a fixed default view.
        const canvas = candleChart.takeScreenshot();
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${trade.symbol}-${trade.trade_date}-${(trade.id || "chart")}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
      });
    }
  }
})();
