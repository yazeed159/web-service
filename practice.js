(function () {
  "use strict";

  // ==================================================================
  // Practice tab — free-form paper trading against a real logged
  // trade's own chart window (data/trades.json + data/trades/<id>.json,
  // same files journal.html/trade.html/rewind.html already read).
  //
  // Unlike rewind.html (which asks graded yes/no questions about ONE
  // decision point), this tab hands you the whole chart from the
  // start of the data we have on that symbol and lets you buy/sell as
  // many times as you want while it plays forward, using the same
  // offline second-by-second tick synthesis rewind.js uses to "print"
  // each bar in. A persistent dummy account (cash, fills, P&L) lives
  // in localStorage so it's there next time you open the tab.
  // ==================================================================

  const ACCOUNT_KEY = "practice:account:v2";
  const DEFAULT_STARTING_BALANCE = 25000;

  const els = {
    setupScreen: document.getElementById("pr-setup-screen"),
    playScreen: document.getElementById("pr-play-screen"),

    acctBalance: document.getElementById("pr-acct-balance"),
    acctStarting: document.getElementById("pr-acct-starting"),
    acctRealized: document.getElementById("pr-acct-realized"),
    acctComm: document.getElementById("pr-acct-comm"),
    acctTrades: document.getElementById("pr-acct-trades"),
    acctWinrate: document.getElementById("pr-acct-winrate"),
    resetBtn: document.getElementById("pr-reset-btn"),
    equitySvg: document.getElementById("pr-equity-svg"),
    equityEmpty: document.getElementById("pr-equity-empty"),
    fillsBox: document.getElementById("pr-fills-box"),

    resumeBox: document.getElementById("pr-resume-box"),
    resumeBtn: document.getElementById("pr-resume-btn"),
    resumeLabel: document.getElementById("pr-resume-label"),

    search: document.getElementById("pf-search"),
    setupSelect: document.getElementById("pf-setup"),
    randomBtn: document.getElementById("pf-random-btn"),
    candidateList: document.getElementById("pf-candidate-list"),
    candidateCount: document.getElementById("pf-candidate-count"),

    // play screen
    symLine: document.getElementById("pp-symbol-line"),
    dateLine: document.getElementById("pp-date-line"),
    changeChartBtn: document.getElementById("pp-change-chart-btn"),
    chartWrap: document.getElementById("pp-chart-wrap"),
    chartEl: document.getElementById("pp-candle-chart"),

    playPauseBtn: document.getElementById("pp-playpause-btn"),
    speedRow: document.getElementById("pp-speed-row"),
    stepBtn: document.getElementById("pp-step-btn"),
    skipBtn: document.getElementById("pp-skip-btn"),
    progressLabel: document.getElementById("pp-progress-label"),
    progressFill: document.getElementById("pp-progress-fill"),
    progressSlider: document.getElementById("pp-progress-slider"),

    livePrice: document.getElementById("pp-live-price"),
    liveChange: document.getElementById("pp-live-change"),

    sharesInput: document.getElementById("pp-shares-input"),
    presetRow: document.getElementById("pp-size-preset-row"),
    buyBtn: document.getElementById("pp-buy-btn"),
    sellBtn: document.getElementById("pp-sell-btn"),
    orderMsg: document.getElementById("pp-order-msg"),

    posSummary: document.getElementById("pp-pos-summary"),
    cashLine: document.getElementById("pp-cash-line"),
    equityLine: document.getElementById("pp-equity-line"),
    bpLine: document.getElementById("pp-bp-line"),

    fillLog: document.getElementById("pp-fill-log"),

    recapBox: document.getElementById("pp-recap-box"),

    symbolCard: document.getElementById("pp-symbol-card"),
    srBox: document.getElementById("pp-sr-box"),
    srBtn: document.getElementById("pp-sr-run-btn"),
    srResult: document.getElementById("pp-sr-result"),
  };

  // Webhook for the optional "Support & Resistance" box, same one
  // trade.js uses -- reads the symbol's prior daily bars and returns
  // support/resistance levels. Only ever called on click.
  const SR_ANALYSIS_URL = window.N8N_SR_URL || "";

  // ---------------------------------------------------------------
  // shared helpers (same conventions as rewind.js / trade.js / app.js)
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
  function fmtUsd(v) {
    if (!Number.isFinite(v)) return "—";
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTime(t) {
    try { return new Date(String(t).replace(" ", "T")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch (e) { return String(t); }
  }

  // IBKR's "Tiered" US stock commission schedule -- identical to the
  // model rewind.js applies when scoring logged trades: $0.0035/share,
  // with a $0.35 floor and a 1%-of-trade-value ceiling per order.
  const IBKR_PER_SHARE = 0.0035;
  const IBKR_MIN_PER_ORDER = 0.35;
  const IBKR_MAX_PCT_OF_TRADE_VALUE = 0.01;
  function ibkrTieredCommission(shares, price) {
    if (!(shares > 0) || !(price > 0)) return 0;
    const raw = shares * IBKR_PER_SHARE;
    const ceiling = shares * price * IBKR_MAX_PCT_OF_TRADE_VALUE;
    return Math.max(IBKR_MIN_PER_ORDER, Math.min(raw, ceiling));
  }

  // ---------------------------------------------------------------
  // offline second-by-second tick synthesis -- identical to
  // rewind.js's version (same deterministic, seeded intra-bar walk:
  // previous close -> open -> high/low in a per-bar-random order ->
  // close, jitter clamped inside the bar's own high/low), so a given
  // bar always "prints" the same way here as it does on the Rewind
  // tab. Clearly a practice aid, not a real tick feed.
  // ---------------------------------------------------------------
  function seededRng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }
  const REPLAY_SECONDS = 60; // one sub-tick per real second of the 1-min bar
  function genSecondTicks(bar, prevClose, seed) {
    const n = REPLAY_SECONDS;
    const rng = seededRng(seed);
    const o = bar.o, h = bar.h, l = bar.l, c = bar.c;
    const start = Number.isFinite(prevClose) ? prevClose : o;
    const highFirst = rng() < 0.5;
    const waypoints = [
      { t: 0, p: start },
      { t: Math.round(n * 0.1), p: o },
      { t: Math.round(n * 0.42), p: highFirst ? h : l },
      { t: Math.round(n * 0.74), p: highFirst ? l : h },
      { t: n - 1, p: c },
    ];
    const range = Math.max(h - l, 0.0001);
    const jitterAmp = range * 0.07;
    const ticks = [];
    for (let s = 0; s < n; s++) {
      let a = waypoints[0], b = waypoints[waypoints.length - 1];
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (s >= waypoints[i].t && s <= waypoints[i + 1].t) { a = waypoints[i]; b = waypoints[i + 1]; break; }
      }
      const span = Math.max(1, b.t - a.t);
      const frac = (s - a.t) / span;
      let price = a.p + (b.p - a.p) * frac;
      price += (rng() - 0.5) * 2 * jitterAmp;
      price = Math.min(h, Math.max(l, price));
      ticks.push(price);
    }
    ticks[n - 1] = c; // always land exactly on the bar's real close
    return ticks;
  }

  // ---------------------------------------------------------------
  // persistent dummy account -- balance, every fill ever made, and
  // (if you left mid-chart) the exact bar/tick/position you were on,
  // so the tab is "just there" again next time it's opened.
  // ---------------------------------------------------------------
  function defaultAccount() {
    return {
      v: 2,
      balance: DEFAULT_STARTING_BALANCE,
      startingBalance: DEFAULT_STARTING_BALANCE,
      createdAt: new Date().toISOString(),
      fills: [],       // { time, chartId, symbol, side, shares, price, commission, realizedPnl }
      session: null,   // in-progress chart session, see loadChart()
    };
  }
  function loadAccount() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      if (!raw) return defaultAccount();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Number.isFinite(parsed.balance)) return defaultAccount();
      if (!Array.isArray(parsed.fills)) parsed.fills = [];
      return parsed;
    } catch (e) { return defaultAccount(); }
  }
  function saveAccount() {
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch (e) { /* ignore -- practice still works without persistence */ }
  }

  let account = loadAccount();

  // ---------------------------------------------------------------
  // runtime state for whatever chart is currently loaded (not all of
  // this is persisted -- bars/index are refetched from data/trades/
  // on resume, keyed by session.chartId)
  // ---------------------------------------------------------------
  const state = {
    index: [],          // data/trades.json rows
    trade: null,        // full data/trades/<id>.json for the loaded chart
    bars: [],
    barIndex: 0,         // index of the bar currently forming
    tickIndex: 0,        // tick within that forming bar
    ticks: [],           // synthesized ticks for the forming bar
    prevClose: null,
    playing: false,
    speed: 1,
    timer: null,
    position: null,      // { side: 'long'|'short', shares, avgPrice }
    fills: [],           // this session's fills (also mirrored into account.fills)
    markers: [],
    chartHandle: null,
    ended: false,
  };

  const SPEEDS = [0.5, 1, 2, 5, 10];
  const BASE_TICK_MS = 140;
  const SIZE_PRESETS = [50, 100, 200, 500];

  // ---------------------------------------------------------------
  // account panel (setup screen)
  // ---------------------------------------------------------------
  function accountStats() {
    const realized = account.fills.reduce((s, f) => s + (f.realizedPnl || 0), 0);
    const comm = account.fills.reduce((s, f) => s + (f.commission || 0), 0);
    const closes = account.fills.filter((f) => f.realizedPnl !== null && f.realizedPnl !== undefined);
    const wins = closes.filter((f) => f.realizedPnl > 0).length;
    return { realized, comm, closes: closes.length, winRate: closes.length ? (wins / closes.length) * 100 : null };
  }

  function renderAccountPanel() {
    const st = accountStats();
    els.acctBalance.textContent = fmtUsd(account.balance);
    els.acctBalance.className = "value mono " + (account.balance >= account.startingBalance ? "up" : "down");
    els.acctStarting.textContent = fmtUsd(account.startingBalance);
    els.acctRealized.textContent = fmtMoney(st.realized);
    els.acctRealized.className = "value mono " + (st.realized >= 0 ? "up" : "down");
    els.acctComm.textContent = fmtUsd(st.comm);
    els.acctTrades.textContent = String(st.closes);
    els.acctWinrate.textContent = st.winRate === null ? "—" : st.winRate.toFixed(0) + "%";
    renderEquityCurve();
    renderFillsBox();

    if (account.session && account.session.chartId) {
      els.resumeBox.style.display = "";
      const idxRow = state.index.find((r) => r.id === account.session.chartId);
      els.resumeLabel.textContent = idxRow
        ? `${idxRow.symbol} — ${idxRow.trade_date} (bar ${account.session.barIndex + 1})`
        : `Chart ${account.session.chartId} (bar ${account.session.barIndex + 1})`;
    } else {
      els.resumeBox.style.display = "none";
    }
  }

  function renderEquityCurve() {
    const points = [{ e: 0 }, ...account.fills.filter((f) => f.realizedPnl !== null && f.realizedPnl !== undefined)
      .map((f, i, arr) => ({ e: arr.slice(0, i + 1).reduce((s, x) => s + (x.realizedPnl || 0), 0) }))];
    if (points.length < 2) {
      els.equitySvg.innerHTML = "";
      els.equityEmpty.style.display = "";
      return;
    }
    els.equityEmpty.style.display = "none";
    const values = points.map((p) => p.e);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const W = 1000, H = 140, PAD = 8;
    const coords = points.map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * W : 0;
      const y = H - PAD - ((p.e - min) / range) * (H - PAD * 2);
      return [x, y];
    });
    const pathD = coords.map((c, i) => (i === 0 ? "M" : "L") + c[0].toFixed(1) + "," + c[1].toFixed(1)).join(" ");
    const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
    const fillD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${zeroY} L0,${zeroY} Z`;
    const finalPositive = values[values.length - 1] >= 0;
    els.equitySvg.innerHTML = `
      <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
      <path d="${fillD}" fill="${finalPositive ? "url(#prGGreen)" : "url(#prGRed)"}" />
      <path d="${pathD}" class="equity-path ${finalPositive ? "" : "neg"}" />
      <defs>
        <linearGradient id="prGGreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2fd08a" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#2fd08a" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="prGRed" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f2555a" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#f2555a" stop-opacity="0" />
        </linearGradient>
      </defs>
    `;
  }

  function renderFillsBox() {
    const recent = account.fills.slice(-8).reverse();
    if (!recent.length) {
      els.fillsBox.innerHTML = `<div class="pr-empty">No practice fills yet — load a chart below and place your first trade.</div>`;
      return;
    }
    els.fillsBox.innerHTML = recent.map((f) => `
      <div class="pr-fill-row">
        <span class="fr-sym">${escapeHtml(f.symbol)}</span>
        <span class="side-pill ${f.side === "buy" ? "long" : "short"}">${f.side.toUpperCase()}</span>
        <span class="fr-detail">${f.shares} sh @ $${fmtPrice(f.price)}</span>
        <span class="fr-pnl ${f.realizedPnl == null ? "" : f.realizedPnl >= 0 ? "up" : "down"}">${f.realizedPnl == null ? "—" : fmtMoney(f.realizedPnl)}</span>
      </div>
    `).join("");
  }

  function resetAccount() {
    if (!confirm("Reset your practice account? This clears your balance, fill history, and equity curve. This can't be undone.")) return;
    const input = prompt("Starting balance for the new account:", String(account.startingBalance || DEFAULT_STARTING_BALANCE));
    if (input === null) return;
    const amt = Number(String(input).replace(/[^0-9.]/g, ""));
    const startingBalance = Number.isFinite(amt) && amt > 0 ? amt : DEFAULT_STARTING_BALANCE;
    account = defaultAccount();
    account.startingBalance = startingBalance;
    account.balance = startingBalance;
    saveAccount();
    renderAccountPanel();
  }

  // ---------------------------------------------------------------
  // setup screen -- candidate chart picker (search + setup-type
  // filter over data/trades.json, same source rewind.js indexes)
  // ---------------------------------------------------------------
  function populateSetupOptions() {
    const types = Array.from(new Set(state.index.map((r) => r.setup_type).filter(Boolean))).sort();
    els.setupSelect.innerHTML = `<option value="">All setups</option>` + types.map((t) =>
      `<option value="${escapeHtml(t)}">${escapeHtml(t.replace(/_/g, " "))}</option>`).join("");
  }

  function filteredCandidates() {
    const q = (els.search.value || "").trim().toUpperCase();
    const setup = els.setupSelect.value;
    return state.index.filter((r) => {
      if (setup && r.setup_type !== setup) return false;
      if (q && !r.symbol.toUpperCase().includes(q)) return false;
      return true;
    });
  }

  function renderCandidates() {
    const rows = filteredCandidates();
    els.candidateCount.innerHTML = `<b>${rows.length}</b> chart${rows.length === 1 ? "" : "s"} available`;
    const shown = rows.slice(0, 60);
    if (!shown.length) {
      els.candidateList.innerHTML = `<div class="pr-empty">No charts match those filters.</div>`;
      return;
    }
    els.candidateList.innerHTML = shown.map((r) => `
      <button class="pr-candidate-row" data-id="${escapeHtml(r.id)}">
        <span class="cr-sym">${escapeHtml(r.symbol)}</span>
        <span class="cr-date">${escapeHtml(r.trade_date)}</span>
        <span class="side-pill ${r.side}">${escapeHtml(r.side)}</span>
        <span class="cr-setup">${escapeHtml((r.setup_type || "—").replace(/_/g, " "))}</span>
      </button>
    `).join("");
    els.candidateList.querySelectorAll(".pr-candidate-row").forEach((btn) => {
      btn.addEventListener("click", () => loadChart(btn.dataset.id));
    });
  }

  function pickRandomCandidate() {
    const rows = filteredCandidates();
    if (!rows.length) return;
    const pick = rows[Math.floor(Math.random() * rows.length)];
    loadChart(pick.id);
  }

  // ---------------------------------------------------------------
  // loading a chart -- fetches the same per-trade bar window
  // rewind.html reveals piece by piece, but here you get the whole
  // thing to trade against, starting from its very first bar.
  // ---------------------------------------------------------------
  function fetchDetail(id) {
    return fetch(`data/trades/${encodeURIComponent(id)}.json`).then((r) => (r.ok ? r.json() : null));
  }

  // ---------------------------------------------------------------
  // "scanner pop" detection -- the real version of this isn't "wait
  // for any volume": a momentum/gap scanner alerts when a stock is
  // suddenly trading multiples of its own recent pace. We look for
  // the first bar whose dollar volume (price × shares, so it scales
  // sensibly across both $0.50 and $5 names) spikes well above the
  // trailing average of the bars just before it -- that's the bar a
  // real scanner would've actually flagged. (A flat daily average
  // isn't used as the baseline: one unrelated high-volume day can
  // permanently skew a stock's 30-day average, which would make a
  // genuine intraday pop look unremarkable by comparison.) Earlier
  // bars aren't deleted; they stay on the chart as pre-alert history,
  // same as your own charting platform would show once you pull the
  // chart up after getting the alert.
  // ---------------------------------------------------------------
  const SCANNER_LOOKBACK = 10;         // bars of trailing "normal" pace to compare against
  const SCANNER_SURGE_MULT = 5;        // needs to be running ~5x that trailing pace
  const SCANNER_MIN_BAR_DOLLAR_VOL = 50000; // a single 1-min bar worth at least ~$50k to count as "loud"

  function computeScannerPopIndex(trade) {
    const bars = trade.bars;
    if (!Array.isArray(bars) || !bars.length) return 0;
    const dollarVol = (b) => (Number(b.v) || 0) * (Number(b.c) || 0);
    for (let i = 1; i < bars.length; i++) {
      const start = Math.max(0, i - SCANNER_LOOKBACK);
      const priorSlice = bars.slice(start, i);
      const priorAvg = priorSlice.reduce((s, b) => s + dollarVol(b), 0) / priorSlice.length;
      const cur = dollarVol(bars[i]);
      if (cur < SCANNER_MIN_BAR_DOLLAR_VOL) continue;
      if (priorAvg === 0 || cur >= priorAvg * SCANNER_SURGE_MULT) return i;
    }
    // never surged -- fall back to just skipping the dead, zero-volume open
    for (let i = 0; i < bars.length; i++) {
      if (Number(bars[i].v) > 0) return i;
    }
    return 0;
  }

  function loadChart(id, resumeFrom) {
    stopPlayback();
    fetchDetail(id).then((trade) => {
      if (!trade || !Array.isArray(trade.bars) || !trade.bars.length) {
        alert("Couldn't load that chart's data.");
        return;
      }
      state.trade = trade;
      state.bars = trade.bars;
      state.barIndex = resumeFrom ? Math.min(resumeFrom.barIndex || 0, trade.bars.length - 1) : computeScannerPopIndex(trade);
      state.tickIndex = 0;
      state.prevClose = state.barIndex > 0 ? state.bars[state.barIndex - 1].c : null;
      state.ticks = genSecondTicks(state.bars[state.barIndex], state.prevClose, `${trade.id}:practice:${state.barIndex}`);
      state.position = resumeFrom ? resumeFrom.position || null : null;
      state.fills = resumeFrom ? resumeFrom.fills || [] : [];
      state.markers = state.fills.map(fillToMarker);
      state.playing = false;
      state.ended = false;

      account.session = {
        chartId: trade.id,
        barIndex: state.barIndex,
        position: state.position,
        fills: state.fills,
      };
      saveAccount();

      els.setupScreen.style.display = "none";
      els.playScreen.style.display = "";
      els.recapBox.innerHTML = "";
      els.recapBox.style.display = "none";
      buildPlayChart();
      renderHeader();
      renderSymbolInfo(trade);
      resetSrBox();
      renderSpeedRow();
      renderSizePresets();
      renderProgress();
      renderLivePrice(state.ticks[0]);
      renderPositionPanel();
      renderFillLog();
      updatePlayPauseBtn();
    });
  }

  function fillToMarker(f) {
    return {
      time: toUnix(f.time),
      position: f.side === "buy" ? "belowBar" : "aboveBar",
      color: f.side === "buy" ? "#2fd08a" : "#f2555a",
      shape: f.side === "buy" ? "arrowUp" : "arrowDown",
      text: `${f.side.toUpperCase()} ${f.shares}@${fmtPrice(f.price)}`,
    };
  }

  function renderHeader() {
    const t = state.trade;
    els.symLine.textContent = t.symbol;
    els.dateLine.textContent = state.barIndex > 0
      ? `${t.trade_date} · picked up right as this one popped on the scanner (bar ${state.barIndex + 1} of ${state.bars.length})`
      : `${t.trade_date} · replaying from the start of this chart's data`;
  }

  // ---------------------------------------------------------------
  // symbol info card -- same "About <SYMBOL>" card trade.html shows,
  // built from the trade's own symbol_info + indicators blocks.
  // ---------------------------------------------------------------
  function fmtShares(n) {
    if (n === null || n === undefined) return null;
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return String(v);
  }
  function volumeFloatPills(trade) {
    const ind = trade.indicators || {};
    const parts = [];
    if (ind.float_shares) parts.push(`<span class="pill floattag" title="Shares outstanding (float proxy)">Float ${fmtShares(ind.float_shares)}</span>`);
    if (ind.avg_volume_30d) parts.push(`<span class="pill avgvol" title="30-day average daily volume">Avg vol ${fmtShares(ind.avg_volume_30d)}</span>`);
    if (typeof ind.relative_volume === "number") parts.push(`<span class="pill rvol" title="Entry-day volume vs. 30-day average">RVol ${ind.relative_volume.toFixed(2)}x</span>`);
    return parts.join("\n");
  }
  function renderSymbolInfo(trade) {
    const info = trade.symbol_info;
    if (!info || (!info.name && !info.description)) {
      els.symbolCard.style.display = "none";
      els.symbolCard.innerHTML = "";
      return;
    }
    els.symbolCard.style.display = "";
    els.symbolCard.innerHTML = `
      <div class="card symbol-card">
        <h2>About ${escapeHtml(trade.symbol)}</h2>
        <div class="sym-head"><span class="sym-name">${escapeHtml(info.name || trade.symbol)}</span></div>
        <div class="sym-meta-row">
          ${info.country ? `<span class="pill">${escapeHtml(info.country)}</span>` : ""}
          ${info.sector ? `<span class="pill">${escapeHtml(info.sector)}</span>` : ""}
          ${volumeFloatPills(trade)}
        </div>
        <div class="sym-desc">${escapeHtml(info.description || "")}</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // support & resistance -- same on-demand n8n webhook + price-line
  // drawing trade.js uses, wired to the practice chart's own candle
  // series instead. Nothing runs until the button is clicked.
  // ---------------------------------------------------------------
  function resetSrBox() {
    els.srBox.style.display = "";
    els.srResult.innerHTML = "";
  }
  function srLevelNote(lv) {
    return lv.label || (lv.touches ? lv.touches + "x touched" : "");
  }
  let srRequestInFlight = false;
  function runSupportResistance() {
    if (srRequestInFlight || !state.trade) return;
    if (!SR_ANALYSIS_URL) {
      els.srResult.innerHTML = `<div class="sr-status error">SR_ANALYSIS_URL isn't set yet -- point window.N8N_SR_URL in config.js at your own n8n webhook first.</div>`;
      return;
    }
    srRequestInFlight = true;
    const trade = state.trade;
    const originalLabel = els.srBtn.innerHTML;
    els.srBtn.disabled = true;
    els.srBtn.innerHTML = "Analyzing…";
    els.srResult.innerHTML = `<div class="sr-status">Reading ${escapeHtml(trade.symbol)}'s prior daily bars and computing levels — this calls out to n8n, so it can take a few seconds…</div>`;

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
        els.srResult.innerHTML = `<div class="sr-status error">Couldn't get support/resistance levels (${escapeHtml(String(err.message))}). If SR_ANALYSIS_URL in config.js still says YOUR-N8N-SUBDOMAIN, point it at your own n8n webhook first.</div>`;
      })
      .finally(() => {
        srRequestInFlight = false;
        els.srBtn.disabled = false;
        els.srBtn.innerHTML = originalLabel;
      });
  }
  function renderSrResult(data) {
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    if (!support.length && !resistance.length) {
      els.srResult.innerHTML = `<div class="sr-status">No clear levels came back for this symbol.</div>`;
      return;
    }
    const levelRow = (lv) => `<div class="lvl-row"><span>$${Number(lv.price).toFixed(2)}</span><span class="note">${escapeHtml(srLevelNote(lv))}</span></div>`;
    els.srResult.innerHTML = `
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
  function drawSrLevelsOnChart(data) {
    if (!state.chartHandle || !state.chartHandle.series) return;
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    resistance.forEach((lv) => {
      const note = srLevelNote(lv);
      state.chartHandle.series.createPriceLine({
        price: Number(lv.price), color: "#f2555a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true,
        title: note ? `resistance (${note})` : "resistance",
      });
    });
    support.forEach((lv) => {
      const note = srLevelNote(lv);
      state.chartHandle.series.createPriceLine({
        price: Number(lv.price), color: "#2fd08a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true,
        title: note ? `support (${note})` : "support",
      });
    });
  }

  // ---------------------------------------------------------------
  // chart -- same lightweight-charts setup rewind.js/trade.js use
  // (candles + volume + VWAP/EMA9/EMA20), rebuilt fresh per chart
  // load and progressively fed bars as playback advances.
  // ---------------------------------------------------------------
  function buildPlayChart() {
    if (state.chartHandle) teardownChart(state.chartHandle);
    const el = els.chartEl;
    el.innerHTML = "";
    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830", minimumWidth: 88 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: 420 });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.12, bottom: 0.2 } });
    const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const vwapSeries = chart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ema9Series = chart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ema20Series = chart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch (e) {} });
      ro.observe(el);
    }
    state.chartHandle = { chart, series, volSeries, vwapSeries, ema9Series, ema20Series, resizeObserver: ro };

    // seed with every bar fully closed up to (not including) barIndex
    const closed = state.bars.slice(0, state.barIndex);
    seedSeries(closed);
    paintFormingBar();
    if (state.markers.length) series.setMarkers(state.markers);
    chart.timeScale().fitContent();
  }
  function teardownChart(handle) {
    if (!handle) return;
    try { if (handle.resizeObserver) handle.resizeObserver.disconnect(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
  }
  function seedSeries(bars) {
    const h = state.chartHandle;
    h.series.setData(bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    h.volSeries.setData(bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" })));
    h.vwapSeries.setData(bars.filter((b) => b.vwap != null).map((b) => ({ time: toUnix(b.t), value: b.vwap })));
    h.ema9Series.setData(bars.filter((b) => b.ema9 != null).map((b) => ({ time: toUnix(b.t), value: b.ema9 })));
    h.ema20Series.setData(bars.filter((b) => b.ema20 != null).map((b) => ({ time: toUnix(b.t), value: b.ema20 })));
  }
  let runningHigh = null, runningLow = null;
  function paintFormingBar() {
    const bar = state.bars[state.barIndex];
    if (!bar) return;
    const price = state.ticks[state.tickIndex];
    if (runningHigh === null || state.tickIndex === 0) { runningHigh = bar.o; runningLow = bar.o; }
    if (price > runningHigh) runningHigh = price;
    if (price < runningLow) runningLow = price;
    const h = state.chartHandle;
    h.series.update({
      time: toUnix(bar.t), open: bar.o, high: runningHigh, low: runningLow, close: price,
      color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
    });
    const frac = (state.tickIndex + 1) / state.ticks.length;
    h.volSeries.update({ time: toUnix(bar.t), value: Math.round((bar.v || 0) * frac), color: "rgba(232,169,76,0.4)" });
    if (bar.vwap != null) h.vwapSeries.update({ time: toUnix(bar.t), value: bar.vwap });
    if (bar.ema9 != null) h.ema9Series.update({ time: toUnix(bar.t), value: bar.ema9 });
    if (bar.ema20 != null) h.ema20Series.update({ time: toUnix(bar.t), value: bar.ema20 });
  }
  function lockInBar() {
    const bar = state.bars[state.barIndex];
    const h = state.chartHandle;
    h.series.update({ time: toUnix(bar.t), open: bar.o, high: bar.h, low: bar.l, close: bar.c });
    h.volSeries.update({ time: toUnix(bar.t), value: bar.v, color: bar.c >= bar.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" });
  }

  // ---------------------------------------------------------------
  // playback engine
  // ---------------------------------------------------------------
  function currentPrice() {
    return state.ticks[state.tickIndex];
  }
  function renderLivePrice(price) {
    const prev = els.livePrice.dataset.last ? Number(els.livePrice.dataset.last) : price;
    els.livePrice.textContent = "$" + fmtPrice(price);
    els.livePrice.dataset.last = String(price);
    const delta = price - prev;
    els.liveChange.textContent = (delta >= 0 ? "▲ " : "▼ ") + fmtPrice(Math.abs(delta));
    els.liveChange.className = "pp-live-change " + (delta >= 0 ? "up" : "down");
  }
  function renderProgress() {
    const total = state.bars.length;
    const bar = state.bars[state.barIndex];
    els.progressLabel.textContent = `Bar ${state.barIndex + 1} / ${total} · ${fmtTime(bar.t)}`;
    els.progressFill.style.width = `${((state.barIndex + 1) / total) * 100}%`;
    els.progressSlider.min = String(state.barIndex);
    els.progressSlider.max = String(total - 1);
    els.progressSlider.value = String(state.barIndex);
  }

  function tick() {
    if (state.ended) return;
    state.tickIndex++;
    if (state.tickIndex >= state.ticks.length) {
      // bar finished -- lock it in and roll to the next one
      lockInBar();
      state.barIndex++;
      if (state.barIndex >= state.bars.length) {
        endSession("data ended");
        return;
      }
      state.prevClose = state.bars[state.barIndex - 1].c;
      state.tickIndex = 0;
      state.ticks = genSecondTicks(state.bars[state.barIndex], state.prevClose, `${state.trade.id}:practice:${state.barIndex}`);
      renderProgress();
      persistSession();
    }
    paintFormingBar();
    renderLivePrice(currentPrice());
    renderPositionPanel();
  }

  function startPlayback() {
    if (state.playing || state.ended) return;
    state.playing = true;
    updatePlayPauseBtn();
    const ms = BASE_TICK_MS / state.speed;
    state.timer = setInterval(tick, ms);
  }
  function stopPlayback() {
    state.playing = false;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    updatePlayPauseBtn();
  }
  function updatePlayPauseBtn() {
    if (!els.playPauseBtn) return;
    els.playPauseBtn.textContent = state.playing ? "⏸ Pause" : "▶ Play";
    els.playPauseBtn.disabled = state.ended;
  }
  function renderSpeedRow() {
    els.speedRow.innerHTML = SPEEDS.map((s) =>
      `<button class="quiz-speed-btn${s === state.speed ? " active" : ""}" data-speed="${s}">${s}x</button>`).join("");
    els.speedRow.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        state.speed = Number(b.dataset.speed);
        renderSpeedRow();
        if (state.playing) { stopPlayback(); startPlayback(); }
      });
    });
  }
  function stepOneBar() {
    if (state.ended) return;
    const wasPlaying = state.playing;
    stopPlayback();
    lockInBar();
    state.barIndex++;
    if (state.barIndex >= state.bars.length) { endSession("data ended"); return; }
    state.prevClose = state.bars[state.barIndex - 1].c;
    state.tickIndex = 0;
    state.ticks = genSecondTicks(state.bars[state.barIndex], state.prevClose, `${state.trade.id}:practice:${state.barIndex}`);
    paintFormingBar();
    renderLivePrice(currentPrice());
    renderProgress();
    renderPositionPanel();
    persistSession();
    if (wasPlaying) startPlayback();
  }
  function scrubTo(targetBarIndex) {
    if (state.ended) return;
    stopPlayback();
    targetBarIndex = Math.max(state.barIndex, Math.min(targetBarIndex, state.bars.length - 1));
    while (state.barIndex < targetBarIndex) {
      lockInBar();
      state.barIndex++;
      state.prevClose = state.bars[state.barIndex - 1].c;
    }
    state.tickIndex = 0;
    state.ticks = genSecondTicks(state.bars[state.barIndex], state.prevClose, `${state.trade.id}:practice:${state.barIndex}`);
    seedSeries(state.bars.slice(0, state.barIndex));
    paintFormingBar();
    renderLivePrice(currentPrice());
    renderProgress();
    renderPositionPanel();
    persistSession();
  }

  function endSession(reason) {
    stopPlayback();
    state.ended = true;
    // flatten any open position at the last available price, just like
    // a broker would force-close at the close of the available tape
    if (state.position && state.position.shares > 0) {
      executeOrder(state.position.side === "long" ? "sell" : "buy", state.position.shares, true);
    }
    updatePlayPauseBtn();
    renderRecap();
    account.session = null;
    saveAccount();
  }

  function renderRecap() {
    const t = state.trade;
    const st = accountStats();
    const sessionFills = state.fills;
    const sessionPnl = sessionFills.reduce((s, f) => s + (f.realizedPnl || 0), 0);
    els.recapBox.style.display = "";
    els.recapBox.innerHTML = `
      <div class="panel-box-head"><span class="title">Session complete</span></div>
      <div class="pr-recap-grid">
        <div class="pr-recap-col">
          <div class="rb-label">What you did</div>
          <div class="rb-line">Fills placed: <b>${sessionFills.length}</b></div>
          <div class="rb-line">Session P&amp;L: <b class="${sessionPnl >= 0 ? "up" : "down"}">${fmtMoney(sessionPnl)}</b></div>
          <div class="rb-line">Account balance now: <b>${fmtUsd(account.balance)}</b></div>
        </div>
        <div class="pr-recap-col">
          <div class="rb-label">What actually happened on this trade</div>
          <div class="rb-line">${t.side.toUpperCase()} ${t.shares} sh · entered <b>$${fmtPrice(t.entry_price)}</b> at ${escapeHtml(t.entry_time)}, exited <b>$${fmtPrice(t.exit_price)}</b> at ${escapeHtml(t.exit_time)}</div>
          <div class="rb-line">Real result: <b class="${t.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</b> after commission</div>
          ${t.verdict ? `<div class="rb-line" style="margin-top:8px;">${escapeHtml(t.verdict)}</div>` : ""}
        </div>
      </div>
      <div class="quiz-summary-actions" style="margin-top:16px;">
        <button class="btn-confirm" id="pr-recap-again-btn">Practice another chart</button>
        <a class="btn-advanced" href="trade.html?id=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">View the real trade</a>
      </div>
    `;
    document.getElementById("pr-recap-again-btn").addEventListener("click", goToSetup);
  }

  // ---------------------------------------------------------------
  // order execution -- BUY/SELL work exactly like at a real broker:
  // cash always moves by ∓(notional + commission); which side of
  // your position that nets against (open, add, reduce, close, or
  // flip) falls out of the math on its own. Shorting requires the
  // same cash collateral as a long would (simple 1:1 "Reg-T-ish"
  // guard, not full margin modeling), and closing more than you
  // hold flips you to the other side for the remainder -- also just
  // like a real order that exceeds your position.
  // ---------------------------------------------------------------
  function buyingPower() {
    return account.balance;
  }
  function positionMarketValue(price) {
    if (!state.position) return 0;
    const sign = state.position.side === "long" ? 1 : -1;
    return sign * state.position.shares * price;
  }
  function accountEquity(price) {
    return account.balance + positionMarketValue(price);
  }

  function executeOrder(sideStr, shares, silent) {
    shares = Math.floor(Number(shares));
    if (!(shares > 0)) { if (!silent) showOrderMsg("Enter a positive number of shares.", true); return; }
    if (state.ended) return;
    const price = currentPrice();
    const commission = ibkrTieredCommission(shares, price);
    const pos = state.position;
    let realizedPnl = null;

    if (sideStr === "buy") {
      if (pos && pos.side === "short") {
        const closing = Math.min(shares, pos.shares);
        realizedPnl = (pos.avgPrice - price) * closing - commission * (closing / shares);
      }
      const cost = shares * price + commission;
      if (!silent && cost > buyingPower() + 1e-6) { showOrderMsg(`Not enough buying power (need ${fmtUsd(cost)}, have ${fmtUsd(buyingPower())}).`, true); return; }
      account.balance -= cost;
      applyFill(pos, "buy", shares, price);
    } else {
      if (pos && pos.side === "long") {
        const closing = Math.min(shares, pos.shares);
        realizedPnl = (price - pos.avgPrice) * closing - commission * (closing / shares);
      } else if (!silent) {
        // opening or adding to a short -- require cash collateral
        // (forced liquidations skip this -- a broker closing you out
        // never gets blocked by your own buying power)
        const openingExtra = pos && pos.side === "short" ? shares : Math.max(0, shares - (pos ? pos.shares : 0));
        const collateral = openingExtra * price;
        if (collateral > buyingPower() + 1e-6) { showOrderMsg(`Not enough buying power to short (need ${fmtUsd(collateral)} collateral).`, true); return; }
      }
      const proceeds = shares * price - commission;
      account.balance += proceeds;
      applyFill(pos, "sell", shares, price);
    }

    const fill = {
      time: state.bars[state.barIndex].t,
      chartId: state.trade.id,
      symbol: state.trade.symbol,
      side: sideStr,
      shares,
      price,
      commission,
      realizedPnl,
    };
    state.fills.push(fill);
    account.fills.push(fill);
    state.markers.push(fillToMarker(fill));
    state.chartHandle.series.setMarkers(state.markers);

    persistSession();
    saveAccount();
    renderPositionPanel();
    renderFillLog();
    renderAccountPanel();
    if (!silent) showOrderMsg(`${sideStr.toUpperCase()} ${shares} @ $${fmtPrice(price)} · commission ${fmtUsd(commission)}`, false);
  }

  function applyFill(pos, sideStr, shares, price) {
    const sign = sideStr === "buy" ? 1 : -1; // +shares for buy, -shares for sell
    let signedShares = pos ? (pos.side === "long" ? pos.shares : -pos.shares) : 0;
    signedShares += sign * shares;
    if (Math.abs(signedShares) < 1e-9) {
      state.position = null;
      return;
    }
    const newSide = signedShares > 0 ? "long" : "short";
    if (!pos || pos.side !== newSide) {
      // flipped (or opened fresh) -- new leg starts its own avg price
      // using whatever quantity ends up on the new side
      state.position = { side: newSide, shares: Math.abs(signedShares), avgPrice: price };
      return;
    }
    // same side as before: adding grows shares at a blended average;
    // reducing keeps the same average price on what's left
    const wasAdding = (pos.side === "long" && sideStr === "buy") || (pos.side === "short" && sideStr === "sell");
    if (wasAdding) {
      const totalShares = pos.shares + shares;
      const avgPrice = (pos.avgPrice * pos.shares + price * shares) / totalShares;
      state.position = { side: pos.side, shares: totalShares, avgPrice };
    } else {
      state.position = { side: pos.side, shares: Math.abs(signedShares), avgPrice: pos.avgPrice };
    }
  }

  function showOrderMsg(text, isError) {
    els.orderMsg.textContent = text;
    els.orderMsg.className = "pp-order-msg" + (isError ? " err" : "");
    clearTimeout(showOrderMsg._t);
    showOrderMsg._t = setTimeout(() => { els.orderMsg.textContent = ""; }, 4000);
  }

  function renderPositionPanel() {
    const price = currentPrice();
    const pos = state.position;
    if (!pos) {
      els.posSummary.innerHTML = `<span class="flat">Flat — no open position</span>`;
    } else {
      const unreal = (pos.side === "long" ? price - pos.avgPrice : pos.avgPrice - price) * pos.shares;
      els.posSummary.innerHTML = `
        <span class="side-pill ${pos.side}">${pos.side.toUpperCase()}</span>
        <span class="mono">${pos.shares} sh @ $${fmtPrice(pos.avgPrice)}</span>
        <span class="mono ${unreal >= 0 ? "up" : "down"}">${fmtMoney(unreal)} unrealized</span>
      `;
    }
    els.cashLine.textContent = fmtUsd(account.balance);
    els.equityLine.textContent = fmtUsd(accountEquity(price));
    els.bpLine.textContent = fmtUsd(buyingPower());
  }

  function renderFillLog() {
    if (!state.fills.length) {
      els.fillLog.innerHTML = `<div class="pr-empty">No fills yet this session.</div>`;
      return;
    }
    els.fillLog.innerHTML = state.fills.slice().reverse().map((f) => `
      <div class="pr-fill-row">
        <span class="fr-time mono">${escapeHtml(fmtTime(f.time))}</span>
        <span class="side-pill ${f.side === "buy" ? "long" : "short"}">${f.side.toUpperCase()}</span>
        <span class="fr-detail">${f.shares} sh @ $${fmtPrice(f.price)}</span>
        <span class="fr-comm mono">-${fmtUsd(f.commission)}</span>
        <span class="fr-pnl ${f.realizedPnl == null ? "" : f.realizedPnl >= 0 ? "up" : "down"}">${f.realizedPnl == null ? "—" : fmtMoney(f.realizedPnl)}</span>
      </div>
    `).join("");
  }

  function renderSizePresets() {
    els.presetRow.innerHTML = SIZE_PRESETS.map((s) => `<button class="quiz-preset-btn" data-size="${s}">${s} sh</button>`).join("");
    els.presetRow.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => { els.sharesInput.value = b.dataset.size; });
    });
  }

  function persistSession() {
    if (!account.session) return;
    account.session.barIndex = state.barIndex;
    account.session.position = state.position;
    account.session.fills = state.fills;
    saveAccount();
  }

  function goToSetup() {
    stopPlayback();
    if (state.chartHandle) teardownChart(state.chartHandle);
    state.chartHandle = null;
    els.playScreen.style.display = "none";
    els.setupScreen.style.display = "";
    renderAccountPanel();
    renderCandidates();
  }

  // ---------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------
  els.resetBtn.addEventListener("click", resetAccount);
  els.search.addEventListener("input", renderCandidates);
  els.setupSelect.addEventListener("change", renderCandidates);
  els.randomBtn.addEventListener("click", pickRandomCandidate);
  els.resumeBtn.addEventListener("click", () => {
    const sess = account.session;
    if (!sess) return;
    loadChart(sess.chartId, sess);
  });
  els.changeChartBtn.addEventListener("click", () => {
    if (state.position && state.position.shares > 0) {
      if (!confirm("You still have an open position on this chart. Leaving now will flatten it at the current price. Continue?")) return;
      endSession("changed chart");
      return;
    }
    account.session = null;
    saveAccount();
    goToSetup();
  });
  els.playPauseBtn.addEventListener("click", () => { state.playing ? stopPlayback() : startPlayback(); });
  els.stepBtn.addEventListener("click", stepOneBar);
  els.skipBtn.addEventListener("click", () => {
    if (!confirm("Skip to the end of this chart? Any open position will be closed at the final price.")) return;
    stopPlayback();
    while (state.barIndex < state.bars.length - 1) {
      lockInBar();
      state.barIndex++;
      state.prevClose = state.bars[state.barIndex - 1].c;
    }
    state.tickIndex = state.bars.length ? REPLAY_SECONDS - 1 : 0;
    state.ticks = genSecondTicks(state.bars[state.barIndex], state.prevClose, `${state.trade.id}:practice:${state.barIndex}`);
    seedSeries(state.bars.slice(0, state.barIndex));
    paintFormingBar();
    lockInBar();
    renderProgress();
    endSession("skipped");
  });
  els.progressSlider.addEventListener("change", () => scrubTo(Number(els.progressSlider.value)));
  els.buyBtn.addEventListener("click", () => executeOrder("buy", els.sharesInput.value));
  els.sellBtn.addEventListener("click", () => executeOrder("sell", els.sharesInput.value));
  els.srBtn.addEventListener("click", runSupportResistance);

  // ---------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------
  fetch("data/trades.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      populateSetupOptions();
      renderAccountPanel();
      renderCandidates();
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load data/trades.json.";
    });
})();
