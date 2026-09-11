// backtester-ai.js
// Drives the "Configure with AI" panel on the Backtester tab. The person
// describes a strategy in plain English; each turn is sent to
// window.N8N_BACKTEST_AI_URL along with the running conversation and
// whatever config fields have been resolved so far ("draft"). The
// webhook decides what's still missing and asks about it -- this file
// just renders whatever comes back and, once the webhook says it has
// enough, shows a compact summary of everything decided plus a Confirm
// button that writes the draft straight into the real form fields via
// window.BacktesterForm (exposed by backtester.js, which must load
// first).
//
// REQUEST BODY sent on every turn:
//   {
//     message: "<latest thing the person typed>",
//     history: [{ role: "user"|"assistant", content }, ...],   // prior turns, most recent last
//     draft: { <subset of the fields below already resolved> },
//     schema: FIELD_SCHEMA                                      // see below, sent so the
//                                                                // n8n prompt doesn't have to
//                                                                // hardcode field names/enums
//   }
//
// EXPECTED RESPONSE:
//   {
//     reply: "<conversational text -- a follow-up question, or a wrap-up line>",
//     config: { <any fields the model resolved this turn> },    // optional, merged into draft
//     status: "asking" | "ready",                               // "ready" -> show the summary + Confirm
//     unsupported: ["<verbatim thing the person asked for that has no home in FIELD_SCHEMA>", ...]
//     // optional. IMPORTANT: FIELD_SCHEMA is a fixed set of knobs the
//     // Python backtest engine actually understands (see engine.py /
//     // orb_strategy.py in chart_service.py's repo) -- it is NOT a
//     // general strategy description language. If the person describes
//     // something with no matching field (e.g. "only take the first 2
//     // runners of the day", "skip anything under 10M float", "scale
//     // out half at 1R", a multi-candle confirmation pattern), do NOT
//     // silently drop it and do NOT force it into the closest-sounding
//     // field -- that misrepresents the backtest. Put the person's own
//     // words in `unsupported` instead so the UI can tell them plainly
//     // "this won't be simulated" rather than pretending it was applied.
//   }
//
// Unknown keys in `config` are ignored; known keys are coerced to the
// type implied by FIELD_SCHEMA. The draft uses the exact same field
// names as backtester.js's buildPayload()/applyPayload(), so a finished
// draft can be handed straight to window.BacktesterForm.apply().
(function () {
  "use strict";

  const AI_URL = window.N8N_BACKTEST_AI_URL || "";

  const messagesEl = document.getElementById("ai-cfg-messages");
  const chipsEl = document.getElementById("ai-cfg-chips");
  const formEl = document.getElementById("ai-cfg-form");
  const inputEl = document.getElementById("ai-cfg-input");
  const sendBtn = document.getElementById("ai-cfg-send-btn");
  const resetBtn = document.getElementById("ai-cfg-reset");

  if (!messagesEl || !formEl) return; // panel not on this page

  const STARTER_PROMPTS = [
    "ORB breakout on gappers under $10, 2:1 target",
    "9EMA dip on top gappers, $25k account, risk 1% per trade",
    "Tight scalp: fixed 5c stop, exit on stall",
    "VWAP reclaim with an ATR-based stop",
  ];

  // Named, ready-to-run presets (Ross Cameron style gap-and-go, etc.) used
  // to live here as chat chips -- but a saved strategy is an important,
  // reusable thing, not a throwaway chat suggestion, so they now have
  // their own "Strategies" section on the page (backtester.js's
  // loadStrategiesSection(), fed by window.STRATEGY_PRESETS + whatever's
  // actually saved). This panel only offers loose starter prompts now;
  // pick a real strategy from the section above the chat instead.

  // Keep this in sync with buildPayload()/applyPayload() in backtester.js.
  const FIELD_SCHEMA = {
    label: { type: "string", label: "Run label" },
    start: { type: "date", label: "Start date" },
    end: { type: "date", label: "End date" },
    top_n: { type: "int", label: "Top N gappers per day" },
    min_price: { type: "float", label: "Min price ($)" },
    max_price: { type: "float", label: "Max price ($)" },
    min_dollar_volume: { type: "float", label: "Min $ volume" },
    min_gap_pct: { type: "float", label: "Min gap %" },
    position_size: { type: "float", label: "Position size ($)" },
    starting_capital: { type: "float", label: "Starting capital ($)" },
    position_sizing_mode: {
      type: "enum", label: "Position sizing mode",
      values: ["fixed_dollars", "pct_of_capital", "risk_pct_of_capital"],
    },
    position_size_pct: { type: "float", label: "Position size (% of capital)" },
    risk_pct_of_capital: { type: "float", label: "Risk per trade (% of capital)" },
    include_commissions: { type: "bool", label: "Estimate commissions (IBKR tiered)" },
    slippage_bps: { type: "float", label: "Slippage on entries/market exits (bps, 0=off)" },
    session_start: { type: "time", label: "Session start (ET)" },
    flatten_time: { type: "time", label: "Force-exit time (ET)" },
    entry_mode: {
      type: "enum", label: "Entry style",
      values: [
        "orb_breakout", "red_candle_break", "donchian_break", "inside_bar_break", "vwap_reclaim",
        "ema_dip_reclaim", "ema_reclaim", "macd_bullish_cross", "rsi_oversold_bounce",
      ],
    },
    orb_minutes: { type: "int", label: "Opening range (min)" },
    entry_after_orb: { type: "bool", label: "Wait for opening range first" },
    donchian_lookback: { type: "int", label: "Donchian lookback (bars)" },
    ema_period: { type: "int", label: "EMA period (bars)" },
    macd_fast: { type: "int", label: "MACD fast EMA (bars)" },
    macd_slow: { type: "int", label: "MACD slow EMA (bars)" },
    macd_signal: { type: "int", label: "MACD signal EMA (bars)" },
    rsi_period: { type: "int", label: "RSI period (bars)" },
    rsi_oversold: { type: "float", label: "RSI oversold level" },
    stop_mode: {
      type: "enum", label: "Stop style",
      values: ["pattern", "fixed_cents", "fixed_pct", "prior_bar_low", "atr_multiple"],
    },
    fixed_stop_cents: { type: "float", label: "Fixed stop (¢)" },
    fixed_stop_pct: { type: "float", label: "Fixed stop (%)" },
    atr_period: { type: "int", label: "ATR period" },
    atr_mult: { type: "float", label: "ATR multiple" },
    breakeven_after_cents: { type: "float", label: "Breakeven arm (¢)" },
    target_r: { type: "float", label: "Profit target (×risk)" },
    time_stop_minutes: { type: "int", label: "Time stop (min)" },
    time_stop_min_gain_cents: { type: "float", label: "Time-stop min gain (¢)" },
    giveback_cents: { type: "float", label: "Giveback off peak (¢)" },
    giveback_pct: { type: "float", label: "Giveback off peak (%)" },
    giveback_arm_cents: { type: "float", label: "Arm giveback after (¢)" },
    stall_exit: { type: "bool", label: "Exit on momentum stall" },
    allow_reentry: { type: "bool", label: "Allow multiple trades per symbol/day" },
    max_trades_per_day: { type: "int", label: "Max trades per symbol/day" },
    reentry_cooldown_minutes: { type: "float", label: "Re-entry cooldown (min)" },
    // Position building: start at a fraction of full size, add more as
    // the trade proves itself (new high, holds, breaks again), instead
    // of taking the whole position on the first fill. Off by default.
    scale_in_enabled: { type: "bool", label: "Scale in (start small, add on strength)" },
    scale_in_initial_size_pct: { type: "float", label: "Opening size (% of full)" },
    scale_in_add_size_pct: { type: "float", label: "Each add (% of full)" },
    scale_in_max_adds: { type: "int", label: "Max adds" },
    scale_in_hold_bars: { type: "int", label: "Bars price must hold before an add can trigger" },
    scale_in_min_gain_cents: { type: "float", label: "Min open gain before scale-in arms (¢)" },
    // Tightening trail-protect stop: ratchets up to lock a GROWING share
    // of the peak gain as the trade's peak R climbs (e.g. 50% by 1R, 65%
    // by 2R, 80% by 3R+) -- no fixed targets/partials, the whole position
    // exits together whenever this (or another exit rule) fires.
    trail_protect_enabled: { type: "bool", label: "Tightening trail-protect stop" },
    trail_protect_ladder: {
      type: "ladder", label: "Protect ladder (peak R -> % of peak gain locked in)",
    },
    notes: { type: "string", label: "Strategy notes (not simulated)" },
  };

  const ENTRY_LABELS = {
    orb_breakout: "Opening range breakout",
    red_candle_break: "Break of prior red candle's high",
    donchian_break: "Donchian breakout",
    inside_bar_break: "Inside-bar break",
    vwap_reclaim: "VWAP reclaim",
    ema_dip_reclaim: "9 EMA dip & reclaim",
    ema_reclaim: "EMA reclaim",
    macd_bullish_cross: "MACD bullish cross",
    rsi_oversold_bounce: "RSI oversold bounce",
  };
  const SIZING_LABELS = {
    fixed_dollars: "Fixed $ per trade",
    pct_of_capital: "% of capital per trade",
    risk_pct_of_capital: "% of capital risked per trade",
  };
  const STOP_LABELS = {
    pattern: "Pattern-based",
    fixed_cents: "Fixed cents",
    fixed_pct: "Fixed %",
    prior_bar_low: "Low of prior bar",
    atr_multiple: "ATR multiple",
  };

  const AI_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg>`;
  const CHIP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg>`;

  let history = [];
  let draft = {};
  let requestInFlight = false;
  let awaitingConfirmation = false;

// escapeHtml() now in utils.js (loads first on every page).

  function formatReply(text) {
    const escaped = escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return escaped.split(/\n{2,}/).map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`).join("");
  }

  function avatarHtml(role) {
    return role === "user"
      ? `<div class="chat-avatar user">Y</div>`
      : `<div class="chat-avatar ai">${AI_AVATAR_SVG}</div>`;
  }

  function addBubble(role, html, extraClass) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg " + (role === "user" ? "chat-msg-user" : "chat-msg-ai");
    wrap.innerHTML = `${avatarHtml(role)}<div class="chat-bubble ${extraClass || ""}">${html}</div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function addTypingBubble() {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg chat-msg-ai";
    wrap.innerHTML = `${avatarHtml("ai")}<div class="chat-bubble chat-typing"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function renderChips() {
    if (history.length) { chipsEl.innerHTML = ""; return; }

    const promptsHtml = STARTER_PROMPTS.map(
      (p) => `<button type="button" class="chat-chip">${CHIP_ICON}${escapeHtml(p)}</button>`
    ).join("");

    chipsEl.innerHTML = `
      <div class="chat-chip-group-label">Or describe your own</div>
      <div class="chat-chip-row">${promptsHtml}</div>
    `;

    chipsEl.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        inputEl.value = btn.textContent.trim();
        formEl.requestSubmit();
      });
    });
  }

  function greet() {
    addBubble(
      "ai",
      formatReply(
        "Tell me what you want to test — an entry style, symbols/price range, stop, target, whatever you've got. I'll ask about anything important you leave out, then show you a summary right here to confirm before running it. Or pick an already-built strategy from the **Strategies** section above instead of chatting one up."
      )
    );
    renderChips();
  }
  greet();

  resetBtn.addEventListener("click", () => {
    if (requestInFlight) return;
    history = [];
    draft = {};
    awaitingConfirmation = false;
    messagesEl.innerHTML = "";
    greet();
    inputEl.focus();
  });

  // ---- coercion + merge -------------------------------------------------

  function coerce(key, value) {
    const spec = FIELD_SCHEMA[key];
    if (!spec || value === undefined || value === null) return undefined;
    switch (spec.type) {
      case "int": { const n = parseInt(value, 10); return Number.isFinite(n) ? n : undefined; }
      case "float": { const n = parseFloat(value); return Number.isFinite(n) ? n : undefined; }
      case "bool": return !!value;
      case "enum": return spec.values.includes(value) ? value : undefined;
      default: return String(value);
    }
  }

  function mergeConfig(incoming) {
    if (!incoming || typeof incoming !== "object") return false;
    let changed = false;
    for (const key of Object.keys(incoming)) {
      const v = coerce(key, incoming[key]);
      if (v !== undefined) { draft[key] = v; changed = true; }
    }
    return changed;
  }

  // Mirrors whatever's resolved in `draft` straight into the real form
  // fields -- live, on every turn, not just once the person hits "Run
  // backtest with this config". This is what makes the manual override
  // section usable mid-conversation: describe (or make up) a strategy
  // here, watch the actual inputs fill in below, then hand-tweak anything
  // before running. window.BacktesterForm.apply() only writes fields that
  // are actually present in `draft` (see applyPayload()'s `set()`/`setChk()`
  // helpers), so partially-resolved drafts never blank out fields the
  // conversation hasn't touched yet.
  function syncFormFromDraft() {
    if (!window.BacktesterForm) return;
    window.BacktesterForm.apply(draft);
    flashFormSections();
  }

  // ---- summary card -------------------------------------------------

  function money(v) { return v === undefined ? null : "$" + Number(v).toLocaleString(); }
  function cents(v) { return v === undefined ? null : v + "¢"; }
  function pct(v) { return v === undefined ? null : v + "%"; }

  function buildSummaryGroups() {
    const groups = [];

    const session = [];
    if (draft.start || draft.end) session.push(["Date range", `${draft.start || "…"} → ${draft.end || "…"}`]);
    if (draft.top_n !== undefined) session.push(["Top gappers / day", draft.top_n]);
    if (draft.min_price !== undefined || draft.max_price !== undefined) {
      session.push(["Price range", `${money(draft.min_price) || "…"} – ${money(draft.max_price) || "…"}`]);
    }
    if (draft.min_dollar_volume !== undefined) session.push(["Min $ volume", money(draft.min_dollar_volume)]);
    if (draft.min_gap_pct !== undefined) session.push(["Min gap", pct(draft.min_gap_pct)]);
    if (draft.starting_capital !== undefined) session.push(["Starting capital", money(draft.starting_capital)]);
    if (draft.position_sizing_mode) session.push(["Position sizing", SIZING_LABELS[draft.position_sizing_mode] || draft.position_sizing_mode]);
    if ((!draft.position_sizing_mode || draft.position_sizing_mode === "fixed_dollars") && draft.position_size !== undefined) {
      session.push(["Position size", money(draft.position_size)]);
    }
    if (draft.position_sizing_mode === "pct_of_capital" && draft.position_size_pct !== undefined) {
      session.push(["Position size", pct(draft.position_size_pct) + " of capital"]);
    }
    if (draft.position_sizing_mode === "risk_pct_of_capital" && draft.risk_pct_of_capital !== undefined) {
      session.push(["Risk per trade", pct(draft.risk_pct_of_capital) + " of capital"]);
    }
    if (draft.slippage_bps !== undefined) session.push(["Slippage", draft.slippage_bps > 0 ? draft.slippage_bps + " bps" : "Off"]);
    if (draft.session_start) session.push(["Session start (ET)", draft.session_start]);
    if (draft.flatten_time) session.push(["Force-exit (ET)", draft.flatten_time]);
    if (session.length) groups.push(["Scan & Session", session]);

    const entry = [];
    if (draft.entry_mode) entry.push(["Entry style", ENTRY_LABELS[draft.entry_mode] || draft.entry_mode]);
    if (draft.entry_mode === "orb_breakout" && draft.orb_minutes !== undefined) {
      entry.push(["Opening range", draft.orb_minutes + " min"]);
    }
    if (draft.entry_mode === "donchian_break" && draft.donchian_lookback !== undefined) {
      entry.push(["Donchian lookback", draft.donchian_lookback + " bars"]);
    }
    if ((draft.entry_mode === "ema_dip_reclaim" || draft.entry_mode === "ema_reclaim") && draft.ema_period !== undefined) {
      entry.push(["EMA period", draft.ema_period + " bars"]);
    }
    if (draft.entry_mode === "macd_bullish_cross") {
      if (draft.macd_fast !== undefined) entry.push(["MACD fast/slow/signal", `${draft.macd_fast}/${draft.macd_slow !== undefined ? draft.macd_slow : "…"}/${draft.macd_signal !== undefined ? draft.macd_signal : "…"}`]);
    }
    if (draft.entry_mode === "rsi_oversold_bounce") {
      if (draft.rsi_period !== undefined) entry.push(["RSI period", draft.rsi_period + " bars"]);
      if (draft.rsi_oversold !== undefined) entry.push(["RSI oversold level", draft.rsi_oversold]);
    }
    if (draft.entry_after_orb !== undefined) entry.push(["Wait for opening range", draft.entry_after_orb ? "Yes" : "No"]);
    if (entry.length) groups.push(["Entry", entry]);

    const stop = [];
    if (draft.stop_mode) stop.push(["Stop style", STOP_LABELS[draft.stop_mode] || draft.stop_mode]);
    if (draft.stop_mode === "fixed_cents" && draft.fixed_stop_cents !== undefined) stop.push(["Fixed stop", cents(draft.fixed_stop_cents)]);
    if (draft.stop_mode === "fixed_pct" && draft.fixed_stop_pct !== undefined) stop.push(["Fixed stop", pct(draft.fixed_stop_pct)]);
    if (draft.stop_mode === "atr_multiple") {
      if (draft.atr_period !== undefined) stop.push(["ATR period", draft.atr_period]);
      if (draft.atr_mult !== undefined) stop.push(["ATR multiple", draft.atr_mult + "×"]);
    }
    if (draft.breakeven_after_cents) stop.push(["Breakeven arm", cents(draft.breakeven_after_cents)]);
    if (stop.length) groups.push(["Stop Loss", stop]);

    const exits = [];
    if (draft.target_r) exits.push(["Profit target", draft.target_r + "×R"]);
    if (draft.time_stop_minutes) exits.push(["Time stop", draft.time_stop_minutes + " min"]);
    if (draft.giveback_cents) exits.push(["Giveback off peak", cents(draft.giveback_cents)]);
    if (draft.giveback_pct) exits.push(["Giveback off peak", pct(draft.giveback_pct)]);
    if (draft.stall_exit) exits.push(["Momentum stall exit", "On"]);
    if (exits.length) groups.push(["Profit Exits", exits]);

    const reentry = [];
    if (draft.allow_reentry !== undefined) reentry.push(["Multiple trades/symbol/day", draft.allow_reentry !== false ? "Yes" : "No"]);
    if (draft.allow_reentry !== false && draft.max_trades_per_day) reentry.push(["Max trades/symbol/day", draft.max_trades_per_day]);
    if (draft.allow_reentry !== false && draft.reentry_cooldown_minutes) reentry.push(["Re-entry cooldown", draft.reentry_cooldown_minutes + " min"]);
    if (reentry.length) groups.push(["Re-entry", reentry]);

    const building = [];
    if (draft.scale_in_enabled) {
      building.push(["Scale in", `${draft.scale_in_initial_size_pct !== undefined ? draft.scale_in_initial_size_pct : "…"}% opening, +${draft.scale_in_add_size_pct !== undefined ? draft.scale_in_add_size_pct : "…"}% per add, up to ${draft.scale_in_max_adds !== undefined ? draft.scale_in_max_adds : "…"} adds`]);
      if (draft.scale_in_hold_bars !== undefined) building.push(["Add trigger", `New high, hold ${draft.scale_in_hold_bars} bar(s), then break again`]);
      if (draft.scale_in_min_gain_cents) building.push(["Arms after", cents(draft.scale_in_min_gain_cents) + " open gain"]);
    }
    if (draft.trail_protect_enabled) {
      const ladder = Array.isArray(draft.trail_protect_ladder) ? draft.trail_protect_ladder : [];
      building.push(["Trail-protect stop", ladder.length
        ? ladder.map(([r, frac]) => `${r}R→${Math.round((frac > 1 ? frac : frac * 100))}%`).join(", ")
        : "On"]);
    }
    if (building.length) groups.push(["Position Building", building]);

    if (draft.notes) groups.push(["Notes (not simulated -- saved with the run for reference)", [["", draft.notes]]]);

    return groups;
  }

  function renderSummaryCard() {
    const groups = buildSummaryGroups();
    const groupsHtml = groups.map(([title, rows]) => `
      <div class="ai-summary-group-label">${escapeHtml(title)}</div>
      <div class="indicator-grid">
        ${rows.map(([k, v]) => `<div class="indicator-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join("")}
      </div>
    `).join("");

    const wrap = document.createElement("div");
    wrap.className = "chat-msg chat-msg-ai";
    wrap.innerHTML = `
      ${avatarHtml("ai")}
      <div class="chat-bubble ai-summary-bubble">
        ${groupsHtml || `<p class="dim">Nothing resolved yet.</p>`}
        <div class="ai-summary-actions">
          <button type="button" class="btn-confirm ai-summary-confirm">Run backtest with this config</button>
          <button type="button" class="filter-btn ai-summary-adjust">Keep adjusting</button>
        </div>
        <div class="ai-summary-status" style="display:none; font-size:12.5px; margin-top:8px;"></div>
      </div>
    `;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    wrap.querySelector(".ai-summary-confirm").addEventListener("click", () => runDraftBacktest(wrap));
    wrap.querySelector(".ai-summary-adjust").addEventListener("click", () => {
      awaitingConfirmation = false;
      wrap.querySelector(".ai-summary-actions").innerHTML = `<span class="dim" style="font-size:12.5px;">Sure — what would you like to change?</span>`;
      inputEl.focus();
    });
  }

  // Runs the backtest directly off `draft` -- the config this conversation
  // resolved -- rather than writing it into the form and depending on the
  // form to be read back correctly. window.BacktesterForm.run() still
  // mirrors draft into the form for visibility, but the numbers that
  // actually get simulated are the ones agreed on right here in the chat.
  function runDraftBacktest(cardEl) {
    if (!window.BacktesterForm) {
      addBubble("ai", formatReply("Couldn't reach the backtest engine on this page -- try reloading."));
      return;
    }
    if (!draft.start || !draft.end) {
      addBubble("ai", formatReply("I still need a start and end date before I can run this -- what date range?"));
      return;
    }

    awaitingConfirmation = false;
    const statusEl = cardEl.querySelector(".ai-summary-status");
    statusEl.style.display = "";
    cardEl.querySelector(".ai-summary-actions").innerHTML = `<span class="dim" style="font-size:12.5px;">Running…</span>`;
    statusEl.textContent = "Starting backtest…";

    window.BacktesterForm.run(draft, {
      onStatusChange: (text) => { statusEl.textContent = text; },
      onProgress: ({ current, total, day }) => {
        statusEl.textContent = `Running… day ${current}/${total}${day ? " — " + day : ""}`;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
      onDone: (job) => {
        const stats = job && job.stats;
        if (!stats || !stats.num_trades) {
          statusEl.textContent = "";
          addBubble("ai", formatReply("Done — no trades matched this config over that date range. Want to loosen a filter or widen the dates?"));
          return;
        }
        const pnl = Number(stats.net_pnl_dollars || 0);
        const pnlStr = (pnl >= 0 ? "+$" : "-$") + Math.abs(pnl).toFixed(2);
        const winRate = typeof stats.win_rate === "number" ? stats.win_rate.toFixed(1) + "%" : "—";
        const pf = stats.profit_factor != null ? stats.profit_factor.toFixed(2) : "—";
        const avgR = typeof stats.avg_r === "number" ? stats.avg_r.toFixed(2) + "R" : "—";
        const avgWin = typeof stats.avg_win_dollars === "number" ? "$" + stats.avg_win_dollars.toFixed(2) : "—";
        const avgLoss = typeof stats.avg_loss_dollars === "number" ? "-$" + Math.abs(stats.avg_loss_dollars).toFixed(2) : "—";
        const maxDd = typeof stats.max_drawdown_dollars === "number" ? "-$" + stats.max_drawdown_dollars.toFixed(2) : "—";
        const streaks = (stats.longest_win_streak != null && stats.longest_loss_streak != null)
          ? `${stats.longest_win_streak}W / ${stats.longest_loss_streak}L longest streaks`
          : null;

        // Quick, plain-language read on the numbers -- not just a
        // restatement of the stat grid below.
        let verdict;
        if (pnl > 0 && pf !== "—" && stats.profit_factor >= 1.5) {
          verdict = "That's a solidly profitable edge over this window.";
        } else if (pnl > 0) {
          verdict = "Profitable, but the edge is thin -- worth checking it holds up over a longer or different date range.";
        } else if (pnl === 0) {
          verdict = "Broke even -- no real edge either way here.";
        } else {
          verdict = "Net negative over this window -- this config isn't working as-is.";
        }

        statusEl.textContent = "";
        const reportHref = job && job.job_id ? `report.html?id=${encodeURIComponent(job.job_id)}` : null;
        addBubble(
          "ai",
          formatReply(
            `**Done.** ${stats.num_trades} trade${stats.num_trades === 1 ? "" : "s"}, net P&L **${pnlStr}**.\n\n` +
            `Win rate ${winRate}, profit factor ${pf}, avg ${avgR} per trade. Avg win ${avgWin}, avg loss ${avgLoss}, max drawdown ${maxDd}${streaks ? `, ${streaks}` : ""}.\n\n` +
            `${verdict}${reportHref ? `\n\n[Open the full report →](${reportHref}) for the equity curve, every trade, and a journal for this run.` : ""} Want to tweak anything or try a variant, just tell me.`
          )
        );
        flashResultsSection();
      },
      onError: (message) => {
        statusEl.textContent = "";
        addBubble("ai", formatReply(`Couldn't run that: ${escapeHtml(String(message))}`));
        cardEl.querySelector(".ai-summary-actions").innerHTML = `
          <button type="button" class="btn-confirm ai-summary-confirm">Run backtest with this config</button>
          <button type="button" class="filter-btn ai-summary-adjust">Keep adjusting</button>
        `;
        cardEl.querySelector(".ai-summary-confirm").addEventListener("click", () => runDraftBacktest(cardEl));
        cardEl.querySelector(".ai-summary-adjust").addEventListener("click", () => {
          awaitingConfirmation = false;
          cardEl.querySelector(".ai-summary-actions").innerHTML = `<span class="dim" style="font-size:12.5px;">Sure — what would you like to change?</span>`;
          inputEl.focus();
        });
      },
    });

    flashFormSections();
  }

  function flashFormSections() {
    // The field-by-field form lives inside a collapsed <details> ("rarely
    // needed" manual override) unless something has actually loaded a
    // strategy into it. Chat resolving even one field counts -- open it
    // so what the conversation has settled on so far is actually visible
    // and fine-tunable, not hidden behind an extra click. Setting .open
    // on a closed <details> fires "toggle", which backtester.html's own
    // listener uses to scroll it into view -- no need to duplicate that here.
    const details = document.getElementById("bt-manual-details");
    if (details && !details.open) details.open = true;

    const targets = document.querySelectorAll(".bt-section:not(.ai-cfg-panel), .bt-run-row");
    targets.forEach((el) => {
      el.classList.remove("just-applied");
      // eslint-disable-next-line no-unused-expressions
      void el.offsetWidth; // restart animation
      el.classList.add("just-applied");
    });
  }

  function flashResultsSection() {
    const results = document.getElementById("bt-results");
    if (results) results.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---- sending messages -------------------------------------------------

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || requestInFlight) return;
    sendMessage(text);
  });

  function sendMessage(text) {
    if (!AI_URL) {
      addBubble("user", escapeHtml(text));
      addBubble(
        "ai",
        formatReply(
          "The config service isn't set up yet in config.js, so I've got nowhere to send this. Point it at your config service and try again."
        )
      );
      inputEl.value = "";
      return;
    }

    addBubble("user", escapeHtml(text));
    history.push({ role: "user", content: text });
    inputEl.value = "";
    chipsEl.innerHTML = "";
    requestInFlight = true;
    sendBtn.disabled = true;
    const typingBubble = addTypingBubble();

    fetch(AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: history.slice(0, -1).slice(-16),
        draft,
        schema: FIELD_SCHEMA,
      }),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => {
        typingBubble.remove();
        const reply = (data && data.reply) || "Didn't get a usable reply back -- try again?";
        if (mergeConfig(data && data.config)) syncFormFromDraft();
        addBubble("ai", formatReply(reply));
        history.push({ role: "assistant", content: reply });

        const unsupported = (data && Array.isArray(data.unsupported)) ? data.unsupported.filter(Boolean) : [];
        if (unsupported.length) {
          addBubble(
            "ai",
            `<div class="ai-unsupported-warning"><strong>Heads up — these won't be part of the actual simulation</strong> (no matching field in the backtester yet):<ul>${unsupported
              .map((u) => `<li>${escapeHtml(u)}</li>`)
              .join("")}</ul>They'll be saved as notes on the run so they're not lost, but the engine won't act on them.</div>`,
            "ai-unsupported-bubble"
          );
        }

        if (data && data.status === "ready") {
          awaitingConfirmation = true;
          renderSummaryCard();
        }
      })
      .catch((err) => {
        typingBubble.remove();
        addBubble(
          "ai",
          formatReply(
            `Couldn't reach the config service (${String(err.message)}). If config.js still points at a placeholder, point it at your config service first.`
          )
        );
      })
      .finally(() => {
        requestInFlight = false;
        sendBtn.disabled = false;
        inputEl.focus();
      });
  }
})();
