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

  // Set of trade/chart ids (object map id -> true) already run through a
  // full practice session (see markPracticed/endSession below), mirrored
  // to Supabase (user_kv) the same way ACCOUNT_KEY/SHORTCUTS_KEY are --
  // so a chart you've already practiced on doesn't keep coming back up
  // as the random pick. Backtest-sourced charts are never marked --
  // their ids are synthetic and regenerated per run, same reasoning as
  // rewind.js's REVIEWED_KEY. Always read fresh from localStorage
  // (no in-memory copy), same pattern as loadAccount/loadShortcuts.
  const PRACTICED_KEY = "practice:practiced";

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
    includePracticedCheck: document.getElementById("pf-include-practiced"),
    progressList: document.getElementById("pr-progress-list"),
    resetAllBtn: document.getElementById("pr-reset-all-btn"),

    // play screen
    symLine: document.getElementById("pp-symbol-line"),
    dateLine: document.getElementById("pp-date-line"),
    modeBadge: document.getElementById("pp-mode-badge"),
    replayBtn: document.getElementById("pp-replay-btn"),
    changeChartBtn: document.getElementById("pp-change-chart-btn"),
    exitBtn: document.getElementById("pp-exit-btn"),
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
// escapeHtml() now in utils.js (loads first on every page).
// toUnix() now in utils.js (loads first on every page).
// fmtUsd() now in utils.js (loads first on every page).
// fmtMoney() now in utils.js (loads first on every page).
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

  // ibkrTieredCommission() + IBKR_PER_SHARE/IBKR_MIN_PER_ORDER/
  // IBKR_MAX_PCT_OF_TRADE_VALUE now in utils.js (loads first on every page).

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
  // seededRng() now in utils.js (loads first on every page).
  // REPLAY_SECONDS/genSecondTicks() now in utils.js (loads first on every page).

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

  function loadPracticed() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PRACTICED_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
  }
  function savePracticed(map) {
    try {
      localStorage.setItem(PRACTICED_KEY, JSON.stringify(map));
      if (window.KV) window.KV.set(PRACTICED_KEY, map);
    } catch (e) { /* ignore -- practice still works without persistence */ }
  }
  // Called once a session on a given chart ends, however it ends (data
  // ran out, replay, change chart, or skip-to-end -- see endSession).
  function markPracticed(id) {
    const map = loadPracticed();
    if (map[id]) return;
    map[id] = true;
    savePracticed(map);
  }

  if (window.KV) {
    window.KV.sync(PRACTICED_KEY, function (remote) {
      if (!remote || typeof remote !== "object" || Array.isArray(remote)) return;
      try { localStorage.setItem(PRACTICED_KEY, JSON.stringify(remote)); } catch (e) { /* ignore */ }
      renderProgressPanel();
      updateCandidateCount();
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
    const total = state.index.length;
    const includeAll = els.includePracticedCheck && els.includePracticedCheck.checked;
    if (includeAll) {
      els.candidateCount.innerHTML = `<b>${total}</b> chart${total === 1 ? "" : "s"} available`;
      return;
    }
    const practiced = loadPracticed();
    const remaining = state.index.filter((r) => !practiced[r.id]).length;
    els.candidateCount.innerHTML = remaining === total
      ? `<b>${total}</b> chart${total === 1 ? "" : "s"} available`
      : `<b>${remaining}</b> of <b>${total}</b> chart${total === 1 ? "" : "s"} not yet practiced`;
  }

  function pickRandomCandidate(excludeId) {
    const rows = state.index;
    if (!rows.length) return;
    const includeAll = els.includePracticedCheck && els.includePracticedCheck.checked;
    const practiced = includeAll ? null : loadPracticed();
    // Prefer charts not yet practiced; if every remaining chart has
    // already been practiced (or the box is checked), fall back to the
    // full list rather than refusing to pick anything.
    let pool = practiced ? rows.filter((r) => !practiced[r.id]) : rows;
    if (!pool.length) pool = rows;
    if (excludeId && pool.length > 1) pool = pool.filter((r) => r.id !== excludeId);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    loadChart(pick.id);
  }

  // "X of Y practiced" -- overall plus one row per journal setup_type,
  // each (other than the "All setups" summary row) with its own reset
  // button. Mirrors rewind.js's renderProgressPanel/REVIEWED_KEY --
  // reuses its CSS (rewind.css is already loaded on this page).
  function renderProgressPanel() {
    if (!els.progressList) return;
    const rows = state.index.filter((r) => r.id);
    if (!rows.length) {
      els.progressList.innerHTML = `<div class="quiz-history-empty">No logged trades yet.</div>`;
      if (els.resetAllBtn) els.resetAllBtn.style.display = "none";
      return;
    }
    const practiced = loadPracticed();
    const bySetup = {};
    rows.forEach((r) => {
      const key = r.setup_type || "unlabeled";
      (bySetup[key] || (bySetup[key] = [])).push(r.id);
    });
    const setupKeys = Object.keys(bySetup).sort();

    function rowHtml(label, ids, setupKey) {
      const total = ids.length;
      const done = ids.filter((id) => practiced[id]).length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const resetBtn = setupKey
        ? `<button type="button" class="rw-progress-reset" data-setup="${escapeHtml(setupKey)}">Reset</button>`
        : `<span class="rw-progress-reset-spacer"></span>`;
      return `<div class="rw-progress-row${setupKey ? "" : " rw-progress-overall"}">
        <span class="rw-progress-name">${escapeHtml(label)}</span>
        <div class="rw-progress-bar"><div class="rw-progress-fill" style="width:${pct}%"></div></div>
        <span class="rw-progress-count">${done} / ${total}</span>
        ${resetBtn}
      </div>`;
    }

    const allIds = rows.map((r) => r.id);
    els.progressList.innerHTML = rowHtml("All setups", allIds, null)
      + setupKeys.map((s) => rowHtml(s.replace(/_/g, " "), bySetup[s], s)).join("");

    if (els.resetAllBtn) {
      els.resetAllBtn.style.display = allIds.some((id) => practiced[id]) ? "" : "none";
    }

    els.progressList.querySelectorAll(".rw-progress-reset").forEach((btn) => {
      btn.addEventListener("click", () => resetPracticedFor(btn.dataset.setup, bySetup[btn.dataset.setup]));
    });
  }

  async function resetPracticedFor(setupKey, ids) {
    const label = setupKey === "unlabeled" ? "unlabeled setups" : setupKey.replace(/_/g, " ");
    const ok = await UIModal.confirm(
      `Reset practice progress for "${label}"? ${ids.length} chart${ids.length === 1 ? "" : "s"} will be eligible to come up again.`,
      { title: "Reset progress?", tone: "danger", confirmLabel: "Reset" }
    );
    if (!ok) return;
    const map = loadPracticed();
    ids.forEach((id) => { delete map[id]; });
    savePracticed(map);
    renderProgressPanel();
    updateCandidateCount();
  }

  if (els.resetAllBtn) {
    els.resetAllBtn.addEventListener("click", async () => {
      const ok = await UIModal.confirm(
        "Reset all practice progress? Every logged chart will be eligible to come up again.",
        { title: "Reset all progress?", tone: "danger", confirmLabel: "Reset all" }
      );
      if (!ok) return;
      savePracticed({});
      renderProgressPanel();
      updateCandidateCount();
    });
  }
  if (els.includePracticedCheck) els.includePracticedCheck.addEventListener("change", updateCandidateCount);

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

  // ---------------------------------------------------------------
  // reaction lag -- computeScannerPopIndex() finds the bar a scanner
  // would actually flag, but dropping the trader straight into that
  // bar means "getting in" at the very first tick of the move, which
  // nobody manages in practice: an alert still has to be noticed, the
  // chart pulled up, the setup sized up, and the buy button clicked.
  // We simply skip that bar entirely and start the session on the
  // next one, so the move that triggered the alert has already fully
  // printed before play begins -- no chasing forward looking for a
  // confirmed move first, which was landing on the very next bar so
  // often (a "hot" pop bar's own follow-through usually clears the
  // move threshold immediately) that it barely differed from starting
  // right on the alert bar itself.
  // ---------------------------------------------------------------
  function computeEntryIndex(trade) {
    const bars = trade.bars;
    const popIdx = computeScannerPopIndex(trade);
    if (!Array.isArray(bars) || !bars.length) return popIdx;
    return Math.min(popIdx + 1, bars.length - 1);
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
    state.barIndex = resumeFrom ? Math.min(resumeFrom.barIndex || 0, trade.bars.length - 1) : computeEntryIndex(trade);
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
// fmtShares() now in utils.js (loads first on every page).
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

  let srRequestInFlight = false;
  // Every drawSrLevelsOnChart() call added new createPriceLine()s without
  // ever removing the last batch -- clicking "Analyze support/resistance"
  // more than once stacked a fresh set of lines on top of the old ones,
  // and the lines themselves were left fully visible (not just the axis
  // label) instead of hidden like trade.js's matching S/R lines -- so they
  // showed up as random red/green dashes across the chart. Tracked here so
  // drawSrLevelsOnChart can clear its own previous lines first, and drawn
  // with lineVisible: false to match trade.js.
  let srPriceLines = [];
  function runSupportResistance() {
    if (srRequestInFlight || !state.trade) return;
    if (!SR_ANALYSIS_URL) {
      els.srResult.innerHTML = `<div class="sr-status error">SR_ANALYSIS_URL isn't set yet -- set it in config.js to your analysis service first.</div>`;
      return;
    }
    srRequestInFlight = true;
    const trade = state.trade;
    const originalLabel = els.srBtn.innerHTML;
    els.srBtn.disabled = true;
    els.srBtn.innerHTML = "Analyzing…";
    els.srResult.innerHTML = `<div class="sr-status">Reading ${escapeHtml(trade.symbol)}'s prior daily bars and computing levels — this can take a few seconds…</div>`;

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
        els.srResult.innerHTML = `<div class="sr-status error">Couldn't get support/resistance levels (${escapeHtml(String(err.message))}). Make sure SR_ANALYSIS_URL in config.js is pointed at your analysis service.</div>`;
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
    // Clear whatever this function drew last time before adding the new
    // batch, so re-running the analysis replaces the lines instead of
    // stacking a duplicate set on top of them.
    srPriceLines.forEach((line) => { try { state.chartHandle.series.removePriceLine(line); } catch (e) {} });
    srPriceLines = [];
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    resistance.forEach((lv) => {
      const tag = srChartTag(lv);
      srPriceLines.push(state.chartHandle.series.createPriceLine({
        price: Number(lv.price), color: "#f2555a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, lineVisible: false,
        title: tag ? `resistance (${tag})` : "resistance",
      }));
    });
    support.forEach((lv) => {
      const tag = srChartTag(lv);
      srPriceLines.push(state.chartHandle.series.createPriceLine({
        price: Number(lv.price), color: "#2fd08a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, lineVisible: false,
        title: tag ? `support (${tag})` : "support",
      }));
    });
  }

  // ---------------------------------------------------------------
  // chart -- same lightweight-charts setup rewind.js/trade.js use
  // (candles + volume + VWAP/EMA9/EMA20/EMA200), rebuilt fresh per chart
  // load and progressively fed bars as playback advances.
  // ---------------------------------------------------------------
  function buildPlayChart() {
    if (state.chartHandle) teardownChart(state.chartHandle);
    srPriceLines = [];
    const el = els.chartEl;
    const floatShares = ((state.trade && state.trade.indicators) || {}).float_shares;
    // buildStandardChart seeds its overlay/handleState from whatever bars
    // we pass it; we build the chart before we have any bars loaded (they
    // get seeded via seedSeries() right after), so start it off empty --
    // same shape seedSeries()/paintFormingBar() below already expect to
    // feed into via handle.series/.volSeries/etc.
    const handle = window.ChartIndicators.buildStandardChart(el, [], {
      floatLabel: floatShares ? fmtShares(floatShares) : null,
    });
    state.chartHandle = handle;
    const { chart, series, volSeries } = handle;

    // seed with every bar fully closed up to (not including) barIndex
    const closed = state.bars.slice(0, state.barIndex);
    seedSeries(closed);
    paintFormingBar();
    if (state.markers.length) series.setMarkers(state.markers);
    // fitContent() stretches whatever's currently loaded to fill the full
    // chart width -- fine once a session has a healthy number of bars, but
    // a round typically starts right as the scanner "pop" happened, i.e.
    // only a handful of bars in. fitContent() at that point blows those
    // few candles up to fill the whole pane (the "zoomed in on one candle"
    // look) instead of leaving room to see the tape develop. Below a
    // reasonable bar count, use a fixed, comfortable spacing and park the
    // view with some right-side breathing room for new bars to stream
    // into, same as a real platform starting mid-session; once there's
    // enough history to fill the pane at that spacing on its own,
    // fitContent() behaves the same either way, so it's only a fallback
    // for the small-bar-count case.
    const MIN_BARS_FOR_FIT = 30;
    const loadedCount = closed.length + 1; // + the forming bar just painted
    if (loadedCount < MIN_BARS_FOR_FIT) {
      chart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 12 });
      chart.timeScale().scrollToPosition(12, false);
    } else {
      chart.timeScale().fitContent();
    }
  }
  // teardownChart() now in utils.js (loads first on every page).

  // "Show full day" -- offered only on the post-round recap (see
  // renderRecap below), never during live play. computeEntryIndex()
  // (used to pick where playback starts) assumes state.bars opens with a
  // quiet pre-move baseline; it only ever runs once, at session start, so
  // swapping state.bars for the whole session's bars here -- after the
  // round is already scored -- can't disturb it. Same /full-day-bars
  // route + (symbol, trade_date) server cache trade.js's and rewind.js's
  // "Show full day" buttons use, plus the same sessionStorage layer so a
  // symbol+day already pulled on another page in this tab is instant here.
  // FULL_DAY_CACHE_PREFIX/fetchFullDayBars() now in utils.js (loads first
  // on every page).
  function seedSeries(bars) {
    const h = state.chartHandle;
    h.series.setData(bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    h.volSeries.setData(bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" })));
    h.vwapSeries.setData(bars.filter((b) => b.vwap != null).map((b) => ({ time: toUnix(b.t), value: b.vwap })));
    h.ema9Series.setData(bars.filter((b) => b.ema9 != null).map((b) => ({ time: toUnix(b.t), value: b.ema9 })));
    h.ema20Series.setData(bars.filter((b) => b.ema20 != null).map((b) => ({ time: toUnix(b.t), value: b.ema20 })));
    h.ema200Series.setData(bars.filter((b) => b.ema200 != null).map((b) => ({ time: toUnix(b.t), value: b.ema200 })));
    if (bars.length) {
      const last = bars[bars.length - 1];
      h.handleState.lastVol = last.v;
      h.handleState.lastVwap = last.vwap;
      h.handleState.lastEma9 = last.ema9;
      h.handleState.lastEma20 = last.ema20;
      h.handleState.lastEma200 = last.ema200;
      h.renderOverlay(last.v, last.c >= last.o ? "up" : "down", last.vwap, last.ema9, last.ema20, last.ema200);
    }
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
    const formingVol = Math.round((bar.v || 0) * frac);
    h.volSeries.update({ time: toUnix(bar.t), value: formingVol, color: "rgba(232,169,76,0.4)" });
    h.handleState.lastVol = formingVol;
    if (bar.vwap != null) { h.vwapSeries.update({ time: toUnix(bar.t), value: bar.vwap }); h.handleState.lastVwap = bar.vwap; }
    if (bar.ema9 != null) { h.ema9Series.update({ time: toUnix(bar.t), value: bar.ema9 }); h.handleState.lastEma9 = bar.ema9; }
    if (bar.ema20 != null) { h.ema20Series.update({ time: toUnix(bar.t), value: bar.ema20 }); h.handleState.lastEma20 = bar.ema20; }
    if (bar.ema200 != null) { h.ema200Series.update({ time: toUnix(bar.t), value: bar.ema200 }); h.handleState.lastEma200 = bar.ema200; }
    h.renderOverlay(formingVol, "", h.handleState.lastVwap, h.handleState.lastEma9, h.handleState.lastEma20, h.handleState.lastEma200);
  }
  function lockInBar() {
    const bar = state.bars[state.barIndex];
    const h = state.chartHandle;
    h.series.update({ time: toUnix(bar.t), open: bar.o, high: bar.h, low: bar.l, close: bar.c });
    h.volSeries.update({ time: toUnix(bar.t), value: bar.v, color: bar.c >= bar.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" });
    h.handleState.lastVol = bar.v;
    h.handleState.lastVwap = bar.vwap;
    h.handleState.lastEma9 = bar.ema9;
    h.handleState.lastEma20 = bar.ema20;
    h.handleState.lastEma200 = bar.ema200;
    h.renderOverlay(bar.v, bar.c >= bar.o ? "up" : "down", bar.vwap, bar.ema9, bar.ema20, bar.ema200);
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
    // Log this chart as practiced (skipped for backtest-generated charts
    // -- see PRACTICED_KEY above) so it's excluded from future random
    // picks until reset -- regardless of *how* the session ended.
    if (state.trade && state.trade.source !== "backtest") markPracticed(state.trade.id);
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
        <button class="btn-advanced" id="pr-recap-full-day-btn" title="Load this symbol's whole session so you can zoom/pan out past the trade window">Show full day</button>
        <button class="btn-advanced" id="pr-recap-again-btn">Practice another chart</button>
        ${viewLink}
      </div>
    `;
    document.getElementById("pr-recap-again-btn").addEventListener("click", goToSetup);
    document.getElementById("pr-recap-replay-btn").addEventListener("click", replayCurrentTrade);
    const fullDayBtn = document.getElementById("pr-recap-full-day-btn");
    if (fullDayBtn) {
      fullDayBtn.addEventListener("click", () => {
        if (fullDayBtn.disabled) return;
        fullDayBtn.disabled = true;
        const original = fullDayBtn.textContent;
        fullDayBtn.textContent = "Loading…";
        fetchFullDayBars(t.symbol, t.trade_date)
          .then((fullBars) => {
            if (!fullBars.length) throw new Error("No bars came back");
            state.bars = fullBars;
            state.barIndex = fullBars.length; // past the end -- paintFormingBar() no-ops, everything renders fully closed
            buildPlayChart();
            fullDayBtn.textContent = "Full day loaded";
          })
          .catch((err) => {
            fullDayBtn.textContent = original;
            fullDayBtn.disabled = false;
            fullDayBtn.title = "Couldn't load the full day: " + err.message;
          });
      });
    }
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
    renderProgressPanel();
  }

  // ---------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------
  els.resetBtn.addEventListener("click", resetAccount);
  els.randomBtn.addEventListener("click", () => pickRandomCandidate());
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
  els.exitBtn.addEventListener("click", async () => {
    if (state.position && state.position.shares > 0) {
      const ok = await UIModal.confirm("You still have an open position on this chart. Exiting now will flatten it at the current price and end the session. Continue?", { title: "Exit session?", tone: "danger", confirmLabel: "Flatten & exit" });
      if (!ok) return;
    } else {
      const ok = await UIModal.confirm("End this practice session and return to setup?", { title: "Exit session?", confirmLabel: "Exit session" });
      if (!ok) return;
    }
    endSession("exit");
    account.session = null;
    saveAccount();
    goToSetup();
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
      renderProgressPanel();
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load your trades.";
    });

  // Two ways in besides the random-pick setup screen: report.html's
  // "Practice this trade" button hands off a full backtest trade via
  // localStorage (consumed once); trade.html's "Practice" button links
  // here with ?trade=<id> for a real logged trade instead. Either one
  // skips straight past the setup screen into that chart.
  //
  // The backtest-handoff branch below used to run as one plain IIFE at
  // parse time, with loadBacktestTrade() itself inside the same try/catch
  // as the JSON.parse call. Two bugs from that: (1) reading localStorage
  // and building the chart is fully synchronous, so it ran before the
  // deferred lightweight-charts <script> tag (see practice.html) had
  // executed -- LightweightCharts was still undefined, buildPlayChart()
  // threw, and (2) that throw landed inside the same catch meant for
  // "ignore malformed JSON", so it was silently swallowed and the page
  // was left stuck on nothing, no error, no fallback. Deferring to
  // DOMContentLoaded fixes the race (deferred scripts always finish
  // before that fires); narrowing the try/catch to just the JSON.parse
  // means a real rendering error now surfaces normally instead of
  // vanishing.
  (function loadPendingBacktestHandoff() {
    let raw;
    try {
      raw = localStorage.getItem(PENDING_BACKTEST_KEY);
      if (raw) localStorage.removeItem(PENDING_BACKTEST_KEY);
    } catch (e) { raw = null; }

    function boot() {
      if (raw) {
        let trade = null;
        try {
          trade = JSON.parse(raw);
        } catch (e) { /* malformed handoff -- fall through to the deep-link/setup-screen path below */ }
        if (trade) {
          loadBacktestTrade(trade); // outside the try/catch above -- a real render error should surface, not vanish
          return;
        }
      }

      // Deep link from trade.html's "Practice" button: ?trade=<id> jumps
      // straight into trading that specific logged journal trade, same
      // ?trade=<id> convention rewind.html already uses for its own
      // "Replay"/Rewind link -- skips the random-pick setup screen.
      try {
        const tradeId = new URLSearchParams(window.location.search).get("trade");
        if (tradeId) loadChart(tradeId);
      } catch (e) { /* ignore */ }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  })();
})();
