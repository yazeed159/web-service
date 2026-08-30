(function () {
  "use strict";

  // ==================================================================
  // Chart-reading quiz built entirely from data/trades.json +
  // data/trades/<id>.json — the same files journal.html/trade.html
  // already read. No backend, no chart_service.py call: every bar,
  // indicator, and lesson used here was already published for that
  // trade, so the quiz just crops what's shown and asks about it
  // before letting you see the rest.
  // ==================================================================

  const HISTORY_KEY = "quiz:history";
  const HISTORY_MAX = 50;

  const els = {
    setupScreen: document.getElementById("quiz-setup-screen"),
    playScreen: document.getElementById("quiz-play-screen"),
    summaryScreen: document.getElementById("quiz-summary-screen"),
    setupSelect: document.getElementById("qf-setup"),
    resultSelect: document.getElementById("qf-result"),
    countRow: document.getElementById("qf-count-row"),
    blindCheck: document.getElementById("qf-blind"),
    candidateCount: document.getElementById("qf-candidate-count"),
    startBtn: document.getElementById("qf-start-btn"),
    historyBox: document.getElementById("quiz-history-box"),
    focusBox: document.getElementById("quiz-focus-box"),
    progressLabel: document.getElementById("qp-progress-label"),
    progressFill: document.getElementById("qp-progress-fill"),
    scoreChip: document.getElementById("qp-score-chip"),
    streak: document.getElementById("qp-streak"),
    quitBtn: document.getElementById("qp-quit-btn"),
    card: document.getElementById("quiz-card"),
    scoreWrap: document.getElementById("qs-score-wrap"),
    breakdown: document.getElementById("qs-breakdown"),
    review: document.getElementById("qs-review"),
    againBtn: document.getElementById("qs-again-btn"),
    reviewMissedBtn: document.getElementById("qs-review-missed-btn"),
    backToSetupBtn: document.getElementById("qs-setup-btn"),
  };

  const state = {
    index: [],
    detailCache: {},
    queue: [],
    qIndex: 0,
    blind: true,
    results: [],
    streak: 0,
    lastFilters: null,
    current: null, // the in-progress question's working state
  };

  // ---------------------------------------------------------------
  // small shared helpers (same conventions as trade.js)
  // ---------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toUnix(t) {
    return Math.floor(new Date(String(t).replace(" ", "T") + "").getTime() / 1000);
  }
  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    const n = Number(v);
    return n.toFixed(Math.abs(n) < 5 ? 4 : 2);
  }
  function fmtSignedPerShare(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + fmtPrice(Math.abs(v));
  }
  function pnlPerShare(entry, exit, side) {
    return side === "short" ? entry - exit : exit - entry;
  }
  // Bars are start-labeled minute candles; a floor-match (last bar whose
  // start time is <= the target time) finds the candle a given moment
  // actually falls inside — same rule trade.js uses for its markers.
  function barIndexAt(bars, unixTime) {
    let bestIdx = 0;
    for (let i = 0; i < bars.length; i++) {
      if (toUnix(bars[i].t) <= unixTime) bestIdx = i;
      else break;
    }
    return bestIdx;
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveHistoryEntry(entry) {
    try {
      const list = loadHistory();
      list.push(entry);
      while (list.length > HISTORY_MAX) list.shift();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) { /* ignore — quiz still works without persistence */ }
  }

  // ---------------------------------------------------------------
  // boot: load the index, populate the setup screen
  // ---------------------------------------------------------------
  fetch("data/trades.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      populateSetupOptions();
      renderCandidateCount();
      renderHistoryPanel();
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load data/trades.json.";
      els.startBtn.disabled = true;
    });

  function populateSetupOptions() {
    const setups = Array.from(new Set(state.index.map((r) => r.setup_type).filter(Boolean))).sort();
    for (const s of setups) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.replace(/_/g, " ");
      els.setupSelect.appendChild(opt);
    }
  }

  function getFilters() {
    const countBtn = els.countRow.querySelector(".quiz-mode-btn.active");
    return {
      setup: els.setupSelect.value,
      result: els.resultSelect.value,
      count: countBtn ? Number(countBtn.dataset.count) : 10,
      blind: els.blindCheck.checked,
    };
  }

  function filterIndex(filters) {
    return state.index.filter((r) => {
      if (!r.id) return false;
      if (filters.setup && r.setup_type !== filters.setup) return false;
      if (filters.result === "win" && !r.win) return false;
      if (filters.result === "loss" && r.win) return false;
      if (filters.result === "flagged" && !(r.better_entry_price != null || r.better_exit_price != null)) return false;
      return true;
    });
  }

  function renderCandidateCount() {
    const filters = getFilters();
    const n = filterIndex(filters).length;
    els.candidateCount.innerHTML = `<b>${n}</b> matching trade${n === 1 ? "" : "s"} in your journal.`;
    els.startBtn.disabled = n === 0;
  }

  els.setupSelect.addEventListener("change", renderCandidateCount);
  els.resultSelect.addEventListener("change", renderCandidateCount);
  els.countRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.countRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderCandidateCount();
    });
  });
  els.startBtn.addEventListener("click", () => {
    const filters = getFilters();
    state.lastFilters = filters;
    startQuiz(filters, filterIndex(filters).map((r) => r.id));
  });

  function renderHistoryPanel() {
    const history = loadHistory();
    if (!history.length) {
      els.historyBox.innerHTML = `<div class="quiz-history-empty">No quizzes taken yet — your accuracy trend will show up here.</div>`;
      els.focusBox.innerHTML = "";
      return;
    }
    const recent = history.slice(-8).reverse();
    els.historyBox.innerHTML = recent.map((h) => {
      const color = h.accuracy >= 70 ? "var(--green)" : h.accuracy >= 40 ? "var(--amber)" : "var(--red)";
      return `<div class="quiz-history-row">
        <span class="hr-date">${escapeHtml(h.date)}</span>
        <span class="hr-track"><span class="hr-fill" style="width:${Math.max(4, h.accuracy)}%; background:${color}"></span></span>
        <span class="hr-val" style="color:${color}">${h.accuracy}% · ${h.count}q</span>
      </div>`;
    }).join("");

    const missTotals = {};
    history.forEach((h) => {
      Object.entries(h.missedSetups || {}).forEach(([k, v]) => { missTotals[k] = (missTotals[k] || 0) + v; });
    });
    const top = Object.entries(missTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!top.length) { els.focusBox.innerHTML = ""; return; }
    els.focusBox.innerHTML = `<div class="panel-box-head" style="margin-bottom:8px;"><span class="title">Setups to review</span></div>
      <div class="quiz-focus-list">
        ${top.map(([setup, n]) => `<a class="quiz-focus-item" href="playbooks.html?setup=${encodeURIComponent(setup)}">
          <span>${escapeHtml(setup.replace(/_/g, " "))}</span>
          <span class="fi-count">missed ${n}×</span>
        </a>`).join("")}
      </div>`;
  }

  // ---------------------------------------------------------------
  // chart building — a slimmed-down version of trade.js's chart, since
  // the quiz only needs candles + volume + VWAP/EMA overlays, cropped
  // to whatever the current stage should reveal.
  // ---------------------------------------------------------------
  function buildChart(el, bars, opts) {
    opts = opts || {};
    el.innerHTML = "";
    const candleData = bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volData = bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" }));
    const vwapData = bars.filter((b) => b.vwap != null).map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.filter((b) => b.ema9 != null).map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.filter((b) => b.ema20 != null).map((b) => ({ time: toUnix(b.t), value: b.ema20 }));

    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830", minimumWidth: 88 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: opts.height || 380 });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    series.setData(candleData);
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.12, bottom: 0.2 } });

    const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volSeries.setData(volData);

    chart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    chart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    chart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    if (opts.markers && opts.markers.length) series.setMarkers(opts.markers);
    const priceLineRefs = {};
    (opts.priceLines || []).forEach((pl, i) => {
      priceLineRefs[pl.key || i] = series.createPriceLine(pl);
    });

    chart.timeScale().fitContent();
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch (e) {} });
      ro.observe(el);
    }
    return { chart, series, volSeries, priceLineRefs, resizeObserver: ro };
  }
  function teardownChart(handle) {
    if (!handle) return;
    try { if (handle.resizeObserver) handle.resizeObserver.disconnect(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
  }

  // ---------------------------------------------------------------
  // quiz flow
  // ---------------------------------------------------------------
  function startQuiz(filters, ids) {
    state.queue = shuffle(ids).slice(0, filters.count > 0 ? filters.count : ids.length);
    state.qIndex = 0;
    state.blind = filters.blind;
    state.results = [];
    state.streak = 0;
    els.setupScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.playScreen.style.display = "";
    loadQuestion();
  }

  function fetchDetail(id) {
    if (state.detailCache[id]) return Promise.resolve(state.detailCache[id]);
    return fetch(`data/trades/${encodeURIComponent(id)}.json`)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((trade) => { state.detailCache[id] = trade; return trade; });
  }

  function updateHeaderChrome() {
    els.progressLabel.textContent = `Question ${Math.min(state.qIndex + 1, state.queue.length)} / ${state.queue.length}`;
    els.progressFill.style.width = `${(state.qIndex / state.queue.length) * 100}%`;
    const correct = state.results.filter((r) => r.entryCorrect).length;
    els.scoreChip.textContent = state.results.length ? `${correct}/${state.results.length} correct calls` : "";
    els.streak.textContent = state.streak >= 2 ? `🔥 ${state.streak} in a row` : "";
  }

  function loadQuestion() {
    updateHeaderChrome();
    if (state.qIndex >= state.queue.length) { finishQuiz(); return; }
    els.card.innerHTML = `<div class="loading-line">Loading chart…</div>`;
    fetchDetail(state.queue[state.qIndex])
      .then((trade) => initQuestion(trade))
      .catch((err) => {
        els.card.innerHTML = `<div class="empty-state">Couldn't load this trade (${escapeHtml(String(err.message))}). <button class="btn-advanced" id="qz-skip">Skip it</button></div>`;
        const skip = document.getElementById("qz-skip");
        if (skip) skip.addEventListener("click", () => { state.qIndex++; loadQuestion(); });
      });
  }

  function computeCheckpointIdx(entryIdx, exitIdx) {
    const gap = exitIdx - entryIdx;
    if (gap < 1) return null; // entry and exit landed in the same bar — nothing to check midway
    if (gap === 1) return exitIdx; // only one bar exists between entry and exit: check in right at it
    return entryIdx + Math.max(1, Math.min(gap - 1, Math.round(gap * 0.6)));
  }

  function initQuestion(trade) {
    const bars = Array.isArray(trade.bars) ? trade.bars : [];
    const side = trade.side === "short" ? "short" : "long";
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const exitUnix = toUnix(`${trade.trade_date} ${trade.exit_time}`);
    let entryIdx = barIndexAt(bars, entryUnix);
    let exitIdx = barIndexAt(bars, exitUnix);
    if (exitIdx <= entryIdx) exitIdx = Math.min(bars.length - 1, entryIdx + 1);

    state.current = {
      trade, bars, side, entryIdx, exitIdx,
      checkpointIdx: computeCheckpointIdx(entryIdx, exitIdx),
      stage: "entry",
      entered: null,
      stopPrice: null,
      stoppedOutEarly: false,
      stopOutIdx: null,
      checkpointAction: null,
      chartHandle: null,
    };
    renderEntryStage();
  }

  function displayLabel(trade) {
    return state.blind
      ? { name: `Setup #${state.qIndex + 1}`, date: "" }
      : { name: trade.symbol, date: trade.trade_date };
  }

  // ---------- Stage A: entry decision ----------
  function renderEntryStage() {
    const c = state.current;
    const trade = c.trade;
    const label = displayLabel(trade);
    const visibleBars = c.bars.slice(0, c.entryIdx + 1);
    const lastClose = visibleBars[visibleBars.length - 1].c;
    const sidePretty = c.side === "short" ? "short" : "long";

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          ${label.date ? `<span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>` : ""}
          <span class="side-pill ${sidePretty}">${sidePretty}</span>
          <span class="pill">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(trade.entry_time)}</span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt">
        Price is at <b>$${fmtPrice(lastClose)}</b>. This is a <b>${sidePretty}</b> setup${label.date ? "" : ""}. <b>Would you enter here?</b>
      </div>
      <div class="quiz-answer-row">
        <button class="quiz-answer-btn enter" id="qz-enter">Enter the trade <span class="kbd">Y</span></button>
        <button class="quiz-answer-btn pass" id="qz-pass">Pass <span class="kbd">N</span></button>
      </div>
      <div id="quiz-stop-slot"></div>
    `;

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), visibleBars, { height: 380 });

    document.getElementById("qz-enter").addEventListener("click", () => handleEntryChoice(true));
    document.getElementById("qz-pass").addEventListener("click", () => handleEntryChoice(false));
    c.stage = "entry";
  }

  function handleEntryChoice(entered) {
    const c = state.current;
    c.entered = entered;
    document.getElementById("qz-enter").disabled = true;
    document.getElementById("qz-pass").disabled = true;
    if (entered) renderStopStage();
    else goToReveal();
  }

  // ---------- Stage B: stop-loss placement ----------
  function renderStopStage() {
    const c = state.current;
    const trade = c.trade;
    const entryPrice = trade.entry_price;
    const slot = document.getElementById("quiz-stop-slot");
    slot.innerHTML = `
      <div class="quiz-stop-panel">
        <div class="quiz-prompt" style="margin-top:0;">You're in. <b>Where's your stop-loss?</b> Type a price, or click the chart to place it.</div>
        <div class="quiz-stop-row">
          <input type="number" step="0.0001" id="quiz-stop-input" placeholder="e.g. ${fmtPrice(c.side === "short" ? entryPrice * 1.02 : entryPrice * 0.98)}">
          <button class="quiz-answer-btn enter" id="quiz-stop-confirm" style="flex:none; min-width:150px;">Lock in stop <span class="kbd">↵</span></button>
        </div>
        <div class="quiz-risk-preview" id="quiz-risk-preview"></div>
        <div class="quiz-stop-hint" id="quiz-stop-error"></div>
      </div>
    `;
    c.stage = "stop";

    let previewLine = null;
    function setPreview(price) {
      if (!Number.isFinite(price)) return;
      if (previewLine) previewLine.applyOptions({ price });
      else previewLine = c.chartHandle.series.createPriceLine({
        price, color: "#c9cdd6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: "your stop",
      });
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      const el = document.getElementById("quiz-risk-preview");
      if (el) el.textContent = risk > 0
        ? `Risking $${fmtPrice(risk)}/sh (${((risk / entryPrice) * 100).toFixed(1)}%) if filled at $${fmtPrice(entryPrice)}.`
        : `That's on the wrong side of your entry ($${fmtPrice(entryPrice)}) — widen it out.`;
    }

    const input = document.getElementById("quiz-stop-input");
    input.addEventListener("input", () => setPreview(Number(input.value)));
    c.chartHandle.chart.subscribeClick((param) => {
      if (!param.point || !c.chartHandle.series) return;
      const price = c.chartHandle.series.coordinateToPrice(param.point.y);
      if (price == null) return;
      input.value = fmtPrice(price);
      setPreview(price);
    });

    document.getElementById("quiz-stop-confirm").addEventListener("click", () => {
      const price = Number(input.value);
      const errorEl = document.getElementById("quiz-stop-error");
      if (!Number.isFinite(price) || price <= 0) { errorEl.textContent = "Enter a valid price first."; return; }
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      if (!(risk > 0)) { errorEl.textContent = `That stop is on the wrong side of your $${fmtPrice(entryPrice)} entry for a ${c.side}.`; return; }
      confirmStop(price);
    });
  }

  function confirmStop(stopPrice) {
    const c = state.current;
    c.stopPrice = stopPrice;
    document.getElementById("quiz-stop-confirm").disabled = true;
    document.getElementById("quiz-stop-input").disabled = true;

    if (c.checkpointIdx == null) { goToReveal(); return; }

    // Did price breach the stop between entry and the checkpoint? If so,
    // the hypothetical trade is already over -- skip straight to reveal.
    for (let k = c.entryIdx + 1; k <= c.checkpointIdx; k++) {
      const b = c.bars[k];
      const breached = c.side === "short" ? b.h >= stopPrice : b.l <= stopPrice;
      if (breached) { c.stoppedOutEarly = true; c.stopOutIdx = k; goToReveal(); return; }
    }
    renderCheckpointStage();
  }

  // ---------- Stage C: mid-trade check ----------
  function renderCheckpointStage() {
    const c = state.current;
    const trade = c.trade;
    const visibleBars = c.bars.slice(0, c.checkpointIdx + 1);
    const checkpointBar = c.bars[c.checkpointIdx];
    const unrealized = pnlPerShare(trade.entry_price, checkpointBar.c, c.side);
    const clockStr = new Date(checkpointBar.t.replace(" ", "T")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(displayLabel(trade).name)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(clockStr)}</span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt">
        You're in at <b>$${fmtPrice(trade.entry_price)}</b>, stop at <b>$${fmtPrice(c.stopPrice)}</b>.
        Price is now <b>$${fmtPrice(checkpointBar.c)}</b> — unrealized <b style="color:${unrealized >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(unrealized)}/sh</b>.
        <b>Exit now, or hold?</b>
      </div>
      <div class="quiz-answer-row">
        <button class="quiz-answer-btn exit" id="qz-exit">Exit now <span class="kbd">E</span></button>
        <button class="quiz-answer-btn hold" id="qz-hold">Hold <span class="kbd">H</span></button>
      </div>
    `;
    c.stage = "checkpoint";

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), visibleBars, {
      height: 380,
      priceLines: [
        { price: trade.entry_price, color: "#2fd08a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "" },
        { price: c.stopPrice, color: "#c9cdd6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" },
      ],
    });

    document.getElementById("qz-exit").addEventListener("click", () => { c.checkpointAction = "exit"; goToReveal(); });
    document.getElementById("qz-hold").addEventListener("click", () => { c.checkpointAction = "hold"; goToReveal(); });
  }

  // ---------- grading ----------
  function gradeEntry(win, entered) {
    if (entered && win) return { label: "Good call — this one was a real winner.", tone: "good", correct: true };
    if (entered && !win) return { label: "This one lost in real life too.", tone: "bad", correct: false };
    if (!entered && !win) return { label: "Good discipline — this one was a loser.", tone: "good", correct: true };
    return { label: "This one worked out — you'd have missed it.", tone: "warn", correct: false };
  }

  function gradeStop(side, entryPrice, stopPrice, suggestedStop) {
    const riskUser = side === "short" ? stopPrice - entryPrice : entryPrice - stopPrice;
    if (!(riskUser > 0)) return { label: "Stop was on the wrong side of your entry.", tone: "bad" };
    const sug = Number(suggestedStop);
    if (suggestedStop != null && Number.isFinite(sug)) {
      const riskSuggested = side === "short" ? sug - entryPrice : entryPrice - sug;
      if (riskSuggested > 0) {
        const ratio = riskUser / riskSuggested;
        if (ratio < 0.5) return { label: "Too tight — likely shaken out by normal noise.", tone: "bad" };
        if (ratio < 0.8) return { label: "A little tight versus the setup's stop.", tone: "warn" };
        if (ratio <= 1.3) return { label: "Well placed — close to the setup's stop.", tone: "good" };
        if (ratio <= 2.2) return { label: "A bit wide.", tone: "warn" };
        return { label: "Too wide — risking more than the setup called for.", tone: "bad" };
      }
    }
    const pct = (riskUser / entryPrice) * 100;
    return { label: `${pct.toFixed(1)}% risk — no AI stop logged on this trade to compare against.`, tone: "neutral" };
  }

  function computeGrading(c) {
    const trade = c.trade;
    const side = c.side;
    const entryPrice = trade.entry_price;
    const win = !!trade.win;
    const entryGrade = gradeEntry(win, c.entered);

    let stopGrade = null, exitGrade = null, userPnlPerShare = null;
    if (c.entered) {
      stopGrade = gradeStop(side, entryPrice, c.stopPrice, trade.suggested_stop);
      const actualPnl = pnlPerShare(entryPrice, trade.exit_price, side);

      if (c.stoppedOutEarly) {
        userPnlPerShare = pnlPerShare(entryPrice, c.stopPrice, side);
        exitGrade = { label: `Stopped out before your check-in, at $${fmtPrice(c.stopPrice)}.`, tone: "warn" };
      } else if (c.checkpointIdx == null) {
        userPnlPerShare = actualPnl;
        exitGrade = { label: "Not enough bars for a mid-trade check on this one — it went straight to the real exit.", tone: "neutral" };
      } else if (c.checkpointAction === "exit") {
        const checkpointBar = c.bars[c.checkpointIdx];
        userPnlPerShare = pnlPerShare(entryPrice, checkpointBar.c, side);
        const diff = actualPnl - userPnlPerShare;
        const threshold = Math.max(0.15 * Math.abs(actualPnl || 0.01), 0.01);
        if (diff > threshold) exitGrade = { label: `You exited early — the move kept going. Riding it to the real exit made ${fmtSignedPerShare(diff)}/sh more.`, tone: "warn" };
        else if (diff < -threshold) exitGrade = { label: "Good exit — price gave back a lot of that move afterward.", tone: "good" };
        else exitGrade = { label: "Reasonable exit, close to how the trade actually played out.", tone: "good" };
      } else {
        let stopHitLater = false;
        for (let k = c.checkpointIdx + 1; k <= c.exitIdx; k++) {
          const b = c.bars[k];
          if (side === "short" ? b.h >= c.stopPrice : b.l <= c.stopPrice) { stopHitLater = true; break; }
        }
        if (stopHitLater) {
          userPnlPerShare = pnlPerShare(entryPrice, c.stopPrice, side);
          exitGrade = { label: `Holding would've run you into your own stop at $${fmtPrice(c.stopPrice)} before the real exit.`, tone: "warn" };
        } else {
          userPnlPerShare = actualPnl;
          exitGrade = { label: "You held on — matches what actually happened.", tone: "neutral" };
        }
      }
    }
    return { entryGrade, stopGrade, exitGrade, userPnlPerShare };
  }

  // ---------- Stage D: full reveal ----------
  function goToReveal() {
    const c = state.current;
    const trade = c.trade;
    const grading = computeGrading(c);
    c.stage = "reveal";

    state.results.push({
      id: trade.id, symbol: trade.symbol, setup_type: trade.setup_type, win: !!trade.win,
      entered: c.entered, entryCorrect: grading.entryGrade.correct,
      stopTone: grading.stopGrade ? grading.stopGrade.tone : null,
      exitTone: grading.exitGrade ? grading.exitGrade.tone : null,
    });
    state.streak = grading.entryGrade.correct ? state.streak + 1 : 0;

    const markers = [];
    const entryBar = c.bars[c.entryIdx], exitBar = c.bars[c.exitIdx];
    markers.push({
      time: toUnix(entryBar.t), position: c.side === "short" ? "aboveBar" : "belowBar",
      color: "#2fd08a", shape: c.side === "short" ? "arrowDown" : "arrowUp", text: "Entry",
    });
    markers.push({
      time: toUnix(exitBar.t), position: c.side === "short" ? "belowBar" : "aboveBar",
      color: "#f2555a", shape: c.side === "short" ? "arrowUp" : "arrowDown", text: "Exit",
    });
    if (c.stoppedOutEarly && c.stopOutIdx != null) {
      markers.push({ time: toUnix(c.bars[c.stopOutIdx].t), position: "inBar", color: "#e8a94c", shape: "circle", text: "Your stop" });
    } else if (c.entered && c.checkpointAction === "exit" && c.checkpointIdx != null) {
      markers.push({ time: toUnix(c.bars[c.checkpointIdx].t), position: "inBar", color: "#5b93f0", shape: "circle", text: "Your exit" });
    }

    const priceLines = [
      { price: trade.entry_price, color: "#2fd08a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "" },
      { price: trade.exit_price, color: "#f2555a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "" },
    ];
    if (c.entered && c.stopPrice != null) {
      priceLines.push({ price: c.stopPrice, color: "#c9cdd6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" });
    }
    // The AI's suggested stop/target are sometimes anchored to its suggested
    // "better entry" rather than the real fill (e.g. a chase entry that's
    // already past where a sane stop would sit) — only draw them when they
    // fall on the correct side of the REAL entry, so the chart never shows
    // a "stop" line above a long entry or similar nonsense.
    const sugStop = Number(trade.suggested_stop);
    if (trade.suggested_stop != null && Number.isFinite(sugStop) && (c.side === "short" ? sugStop > trade.entry_price : sugStop < trade.entry_price)) {
      priceLines.push({ price: sugStop, color: "#e8a94c", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "AI stop" });
    }
    const sugTarget = Number(trade.suggested_target);
    if (trade.suggested_target != null && Number.isFinite(sugTarget) && (c.side === "short" ? sugTarget < trade.entry_price : sugTarget > trade.entry_price)) {
      priceLines.push({ price: sugTarget, color: "#22d3ee", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "AI target" });
    }
    if (trade.better_entry && trade.better_entry.price != null) {
      priceLines.push({ price: Number(trade.better_entry.price), color: "#8b7cf6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "better entry" });
    }
    if (trade.better_exit && trade.better_exit.price != null) {
      priceLines.push({ price: Number(trade.better_exit.price), color: "#ec6cad", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "better exit" });
    }

    const label = { name: trade.symbol, date: trade.trade_date }; // reveal always shows the real thing
    const winPillHtml = `<span class="pill ${trade.win ? "win" : "loss"}">${trade.win ? "Winner" : "Loser"}</span>`;

    function pillFor(tone) { return `pill ${tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}`; }

    const entryRowHtml = `<div class="rb-line">You: <b>${c.entered ? "Entered" : "Passed"}</b></div>
      <div class="rb-line"><span class="${pillFor(grading.entryGrade.tone)}">${escapeHtml(grading.entryGrade.label)}</span></div>`;

    const sugStopSane = Number.isFinite(Number(trade.suggested_stop)) && (c.side === "short" ? Number(trade.suggested_stop) > trade.entry_price : Number(trade.suggested_stop) < trade.entry_price);
    const stopRowHtml = grading.stopGrade
      ? `<div class="rb-line">You placed your stop at <b>$${fmtPrice(c.stopPrice)}</b>${sugStopSane ? ` · AI suggested <b>$${fmtPrice(trade.suggested_stop)}</b>` : ""}</div>
         <div class="rb-line"><span class="${pillFor(grading.stopGrade.tone)}">${escapeHtml(grading.stopGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no stop to grade.</div>`;

    const exitRowHtml = grading.exitGrade
      ? `<div class="rb-line">Your result: <b style="color:${grading.userPnlPerShare >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(grading.userPnlPerShare)}/sh</b>
           · Actual: <b style="color:${trade.win ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(pnlPerShare(trade.entry_price, trade.exit_price, c.side))}/sh</b></div>
         <div class="rb-line"><span class="${pillFor(grading.exitGrade.tone)}">${escapeHtml(grading.exitGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no exit to grade.</div>`;

    const lessonsHtml = (trade.lessons || []).map((l) => {
      if (typeof l === "string") return `<li>${escapeHtml(l)}</li>`;
      const how = l.how_to_know ? ` <span class="dim">— ${escapeHtml(l.how_to_know)}</span>` : "";
      return `<li><b>${escapeHtml((l.tag || "").replace(/_/g, " "))}</b>: ${escapeHtml(l.lesson || l.text || "")}${how}</li>`;
    }).join("");

    const isLast = state.qIndex >= state.queue.length - 1;

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          <span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
          <span class="pill">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
          ${winPillHtml}
        </div>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>

      <div class="quiz-reveal-grid">
        <div class="quiz-reveal-box"><div class="rb-label">Entry</div>${entryRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Stop-loss</div>${stopRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Exit</div>${exitRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Real numbers</div>
          <div class="rb-line">Entry <b>$${fmtPrice(trade.entry_price)}</b> → Exit <b>$${fmtPrice(trade.exit_price)}</b></div>
          <div class="rb-line">Net P&amp;L: <b style="color:${trade.pnl_after_comm >= 0 ? "var(--green)" : "var(--red)"}">${trade.pnl_after_comm >= 0 ? "+" : "-"}$${Math.abs(trade.pnl_after_comm).toFixed(2)}</b></div>
        </div>
      </div>

      ${trade.verdict ? `<div class="quiz-verdict-box"><span class="vb-label">What actually happened</span>${escapeHtml(trade.verdict)}</div>` : ""}
      ${lessonsHtml ? `<ul class="quiz-lesson-list">${lessonsHtml}</ul>` : ""}
      ${trade.walk_away_rule ? `<div class="quiz-walkaway"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}

      <div class="quiz-next-row">
        <a class="btn-advanced" href="trade.html?id=${encodeURIComponent(trade.id)}" target="_blank" rel="noopener">Open full trade page</a>
        <button class="btn-confirm" id="qz-next">${isLast ? "See results" : "Next question"} <span class="kbd">↵</span></button>
      </div>
    `;

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), c.bars, { height: 400, markers, priceLines });

    document.getElementById("qz-next").addEventListener("click", () => { state.qIndex++; loadQuestion(); });
  }

  // ---------------------------------------------------------------
  // keyboard shortcuts — ignored while typing in the stop input
  // ---------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (els.playScreen.style.display === "none") return;
    const c = state.current;
    if (!c) return;
    const typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (c.stage === "entry" && !typing) {
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") document.getElementById("qz-enter")?.click();
      if (e.key === "n" || e.key === "N" || e.key === "Escape") document.getElementById("qz-pass")?.click();
    } else if (c.stage === "checkpoint" && !typing) {
      if (e.key === "e" || e.key === "E" || e.key === "1") document.getElementById("qz-exit")?.click();
      if (e.key === "h" || e.key === "H" || e.key === "2") document.getElementById("qz-hold")?.click();
    } else if (c.stage === "reveal" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      document.getElementById("qz-next")?.click();
    }
  });

  els.quitBtn.addEventListener("click", () => {
    if (!confirm("End this quiz? Your progress on the current question won't be saved.")) return;
    goToSetupScreen();
  });

  function goToSetupScreen() {
    if (state.current && state.current.chartHandle) teardownChart(state.current.chartHandle);
    state.current = null;
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.setupScreen.style.display = "";
    renderHistoryPanel();
    renderCandidateCount();
  }

  // ---------------------------------------------------------------
  // session summary
  // ---------------------------------------------------------------
  function finishQuiz() {
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "";

    const total = state.results.length;
    const correct = state.results.filter((r) => r.entryCorrect).length;
    const accuracy = total ? Math.round((correct / total) * 100) : 0;
    const color = accuracy >= 70 ? "var(--green)" : accuracy >= 40 ? "var(--amber)" : "var(--red)";
    const r = 58, circ = 2 * Math.PI * r;
    const dash = (accuracy / 100) * circ;

    els.scoreWrap.innerHTML = `
      <div class="score-gauge">
        <svg viewBox="0 0 132 132">
          <circle class="track" cx="66" cy="66" r="${r}"></circle>
          <circle class="fill" cx="66" cy="66" r="${r}" stroke="${color}" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"></circle>
        </svg>
        <div class="center">
          <span class="num" style="color:${color}">${accuracy}</span>
          <span class="lbl">Read score</span>
        </div>
      </div>
      <div class="score-breakdown">
        <div class="score-row"><span class="k">Entry calls</span>
          <span class="track"><span class="fill" style="width:${Math.max(4, accuracy)}%; background:${color}"></span></span>
          <span class="v">${correct}/${total}</span>
        </div>
      </div>
    `;

    function tally(field) {
      const t = { good: 0, warn: 0, bad: 0, neutral: 0 };
      state.results.forEach((r) => { if (r[field]) t[r[field]] = (t[r[field]] || 0) + 1; });
      return t;
    }
    const stopTally = tally("stopTone");
    const exitTally = tally("exitTone");
    function chipsHtml(t) {
      const parts = [];
      if (t.good) parts.push(`<span class="pill good">${t.good} good</span>`);
      if (t.warn) parts.push(`<span class="pill warn">${t.warn} off</span>`);
      if (t.bad) parts.push(`<span class="pill bad">${t.bad} bad</span>`);
      if (t.neutral) parts.push(`<span class="pill neutral">${t.neutral} n/a</span>`);
      return parts.join(" ") || `<span class="dim">—</span>`;
    }
    els.breakdown.innerHTML = `
      <div class="quiz-breakdown-row"><span class="br-k">Stop placement</span><span class="br-chips">${chipsHtml(stopTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Exit timing</span><span class="br-chips">${chipsHtml(exitTally)}</span></div>
    `;

    els.review.innerHTML = `
      <table class="quiz-review-table">
        <thead><tr><th>Symbol</th><th>Setup</th><th>Outcome</th><th>Your call</th><th>Stop</th><th>Exit</th><th></th></tr></thead>
        <tbody>
          ${state.results.map((r) => `<tr>
            <td>${escapeHtml(r.symbol)}</td>
            <td>${escapeHtml((r.setup_type || "—").replace(/_/g, " "))}</td>
            <td><span class="pill ${r.win ? "win" : "loss"}">${r.win ? "Win" : "Loss"}</span></td>
            <td>${r.entryCorrect ? "✅" : "❌"} ${r.entered ? "Entered" : "Passed"}</td>
            <td>${r.stopTone ? `<span class="pill ${r.stopTone === "good" ? "good" : r.stopTone === "bad" ? "bad" : r.stopTone === "warn" ? "warn" : "neutral"}">${escapeHtml(r.stopTone)}</span>` : "—"}</td>
            <td>${r.exitTone ? `<span class="pill ${r.exitTone === "good" ? "good" : r.exitTone === "bad" ? "bad" : r.exitTone === "warn" ? "warn" : "neutral"}">${escapeHtml(r.exitTone)}</span>` : "—"}</td>
            <td><a href="trade.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">view</a></td>
          </tr>`).join("")}
        </tbody>
      </table>
    `;

    const missedSetups = {};
    state.results.forEach((r) => { if (!r.entryCorrect) missedSetups[r.setup_type || "unspecified"] = (missedSetups[r.setup_type || "unspecified"] || 0) + 1; });
    saveHistoryEntry({ date: new Date().toISOString().slice(0, 10), count: total, accuracy, missedSetups });
  }

  els.againBtn.addEventListener("click", () => {
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, filterIndex(filters).map((r) => r.id));
  });
  els.reviewMissedBtn.addEventListener("click", () => {
    const missedIds = state.results.filter((r) => !r.entryCorrect).map((r) => r.id);
    if (!missedIds.length) { alert("Nothing to review — you called every entry right!"); return; }
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, missedIds);
  });
  els.backToSetupBtn.addEventListener("click", goToSetupScreen);

})();
