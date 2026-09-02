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

  // Handoff key report.html's "Practice this trade" button writes a
  // backtest trade into before opening this page -- lets you paper-trade
  // a symbol the systematic backtester flagged, same as you can for a
  // real logged journal trade, just without a data/trades/<id>.json file
  // to fetch (the backtest trade already carries its own bars).
  const PENDING_BACKTEST_KEY = "practice:pending_backtest_trade";

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

    randomBtn: document.getElementById("pf-random-btn"),
    candidateCount: document.getElementById("pf-candidate-count"),

    // play screen
    symLine: document.getElementById("pp-symbol-line"),
    dateLine: document.getElementById("pp-date-line"),
    modeBadge: document.getElementById("pp-mode-badge"),
    replayBtn: document.getElementById("pp-replay-btn"),
    changeChartBtn: document.getElementById("pp-change-chart-btn"),
    chartWrap: document.getElementById("pp-chart-wrap"),
    chartEl: document.getElementById("pp-candle-chart"),

    playPauseBtn: document.getElementById("pp-playpause-btn"),
    speedRow: document.getElementById("pp-speed-row"),
    stepBackBtn: document.getElementById("pp-step-back-btn"),
    stepBtn: document.getElementById("pp-step-btn"),
    skipBtn: document.getElementById("pp-skip-btn"),
    progressLabel: document.getElementById("pp-progress-label"),
    progressFill: document.getElementById("pp-progress-fill"),
    progressSlider: document.getElementById("pp-progress-slider"),

    livePrice: document.getElementById("pp-live-price"),
    liveChange: document.getElementById("pp-live-change"),
    bidVal: document.getElementById("pp-bid-val"),
    askVal: document.getElementById("pp-ask-val"),
    spreadVal: document.getElementById("pp-spread-val"),
    rangeVal: document.getElementById("pp-range-val"),
    volVal: document.getElementById("pp-vol-val"),

    qtyDecBtn: document.getElementById("pp-qty-dec"),
    qtyIncBtn: document.getElementById("pp-qty-inc"),

    shortcutsRow: document.getElementById("pp-shortcuts-row"),
    shortcutsGearBtn: document.getElementById("pp-shortcuts-gear-btn"),
    headShortcutsGearBtn: document.getElementById("pr-shortcuts-gear-btn"),

    sizeModeRow: document.getElementById("pp-size-mode-row"),
    sizeUnit: document.getElementById("pp-size-unit"),
    sizePreview: document.getElementById("pp-size-preview"),
    sharesInput: document.getElementById("pp-shares-input"),
    presetRow: document.getElementById("pp-size-preset-row"),
    buyBtn: document.getElementById("pp-buy-btn"),
    sellBtn: document.getElementById("pp-sell-btn"),
    orderMsg: document.getElementById("pp-order-msg"),

    posSummary: document.getElementById("pp-pos-summary"),
    partialExitRow: document.getElementById("pp-partial-exit-row"),
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

  // Synthetic bid/ask spread -- real brokers never fill you at the
  // "last price" you're staring at; a market buy crosses to the ask
  // and a market sell crosses to the bid. There's no real Level-1 feed
  // behind this offline replay, so the spread is a simple, deterministic
  // function of price (tighter, in relative terms, for higher-priced
  // names) rather than anything read off the bars -- just enough to make
  // fills (and the small "instantly down a few cents" unrealized P&L
  // right after entering) feel like a real ticket instead of trading
  // at a single frictionless number.
  function roundPrice(p) { return Math.round(p * 10000) / 10000; }
  function spreadFor(price) {
    if (!(price > 0)) return 0.01;
    return Math.max(0.01, price * 0.0006);
  }
  function bidPrice(price) { return roundPrice(price - spreadFor(price) / 2); }
  function askPrice(price) { return roundPrice(price + spreadFor(price) / 2); }

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
  // The dataset's logged trade.commission field (and the pnl_after_comm
  // derived from it) is noisy and doesn't track any consistent fee
  // schedule -- e.g. two 50-share trades in the same price range are
  // logged at $0.02 and $2.01 commission -- so trusting it verbatim for
  // "what actually happened" made the real trade look far cheaper (or
  // pricier) than the same size would really cost under IBKR's schedule,
  // and made it incomparable with your own simulated fills, which do use
  // that schedule. Recompute the real trade's commission and net P&L the
  // same way, from its own shares and entry/exit prices, instead.
  function realisticActualCommission(trade) {
    const shares = Number(trade.shares) || 0;
    return ibkrTieredCommission(shares, Number(trade.entry_price)) + ibkrTieredCommission(shares, Number(trade.exit_price));
  }
  function realisticActualNet(trade) {
    // Backtest-sourced trades already carry a net P&L computed by the
    // backtest engine under one consistent commission schedule -- unlike
    // the noisy logged-journal commission field this function normally
    // works around, there's nothing to recompute here.
    if (trade.source === "backtest") {
      const net = Number(trade.pnl_dollars);
      if (Number.isFinite(net)) return net;
    }
    const gross = Number(trade.pnl_before_comm);
    if (!Number.isFinite(gross)) return Number(trade.pnl_after_comm) || 0;
    return gross - realisticActualCommission(trade);
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
      sizeMode: "shares", // "shares" (raw share count) or "pct" (% of buying power at order time)
    };
  }
  function loadAccount() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      if (!raw) return defaultAccount();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Number.isFinite(parsed.balance)) return defaultAccount();
      if (!Array.isArray(parsed.fills)) parsed.fills = [];
      delete parsed.longOnly; // no shorting anymore -- long-only is the only mode, not a toggle
      if (parsed.sizeMode !== "shares" && parsed.sizeMode !== "pct") parsed.sizeMode = "shares";
      return parsed;
    } catch (e) { return defaultAccount(); }
  }
  function saveAccount() {
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch (e) { /* ignore -- practice still works without persistence */ }
    // Mirror to Supabase (user_kv) so the paper account isn't stranded on
    // one browser -- see KV in auth.js.
    if (window.KV) window.KV.set(ACCOUNT_KEY, account);
  }

  let account = loadAccount();

  // Once auth.js has this user's synced account down, a remote copy wins
  // (cross-device source of truth); otherwise whatever's local right now
  // gets pushed up as the seed. Re-renders the account panel if the page
  // is already showing stale data by the time this resolves.
  if (window.KV) {
    window.KV.sync(ACCOUNT_KEY, function (remote) {
      if (!remote || typeof remote !== "object" || !Number.isFinite(remote.balance)) return;
      account = remote;
      if (!Array.isArray(account.fills)) account.fills = [];
      try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch (e) { /* ignore */ }
      if (typeof renderAccountPanel === "function") renderAccountPanel();
    });
  }

  // ---------------------------------------------------------------
  // order shortcuts -- user-defined one-click buy/sell buttons, each
  // with an optional single-key hotkey. Persisted separately from the
  // account (they're a ticket preference, not part of the P&L record)
  // so resetting the account doesn't wipe them.
  // ---------------------------------------------------------------
  const SHORTCUTS_KEY = "practice:shortcuts:v1";
  function defaultShortcuts() {
    return [
      { id: "sc-buy100", label: "Buy 100", side: "buy", sizeType: "shares", value: 100, key: "1" },
      { id: "sc-buy25bp", label: "Buy 25% BP", side: "buy", sizeType: "pct_bp", value: 25, key: "2" },
      { id: "sc-sellhalf", label: "Sell Half", side: "sell", sizeType: "pct_position", value: 50, key: "3" },
      { id: "sc-flatten", label: "Flatten", side: "sell", sizeType: "pct_position", value: 100, key: "4" },
    ];
  }
  function shortcutSizeLabel(s) {
    if (s.sizeType === "shares") return `${s.value} sh`;
    if (s.sizeType === "pct_bp") return `${s.value}% BP`;
    return s.value >= 100 ? "All" : `${s.value}%`;
  }
  function defaultLabelFor(s) {
    return s.sizeType === "pct_position" && s.value >= 100 ? "Flatten" : `${s.side === "buy" ? "Buy" : "Sell"} ${shortcutSizeLabel(s)}`;
  }
  function normalizeShortcut(s) {
    const sizeType = ["shares", "pct_bp", "pct_position"].includes(s.sizeType) ? s.sizeType : "shares";
    const side = s.side === "sell" ? "sell" : "buy";
    const value = Number(s.value) > 0 ? Number(s.value) : 100;
    const norm = {
      id: s.id || ("sc" + Math.random().toString(36).slice(2, 9)),
      side, sizeType, value,
      key: (s.key || "").toString().trim().slice(0, 1),
    };
    norm.label = String(s.label || "").slice(0, 24) || defaultLabelFor(norm);
    return norm;
  }
  function loadShortcuts() {
    try {
      const raw = localStorage.getItem(SHORTCUTS_KEY);
      if (!raw) return defaultShortcuts();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return defaultShortcuts();
      return parsed.filter((s) => s && typeof s === "object").map(normalizeShortcut);
    } catch (e) { return defaultShortcuts(); }
  }
  function saveShortcuts() {
    try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts)); } catch (e) { /* ignore */ }
    if (window.KV) window.KV.set(SHORTCUTS_KEY, shortcuts);
  }
  let shortcuts = loadShortcuts();

  if (window.KV) {
    window.KV.sync(SHORTCUTS_KEY, function (remote) {
      if (!Array.isArray(remote)) return;
      shortcuts = remote.filter((s) => s && typeof s === "object").map(normalizeShortcut);
      try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts)); } catch (e) { /* ignore */ }
      if (typeof renderShortcutsRow === "function") renderShortcutsRow();
    });
  }

  // Shares a shortcut resolves to right now, at the current tick's
  // price and account state -- same "decide the quantity at the
  // instant you click" spirit as the % of buying power size mode.
  function resolveShortcutShares(s) {
    if (s.sizeType === "shares") return Math.floor(s.value);
    const mid = currentPrice();
    if (s.sizeType === "pct_bp") {
      const price = s.side === "buy" ? askPrice(mid) : bidPrice(mid);
      return pctToShares(s.value, price);
    }
    // pct_position -- meaningless while flat; only ever closes a long
    const held = state.position ? state.position.shares : 0;
    if (!(held > 0)) return 0;
    return s.value >= 100 ? held : Math.max(1, Math.floor(held * (s.value / 100)));
  }

  function runShortcut(id) {
    const s = shortcuts.find((x) => x.id === id);
    if (!s || !state.trade || state.ended) return;
    if (s.side === "sell" && !(state.position && state.position.shares > 0)) {
      showOrderMsg("No open position to sell.", true);
      return;
    }
    const shares = resolveShortcutShares(s);
    if (!(shares > 0)) { showOrderMsg("That shortcut resolved to 0 shares.", true); return; }
    executeOrder(s.side, shares);
  }

  function renderShortcutsRow() {
    if (!els.shortcutsRow) return;
    if (!state.trade) { els.shortcutsRow.innerHTML = ""; return; }
    els.shortcutsRow.innerHTML = shortcuts.map((s) => {
      const disabled = state.ended || (s.side === "sell" && !(state.position && state.position.shares > 0));
      const keyBadge = s.key ? `<span class="pp-shortcut-key">${escapeHtml(s.key.toUpperCase())}</span>` : "";
      return `<button type="button" class="pp-shortcut-btn ${s.side}" data-id="${s.id}"${disabled ? " disabled" : ""}>${keyBadge}${escapeHtml(s.label)}</button>`;
    }).join("");
    els.shortcutsRow.querySelectorAll(".pp-shortcut-btn").forEach((b) => {
      b.addEventListener("click", () => runShortcut(b.dataset.id));
    });
  }

  // Settings modal -- built by hand (not UIModal's confirm/prompt) since
  // it needs an editable, add/removable list rather than a single value.
  // Edits a working copy so Cancel truly discards unsaved changes.
  function openShortcutsModal() {
    const draft = shortcuts.map((s) => Object.assign({}, s));

    const overlay = document.createElement("div");
    overlay.className = "ui-modal-overlay pp-shortcuts-modal";
    overlay.innerHTML = `
      <div class="ui-modal-box" role="dialog" aria-modal="true">
        <div class="ui-modal-title">Order shortcuts</div>
        <div class="pp-sc-table" id="pp-sc-table"></div>
        <div class="pp-sc-addrow"><button type="button" class="btn-advanced" id="pp-sc-add-btn">+ Add shortcut</button></div>
        <div class="ui-modal-actions">
          <button type="button" class="btn-advanced" data-act="cancel">Cancel</button>
          <button type="button" class="btn-confirm" data-act="save">Save shortcuts</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const table = overlay.querySelector("#pp-sc-table");

    function autoLabelIfUnset(i) {
      if (draft[i]._customLabel && draft[i].label) return;
      draft[i].label = defaultLabelFor(draft[i]);
      const input = table.querySelector(`.pp-sc-row[data-i="${i}"] .sc-label`);
      if (input) input.value = draft[i].label;
    }

    function renderRows() {
      if (!draft.length) {
        table.innerHTML = `<div class="pp-sc-empty">No shortcuts yet — add one below.</div>`;
        return;
      }
      table.innerHTML = draft.map((s, i) => `
        <div class="pp-sc-row" data-i="${i}">
          <input type="text" class="sc-label" maxlength="24" value="${escapeHtml(s.label || "")}" placeholder="Label">
          <select class="sc-side">
            <option value="buy" ${s.side === "buy" ? "selected" : ""}>Buy</option>
            <option value="sell" ${s.side === "sell" ? "selected" : ""}>Sell</option>
          </select>
          <select class="sc-type">
            <option value="shares" ${s.sizeType === "shares" ? "selected" : ""}>Shares (fixed)</option>
            <option value="pct_bp" ${s.sizeType === "pct_bp" ? "selected" : ""}>% of buying power</option>
            <option value="pct_position" ${s.sizeType === "pct_position" ? "selected" : ""}>% of position (sell)</option>
          </select>
          <input type="number" class="sc-value" min="1" step="1" value="${Number(s.value) || 100}">
          <input type="text" class="sc-key pp-sc-key" maxlength="1" value="${escapeHtml(s.key || "")}" placeholder="key">
          <button type="button" class="pp-sc-del" title="Remove shortcut" aria-label="Remove shortcut">×</button>
        </div>
      `).join("");

      table.querySelectorAll(".pp-sc-row").forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelector(".sc-label").addEventListener("input", (e) => { draft[i].label = e.target.value; draft[i]._customLabel = true; });
        row.querySelector(".sc-side").addEventListener("change", (e) => { draft[i].side = e.target.value; autoLabelIfUnset(i); });
        row.querySelector(".sc-type").addEventListener("change", (e) => { draft[i].sizeType = e.target.value; autoLabelIfUnset(i); });
        row.querySelector(".sc-value").addEventListener("input", (e) => { draft[i].value = Number(e.target.value) || 0; autoLabelIfUnset(i); });
        row.querySelector(".sc-key").addEventListener("input", (e) => { draft[i].key = e.target.value.slice(-1); });
        row.querySelector(".pp-sc-del").addEventListener("click", () => { draft.splice(i, 1); renderRows(); });
      });
    }
    renderRows();

    overlay.querySelector("#pp-sc-add-btn").addEventListener("click", () => {
      draft.push({ id: "sc" + Math.random().toString(36).slice(2, 9), label: "Buy 100", side: "buy", sizeType: "shares", value: 100, key: "" });
      renderRows();
    });

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc, true);
      overlay.classList.remove("open");
      setTimeout(() => overlay.remove(), 160);
    }
    function onEsc(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onEsc, true);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", close);
    overlay.querySelector('[data-act="save"]').addEventListener("click", () => {
      const seenKeys = new Set();
      shortcuts = draft.map((s) => {
        const norm = normalizeShortcut(s);
        if (norm.key && seenKeys.has(norm.key.toLowerCase())) norm.key = "";
        if (norm.key) seenKeys.add(norm.key.toLowerCase());
        return norm;
      });
      saveShortcuts();
      renderShortcutsRow();
      close();
    });

    requestAnimationFrame(() => overlay.classList.add("open"));
  }

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
  const SHARE_PRESETS = [50, 100, 200, 500];
  const PCT_PRESETS = [10, 25, 50, 100];

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
      if (account.session.backtestTrade) {
        const bt = account.session.backtestTrade;
        els.resumeLabel.textContent = `${bt.symbol} — ${bt.trade_date} (bar ${account.session.barIndex + 1}) · from backtest`;
      } else {
        const idxRow = state.index.find((r) => r.id === account.session.chartId);
        els.resumeLabel.textContent = idxRow
          ? `${idxRow.symbol} — ${idxRow.trade_date} (bar ${account.session.barIndex + 1})`
          : `Chart ${account.session.chartId} (bar ${account.session.barIndex + 1})`;
      }
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

  async function resetAccount() {
    const ok = await UIModal.confirm("Reset your practice account? This clears your balance, fill history, and equity curve. This can't be undone.", { title: "Reset account?", tone: "danger", confirmLabel: "Reset account" });
    if (!ok) return;
    const input = await UIModal.prompt("Starting balance for the new account:", String(account.startingBalance || DEFAULT_STARTING_BALANCE), { title: "New starting balance", inputType: "number", confirmLabel: "Create account" });
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
  // setup screen -- single "pick a random chart" CTA over
  // data/trades.json (same source rewind.js indexes). Used to be a
  // search box + setup-type filter + scrollable candidate list;
  // simplified down to just the random pick, since in practice
  // nobody was browsing the list -- they wanted a chart to trade.
  // ---------------------------------------------------------------
  function updateCandidateCount() {
    const n = state.index.length;
    els.candidateCount.innerHTML = `<b>${n}</b> chart${n === 1 ? "" : "s"} available`;
  }

  function pickRandomCandidate(excludeId) {
    const rows = state.index;
    if (!rows.length) return;
    const pool = excludeId && rows.length > 1 ? rows.filter((r) => r.id !== excludeId) : rows;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    loadChart(pick.id);
  }

  // ---------------------------------------------------------------
  // loading a chart -- fetches the same per-trade bar window
  // rewind.html reveals piece by piece, but here you get the whole
  // thing to trade against, starting from its very first bar.
  // ---------------------------------------------------------------
  function fetchDetail(id) {
    return window.fetchTradeDetail(id).catch(() => null);
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
  const SCANNER_CONFIRM_BARS = 3;      // bars right after the spike that need to keep pace
  const SCANNER_CONFIRM_MULT = 2;      // "keeping pace" = still running ~2x the trailing baseline
  const SCANNER_CONFIRM_MOVE_PCT = 0.015; // ...or price itself kept moving >=1.5% across that window

  function computeScannerPopIndex(trade) {
    const bars = trade.bars;
    if (!Array.isArray(bars) || !bars.length) return 0;
    const dollarVol = (b) => (Number(b.v) || 0) * (Number(b.c) || 0);
    // Baseline is the pace at the very start of this chart's data -- fixed
    // once, not a window that rolls forward with i. A rolling "prior N
    // bars" baseline climbs right along with a gradual ramp, so by the
    // time a bar finally looks "5x the recent pace" the move is often
    // already well underway and playback starts in the middle of it.
    // Anchoring to the quiet opening bars instead catches the first bar
    // that would actually have popped up on a scanner.
    const baseSlice = bars.slice(0, Math.min(SCANNER_LOOKBACK, bars.length));
    const baselineAvg = baseSlice.reduce((s, b) => s + dollarVol(b), 0) / baseSlice.length;

    // A single loud bar isn't enough on its own -- a stray block trade or
    // bad print can spike one bar 5x and then immediately go quiet again,
    // which is what was producing "starts on a candle, then 20 flat ones"
    // in practice. A real scanner alert corresponds to a move that keeps
    // going, so a candidate only counts once the following few bars either
    // keep running hot or the price itself keeps moving in that burst.
    function isConfirmed(i) {
      const windowBars = bars.slice(i, Math.min(i + SCANNER_CONFIRM_BARS, bars.length));
      if (!windowBars.length) return true; // nothing left to confirm against -- take it as-is
      const windowAvg = windowBars.reduce((s, b) => s + dollarVol(b), 0) / windowBars.length;
      if (baselineAvg > 0 && windowAvg >= baselineAvg * SCANNER_CONFIRM_MULT) return true;
      const startPrice = Number(bars[i].o ?? bars[i].c) || 0;
      const endPrice = Number(windowBars[windowBars.length - 1].c) || 0;
      if (startPrice > 0 && Math.abs(endPrice - startPrice) / startPrice >= SCANNER_CONFIRM_MOVE_PCT) return true;
      return false;
    }

    for (let i = 0; i < bars.length; i++) {
      const cur = dollarVol(bars[i]);
      if (cur < SCANNER_MIN_BAR_DOLLAR_VOL) continue;
      if ((baselineAvg === 0 || cur >= baselineAvg * SCANNER_SURGE_MULT) && isConfirmed(i)) return i;
    }
    // never surged (confirmed) -- fall back to just skipping the dead, zero-volume open
    for (let i = 0; i < bars.length; i++) {
      if (Number(bars[i].v) > 0) return i;
    }
    return 0;
  }

  function loadChart(id, resumeFrom) {
    stopPlayback();
    fetchDetail(id).then((trade) => {
      if (!trade || !Array.isArray(trade.bars) || !trade.bars.length) {
        UIModal.alert("Couldn't load that chart's data.", { title: "Load failed", tone: "danger" });
        return;
      }
      trade.source = trade.source || "journal";
      startSession(trade, resumeFrom);
    });
  }

  // Normalizes a trade object handed off from the Backtester's report
  // page (report.js's `t`: symbol, date, bars, entry/exit price+time,
  // pnl_dollars(_gross), commission_total, r_multiple, win, verdict,
  // better_entry/exit_price) into the same shape loadChart() produces,
  // so every downstream function (header, recap, ticks, session
  // persistence) can treat it like any other trade.
  function normalizeBacktestTrade(raw) {
    const id = raw.id || `bt:${raw.job_id || raw.jobId || "run"}:${raw.symbol}:${raw.date || raw.trade_date}:${raw.entry_time || ""}`;
    return Object.assign({}, raw, {
      id,
      trade_date: raw.trade_date || raw.date,
      source: "backtest",
      backtestJobId: raw.job_id || raw.jobId || raw.backtestJobId || null,
      backtestLabel: raw.label || raw.backtestLabel || null,
    });
  }

  function loadBacktestTrade(raw, resumeFrom) {
    stopPlayback();
    const trade = normalizeBacktestTrade(raw);
    if (!Array.isArray(trade.bars) || !trade.bars.length) {
      UIModal.alert("Couldn't load that backtest trade's chart data.", { title: "Load failed", tone: "danger" });
      return;
    }
    startSession(trade, resumeFrom);
  }

  function startSession(trade, resumeFrom) {
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
      // Backtest trades don't live at data/trades/<id>.json, so a resume
      // (or a page reload) can't re-fetch them by id -- stash the whole
      // trade (bars included) so resumeBtn can hand it straight back to
      // loadBacktestTrade() instead.
      backtestTrade: trade.source === "backtest" ? trade : null,
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
    applySizeModeUI();
    renderProgress();
    renderLivePrice(state.ticks[0]);
    renderPositionPanel();
    renderFillLog();
    updatePlayPauseBtn();
  }

  function replayCurrentTrade() {
    const trade = state.trade;
    if (!trade) return;
    if (trade.source === "backtest") loadBacktestTrade(trade);
    else loadChart(trade.id);
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
    els.modeBadge.innerHTML = `<span class="pill mode-longonly">Long only</span>`;
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
      handleScroll: { vertTouchDrag: false },
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
    renderQuoteStrip(price);
  }

  // Bid/ask/spread plus a running day range + cumulative volume built
  // from every bar printed so far (the closed bars, plus the forming
  // one at its current tick) -- same "what a real quote box shows"
  // info a broker's ticket sits under, entirely derived client-side
  // from data already in state.
  function renderQuoteStrip(price) {
    if (!els.bidVal) return;
    els.bidVal.textContent = "$" + fmtPrice(bidPrice(price));
    els.askVal.textContent = "$" + fmtPrice(askPrice(price));
    els.spreadVal.textContent = "$" + fmtPrice(spreadFor(price));

    const closed = state.bars.slice(0, state.barIndex);
    const forming = state.bars[state.barIndex];
    let hi = -Infinity, lo = Infinity, vol = 0;
    closed.forEach((b) => {
      if (Number.isFinite(b.h)) hi = Math.max(hi, b.h);
      if (Number.isFinite(b.l)) lo = Math.min(lo, b.l);
      vol += Number(b.v) || 0;
    });
    if (forming) {
      hi = Math.max(hi, forming.h, price);
      lo = Math.min(lo, forming.l, price);
      // forming bar's own volume isn't known until it locks in -- credit
      // it proportionally to how far through the bar the tape is, so the
      // volume readout doesn't visibly jump the instant each bar locks.
      const frac = state.ticks.length ? (state.tickIndex + 1) / state.ticks.length : 0;
      vol += (Number(forming.v) || 0) * frac;
    }
    els.rangeVal.textContent = Number.isFinite(hi) && Number.isFinite(lo) ? `$${fmtPrice(lo)} – $${fmtPrice(hi)}` : "—";
    els.volVal.textContent = Number.isFinite(vol) ? Math.round(vol).toLocaleString("en-US") : "—";
  }
  // The clock time of the bar's forming candle right now -- the bar's
  // own start time plus however many of its 60 second-ticks have
  // elapsed, so the seconds visibly count up as the candle forms.
  function currentBarClockTime() {
    const bar = state.bars[state.barIndex];
    if (!bar) return "";
    try {
      const start = new Date(String(bar.t).replace(" ", "T"));
      const withElapsed = new Date(start.getTime() + state.tickIndex * 1000);
      return withElapsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (e) { return fmtTime(bar.t); }
  }
  function renderProgress() {
    const total = state.bars.length;
    els.progressLabel.textContent = `Bar ${state.barIndex + 1} / ${total} · ${currentBarClockTime()}`;
    els.progressFill.style.width = `${((state.barIndex + 1) / total) * 100}%`;
    els.progressSlider.min = String(state.barIndex);
    els.progressSlider.max = String(total - 1);
    els.progressSlider.value = String(state.barIndex);
    updateStepBackBtn();
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
      persistSession();
    }
    paintFormingBar();
    renderLivePrice(currentPrice());
    renderProgress();
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
    updateStepBackBtn();
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
  function stepBackOneBar() {
    if (state.ended || state.barIndex <= 0) return;
    stopPlayback();
    state.barIndex--;
    state.prevClose = state.barIndex > 0 ? state.bars[state.barIndex - 1].c : null;
    state.tickIndex = 0;
    state.ticks = genSecondTicks(state.bars[state.barIndex], state.prevClose, `${state.trade.id}:practice:${state.barIndex}`);
    seedSeries(state.bars.slice(0, state.barIndex));
    paintFormingBar();
    renderLivePrice(currentPrice());
    renderProgress();
    renderPositionPanel();
    persistSession();
  }
  function updateStepBackBtn() {
    if (!els.stepBackBtn) return;
    els.stepBackBtn.disabled = state.ended || state.barIndex <= 0;
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
      executeOrder("sell", state.position.shares, true);
    }
    updatePlayPauseBtn();
    renderPositionPanel();
    renderRecap();
    account.session = null;
    saveAccount();
  }

  function renderRecap() {
    const t = state.trade;
    const st = accountStats();
    const sessionFills = state.fills;
    const sessionPnl = sessionFills.reduce((s, f) => s + (f.realizedPnl || 0), 0);
    const fromBacktest = t.source === "backtest";

    // Same comparison journal-sourced trades get ("what actually
    // happened" vs. what you just did), just pointed at the backtest's
    // own simulated fill instead of a real logged trade when this
    // session was launched from the Backtester's report page.
    const colLabel = fromBacktest ? "What the backtest did on this symbol" : "What actually happened on this trade";
    const resultLabel = fromBacktest ? "Backtest result" : "Real result";
    const sideShares = t.side || t.shares
      ? `${t.side ? escapeHtml(String(t.side)).toUpperCase() + " " : ""}${t.shares ? t.shares + " sh · " : ""}`
      : "";
    const rMultLine = fromBacktest && typeof t.r_multiple === "number" && isFinite(t.r_multiple)
      ? `<div class="rb-line">R multiple: <b class="${t.r_multiple >= 0 ? "up" : "down"}">${t.r_multiple.toFixed(2)}R</b></div>`
      : "";
    const viewLink = fromBacktest
      ? (t.backtestJobId ? `<a class="btn-advanced" href="report.html?id=${encodeURIComponent(t.backtestJobId)}" target="_blank" rel="noopener">View full backtest report</a>` : "")
      : `<a class="btn-advanced" href="trade.html?id=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">View the real trade</a>`;

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
          <div class="rb-label">${colLabel}</div>
          <div class="rb-line">${sideShares}entered <b>$${fmtPrice(t.entry_price)}</b> at ${escapeHtml(t.entry_time || "")}, exited <b>$${fmtPrice(t.exit_price)}</b> at ${escapeHtml(t.exit_time || "")}</div>
          <div class="rb-line">${resultLabel}: <b class="${realisticActualNet(t) >= 0 ? "up" : "down"}">${fmtMoney(realisticActualNet(t))}</b>${fromBacktest ? "" : " after commission"}</div>
          ${rMultLine}
          ${t.verdict ? `<div class="rb-line" style="margin-top:8px;">${escapeHtml(t.verdict)}</div>` : ""}
        </div>
      </div>
      <div class="quiz-summary-actions" style="margin-top:16px;">
        <button class="btn-confirm" id="pr-recap-replay-btn">↺ Replay this chart</button>
        <button class="btn-advanced" id="pr-recap-again-btn">Practice another chart</button>
        ${viewLink}
      </div>
    `;
    document.getElementById("pr-recap-again-btn").addEventListener("click", goToSetup);
    document.getElementById("pr-recap-replay-btn").addEventListener("click", replayCurrentTrade);
  }

  // ---------------------------------------------------------------
  // order execution -- BUY/SELL work like at a real broker: cash
  // moves by ∓(notional + commission). There's no shorting, ever --
  // a Sell can only close or reduce an existing long, never open or
  // add to one. A Buy never gets refused for insufficient funds: if
  // the requested size costs more than the account has, it silently
  // fills for the most shares the available cash (net of commission)
  // can actually cover -- same as spending "whatever's left".
  // ---------------------------------------------------------------
  function buyingPower() {
    return account.balance;
  }
  function positionMarketValue(price) {
    if (!state.position) return 0;
    return state.position.shares * price;
  }
  function accountEquity(price) {
    return account.balance + positionMarketValue(price);
  }
  // Largest whole-share quantity (at most `cap`) whose cost, including
  // commission, still fits within current buying power.
  function maxAffordableShares(price, cap) {
    if (!(price > 0)) return 0;
    let shares = Math.floor(buyingPower() / price);
    if (Number.isFinite(cap) && cap >= 0) shares = Math.min(shares, Math.floor(cap));
    while (shares > 0 && shares * price + ibkrTieredCommission(shares, price) > buyingPower() + 1e-6) {
      shares--;
    }
    return Math.max(0, shares);
  }

  function executeOrder(sideStr, shares, silent) {
    shares = Math.floor(Number(shares));
    if (!(shares > 0)) { if (!silent) showOrderMsg("Enter a positive number of shares.", true); return; }
    if (state.ended) return;
    const pos = state.position;

    // No shorting -- a Sell can only close/reduce an existing long.
    // Clamp an oversized sell down to whatever's actually held, and
    // block it outright when flat.
    if (sideStr === "sell") {
      const heldLong = pos ? pos.shares : 0;
      if (heldLong <= 0) {
        if (!silent) showOrderMsg("No shorting -- buy first to open a position.", true);
        return;
      }
      if (shares > heldLong) shares = heldLong;
    }

    // Cross the spread like a real market order would -- a buy fills at
    // the ask, a sell fills at the bid, never at the mid-price shown as
    // the "last" quote. This is also why a fresh position shows a small
    // negative unrealized P&L the instant it's opened: you're down the
    // spread before the market even has to move against you.
    const mid = currentPrice();
    const price = sideStr === "buy" ? askPrice(mid) : bidPrice(mid);
    let commission = ibkrTieredCommission(shares, price);
    let realizedPnl = null;
    let clamped = false;

    if (sideStr === "buy") {
      const cost = shares * price + commission;
      if (cost > buyingPower() + 1e-6) {
        const affordable = maxAffordableShares(price, shares);
        if (affordable <= 0) {
          if (!silent) showOrderMsg(`Not enough buying power for even 1 share at $${fmtPrice(price)}.`, true);
          return;
        }
        shares = affordable;
        commission = ibkrTieredCommission(shares, price);
        clamped = true;
      }
      const finalCost = shares * price + commission;
      account.balance -= finalCost;
      applyFill(pos, "buy", shares, price);
    } else {
      const closing = Math.min(shares, pos.shares);
      realizedPnl = (price - pos.avgPrice) * closing - commission * (closing / shares);
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
    renderSizePreview();
    renderFillLog();
    renderAccountPanel();
    if (!silent) {
      const msg = `${sideStr.toUpperCase()} ${shares} @ $${fmtPrice(price)} · commission ${fmtUsd(commission)}` + (clamped ? " · filled for all available cash" : "");
      showOrderMsg(msg, false);
    }
  }

  // No shorting -- a position, if any, is always "long". Buying opens
  // or adds to it (blended average price); selling only ever reduces
  // or closes it (average price on what's left is unchanged).
  function applyFill(pos, sideStr, shares, price) {
    if (sideStr === "buy") {
      if (!pos) {
        state.position = { side: "long", shares, avgPrice: price };
      } else {
        const totalShares = pos.shares + shares;
        const avgPrice = (pos.avgPrice * pos.shares + price * shares) / totalShares;
        state.position = { side: "long", shares: totalShares, avgPrice };
      }
      return;
    }
    // sell -- shares is already clamped to at most pos.shares by executeOrder
    const remaining = pos.shares - shares;
    state.position = remaining > 1e-9 ? { side: "long", shares: remaining, avgPrice: pos.avgPrice } : null;
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
      const unreal = (price - pos.avgPrice) * pos.shares;
      els.posSummary.innerHTML = `
        <span class="side-pill ${pos.side}">${pos.side.toUpperCase()}</span>
        <span class="mono">${pos.shares} sh @ $${fmtPrice(pos.avgPrice)}</span>
        <span class="mono ${unreal >= 0 ? "up" : "down"}">${fmtMoney(unreal)} unrealized</span>
      `;
    }
    els.cashLine.textContent = fmtUsd(account.balance);
    els.equityLine.textContent = fmtUsd(accountEquity(price));
    els.bpLine.textContent = fmtUsd(buyingPower());

    const blockSell = !pos || pos.shares <= 0;
    els.sellBtn.disabled = blockSell;
    els.sellBtn.title = blockSell ? "No shorting -- buy first to open a position." : "";

    renderPartialExitRow();
    renderShortcutsRow();
  }

  // ---------------------------------------------------------------
  // partial exits -- one-click ¼ / ½ / full close of whatever
  // position is currently open, rounded down to a whole share
  // (minimum 1) so a 1/4 click on a 3-share position still fires.
  // ---------------------------------------------------------------
  const PARTIAL_EXIT_STEPS = [
    { label: "¼", frac: 0.25 },
    { label: "½", frac: 0.5 },
    { label: "Full", frac: 1 },
  ];
  function renderPartialExitRow() {
    if (!els.partialExitRow) return;
    const pos = state.position;
    if (!pos || !(pos.shares > 0) || state.ended) {
      els.partialExitRow.innerHTML = "";
      return;
    }
    const closeSide = pos.side === "long" ? "sell" : "buy";
    els.partialExitRow.innerHTML = `<span class="pp-partial-label">Exit</span>` + PARTIAL_EXIT_STEPS.map((step) => {
      const closeShares = step.frac >= 1 ? pos.shares : Math.max(1, Math.floor(pos.shares * step.frac));
      return `<button type="button" class="quiz-preset-btn pp-partial-btn" data-shares="${closeShares}" data-side="${closeSide}">${step.label} <span class="dim">${closeShares} sh</span></button>`;
    }).join("");
    els.partialExitRow.querySelectorAll(".pp-partial-btn").forEach((b) => {
      b.addEventListener("click", () => executeOrder(b.dataset.side, Number(b.dataset.shares)));
    });
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
    const isPct = account.sizeMode === "pct";
    const presets = isPct ? PCT_PRESETS : SHARE_PRESETS;
    const suffix = isPct ? "%" : " sh";
    els.presetRow.innerHTML = presets.map((s) => `<button type="button" class="quiz-preset-btn" data-size="${s}">${s}${suffix}</button>`).join("");
    els.presetRow.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => { els.sharesInput.value = b.dataset.size; renderSizePreview(); });
    });
  }

  // ---------------------------------------------------------------
  // sizing mode -- "shares" (raw share count, the original behavior)
  // or "pct" (the input is read as a % of current buying power and
  // converted to whole shares at order time, at whatever the price
  // is the instant Buy/Sell is clicked -- like an order ticket's
  // "% of buying power" quick-size, not a fixed share count locked
  // in ahead of time).
  // ---------------------------------------------------------------
  function pctToShares(pct, price) {
    if (!(pct > 0) || !(price > 0)) return 0;
    const dollars = buyingPower() * (pct / 100);
    return Math.max(0, Math.floor(dollars / price));
  }
  function resolveOrderShares() {
    const raw = Number(els.sharesInput.value);
    if (!Number.isFinite(raw) || raw <= 0) {
      return { shares: 0, error: account.sizeMode === "pct" ? "Enter a positive % of capital." : "Enter a positive number of shares." };
    }
    if (account.sizeMode === "pct") {
      const price = currentPrice();
      const shares = pctToShares(raw, price);
      if (shares <= 0) {
        return { shares: 0, error: `${raw}% of buying power (${fmtUsd(buyingPower() * (raw / 100))}) doesn't cover 1 share at $${fmtPrice(price)}.` };
      }
      return { shares };
    }
    return { shares: Math.floor(raw) };
  }
  function renderSizePreview() {
    if (!els.sizePreview) return;
    const raw = Number(els.sharesInput.value);
    const price = currentPrice();
    if (!Number.isFinite(raw) || raw <= 0 || !(price > 0)) { els.sizePreview.textContent = ""; return; }

    if (account.sizeMode === "pct") {
      const dollars = buyingPower() * (raw / 100);
      const shares = pctToShares(raw, price);
      if (shares <= 0) { els.sizePreview.textContent = `Too small for 1 share at $${fmtPrice(price)}`; return; }
      const est = shares * askPrice(price);
      const comm = ibkrTieredCommission(shares, price);
      els.sizePreview.textContent = `≈ ${shares} sh (${fmtUsd(dollars)} of ${fmtUsd(buyingPower())} BP) · ${fmtUsd(est)} + ${fmtUsd(comm)} est. commission`;
      return;
    }
    const shares = Math.floor(raw);
    if (shares <= 0) { els.sizePreview.textContent = ""; return; }
    const est = shares * askPrice(price);
    const comm = ibkrTieredCommission(shares, price);
    els.sizePreview.textContent = `${shares} sh ≈ ${fmtUsd(est)} to buy + ${fmtUsd(comm)} est. commission`;
  }
  function applySizeModeUI() {
    const isPct = account.sizeMode === "pct";
    if (els.sizeModeRow) {
      els.sizeModeRow.querySelectorAll(".pp-size-mode-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === account.sizeMode);
      });
    }
    if (els.sizeUnit) els.sizeUnit.textContent = isPct ? "% of buying power" : "shares";
    if (els.sharesInput) {
      if (isPct) { els.sharesInput.max = "100"; } else { els.sharesInput.removeAttribute("max"); }
    }
    renderSizePresets();
    renderSizePreview();
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
    updateCandidateCount();
  }

  // ---------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------
  els.resetBtn.addEventListener("click", resetAccount);
  els.randomBtn.addEventListener("click", pickRandomCandidate);
  els.replayBtn.addEventListener("click", async () => {
    if (!state.trade) return;
    if (state.position && state.position.shares > 0) {
      const ok = await UIModal.confirm("You still have an open position on this chart. Replaying will flatten it at the current price and restart from the very first bar. Continue?", { title: "Flatten & replay?", tone: "danger", confirmLabel: "Flatten & replay" });
      if (!ok) return;
    }
    endSession("replay");
    replayCurrentTrade();
  });
  els.resumeBtn.addEventListener("click", () => {
    const sess = account.session;
    if (!sess) return;
    if (sess.backtestTrade) loadBacktestTrade(sess.backtestTrade, sess);
    else loadChart(sess.chartId, sess);
  });
  els.changeChartBtn.addEventListener("click", async () => {
    if (state.position && state.position.shares > 0) {
      const ok = await UIModal.confirm("You still have an open position on this chart. Leaving now will flatten it at the current price. Continue?", { title: "Flatten & leave?", tone: "danger", confirmLabel: "Flatten & leave" });
      if (!ok) return;
    }
    const prevId = state.trade ? state.trade.id : null;
    endSession("changed chart");
    account.session = null;
    saveAccount();
    pickRandomCandidate(prevId);
  });
  els.playPauseBtn.addEventListener("click", () => { state.playing ? stopPlayback() : startPlayback(); });
  els.stepBackBtn.addEventListener("click", stepBackOneBar);
  els.stepBtn.addEventListener("click", stepOneBar);
  els.skipBtn.addEventListener("click", async () => {
    const ok = await UIModal.confirm("Skip to the end of this chart? Any open position will be closed at the final price.", { title: "Skip to end?", confirmLabel: "Skip to end" });
    if (!ok) return;
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
  els.sharesInput.addEventListener("input", renderSizePreview);
  if (els.qtyDecBtn) {
    els.qtyDecBtn.addEventListener("click", () => {
      const step = account.sizeMode === "pct" ? 5 : 10;
      const min = account.sizeMode === "pct" ? 1 : 1;
      els.sharesInput.value = String(Math.max(min, (Number(els.sharesInput.value) || 0) - step));
      renderSizePreview();
    });
  }
  if (els.qtyIncBtn) {
    els.qtyIncBtn.addEventListener("click", () => {
      const step = account.sizeMode === "pct" ? 5 : 10;
      const max = account.sizeMode === "pct" ? 100 : Infinity;
      els.sharesInput.value = String(Math.min(max, (Number(els.sharesInput.value) || 0) + step));
      renderSizePreview();
    });
  }
  if (els.sizeModeRow) {
    els.sizeModeRow.querySelectorAll(".pp-size-mode-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const mode = b.dataset.mode;
        if (mode === account.sizeMode) return;
        account.sizeMode = mode;
        saveAccount();
        els.sharesInput.value = mode === "pct" ? "25" : "100";
        applySizeModeUI();
      });
    });
  }
  els.buyBtn.addEventListener("click", () => {
    const { shares, error } = resolveOrderShares();
    if (!shares) { showOrderMsg(error, true); return; }
    executeOrder("buy", shares);
  });
  els.sellBtn.addEventListener("click", () => {
    const { shares, error } = resolveOrderShares();
    if (!shares) { showOrderMsg(error, true); return; }
    executeOrder("sell", shares);
  });
  els.srBtn.addEventListener("click", runSupportResistance);
  if (els.shortcutsGearBtn) els.shortcutsGearBtn.addEventListener("click", openShortcutsModal);
  if (els.headShortcutsGearBtn) els.headShortcutsGearBtn.addEventListener("click", openShortcutsModal);

  // Keyboard hotkeys -- only live while a chart is actually loaded and
  // running, and never while the person is typing into a field (the
  // quantity box, a modal input, etc.) or holding a modifier key.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(document.activeElement)) return;
    if (els.playScreen.style.display === "none") return;
    if (!state.trade || state.ended) return;
    const key = e.key.toLowerCase();
    const match = shortcuts.find((s) => s.key && s.key.toLowerCase() === key);
    if (match) { e.preventDefault(); runShortcut(match.id); }
  });

  // ---------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------
  window.fetchTradesIndex()
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      renderAccountPanel();
      updateCandidateCount();
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load your trades.";
    });

  // If report.html's "Practice this trade" button handed off a backtest
  // trade, jump straight into it instead of the usual setup screen.
  // Consumed once -- a plain refresh of practice.html afterward goes
  // back to normal (the in-progress session itself still resumes via
  // account.session.backtestTrade, same as any other chart).
  (function loadPendingBacktestHandoff() {
    let raw;
    try {
      raw = localStorage.getItem(PENDING_BACKTEST_KEY);
      if (raw) localStorage.removeItem(PENDING_BACKTEST_KEY);
    } catch (e) { raw = null; }
    if (!raw) return;
    try {
      const trade = JSON.parse(raw);
      loadBacktestTrade(trade);
    } catch (e) { /* ignore malformed handoff */ }
  })();
})();
