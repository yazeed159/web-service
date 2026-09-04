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
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    resistance.forEach((lv) => {
      const tag = srChartTag(lv);
      srCandleSeries.createPriceLine({
        price: Number(lv.price), color: "#f2555a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true,
        title: tag ? `resistance (${tag})` : "resistance",
      });
    });
    support.forEach((lv) => {
      const tag = srChartTag(lv);
      srCandleSeries.createPriceLine({
        price: Number(lv.price), color: "#2fd08a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true,
        title: tag ? `support (${tag})` : "support",
      });
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
      // up -- the support/resistance price-line tags (see srChartTag) can
      // run up to ~28 characters, so give the axis enough width for those
      // to render in full instead of being squeezed down to short numeric
      // labels only.
      rightPriceScale: { borderColor: "#232830", minimumWidth: 92 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const candleChart = LightweightCharts.createChart(candleEl, { ...commonOpts, width: candleEl.clientWidth, height: 420 });

    const candleSeries = candleChart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    candleSeries.setData(candleData);
    srCandleSeries = candleSeries;

    // Extra top/bottom margin so the candles never butt right up against
    // the pane edge at any zoom level.
    candleChart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.14, bottom: 0.18 },
    });

    const volSeries = candleChart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    candleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(volData);

    candleChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    candleChart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    candleChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    // "Rewind" (renamed from "Replay" to match where it actually goes)
    // sends this trade over to the Rewind page's own replay/practice
    // experience instead of duplicating a second, page-local scrub
    // player here -- one replay implementation instead of two slightly-
    // different ones to keep in sync. "Practice" is the same ?trade=
    // deep-link convention, pointed at the Practice page instead, so
    // you can go straight from reviewing a trade to trading that same
    // chart live.
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
