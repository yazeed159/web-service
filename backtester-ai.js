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
//     status: "asking" | "ready"                                // "ready" -> show the summary + Confirm
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
    "Tight scalp: fixed 5c stop, exit on stall",
    "VWAP reclaim with an ATR-based stop",
  ];

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
    session_start: { type: "time", label: "Session start (ET)" },
    flatten_time: { type: "time", label: "Force-exit time (ET)" },
    entry_mode: {
      type: "enum", label: "Entry style",
      values: ["orb_breakout", "red_candle_break", "donchian_break", "inside_bar_break", "vwap_reclaim"],
    },
    orb_minutes: { type: "int", label: "Opening range (min)" },
    entry_after_orb: { type: "bool", label: "Wait for opening range first" },
    donchian_lookback: { type: "int", label: "Donchian lookback (bars)" },
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
  };

  const ENTRY_LABELS = {
    orb_breakout: "Opening range breakout",
    red_candle_break: "Break of prior red candle's high",
    donchian_break: "Donchian breakout",
    inside_bar_break: "Inside-bar break",
    vwap_reclaim: "VWAP reclaim",
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function formatReply(text) {
    const escaped = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
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
    chipsEl.innerHTML = STARTER_PROMPTS.map(
      (p) => `<button type="button" class="chat-chip">${CHIP_ICON}${escapeHtml(p)}</button>`
    ).join("");
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
        "Tell me what you want to test — an entry style, symbols/price range, stop, target, whatever you've got. I'll ask about anything important you leave out, then show you a summary to confirm before it touches the form below."
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
    if (!incoming || typeof incoming !== "object") return;
    for (const key of Object.keys(incoming)) {
      const v = coerce(key, incoming[key]);
      if (v !== undefined) draft[key] = v;
    }
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
    if (draft.position_size !== undefined) session.push(["Position size", money(draft.position_size)]);
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
          <button type="button" class="btn-confirm ai-summary-confirm">Looks good — fill the form</button>
          <button type="button" class="filter-btn ai-summary-adjust">Keep adjusting</button>
        </div>
      </div>
    `;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    wrap.querySelector(".ai-summary-confirm").addEventListener("click", () => applyDraftToForm(wrap));
    wrap.querySelector(".ai-summary-adjust").addEventListener("click", () => {
      awaitingConfirmation = false;
      wrap.querySelector(".ai-summary-actions").innerHTML = `<span class="dim" style="font-size:12.5px;">Sure — what would you like to change?</span>`;
      inputEl.focus();
    });
  }

  function applyDraftToForm(cardEl) {
    if (!window.BacktesterForm) {
      addBubble("ai", formatReply("Couldn't reach the form on this page -- try reloading."));
      return;
    }
    window.BacktesterForm.apply(draft);
    flashFormSections();
    cardEl.querySelector(".ai-summary-actions").innerHTML = `<span class="up" style="font-size:12.5px; font-weight:600;">✓ Applied to the form below</span>`;
    awaitingConfirmation = false;
    addBubble("ai", formatReply("Filled it in below — take a look and hit **Run Backtest** whenever you're ready. Want to tweak anything or test a different variant, just tell me."));
  }

  function flashFormSections() {
    const targets = document.querySelectorAll(".bt-section:not(.ai-cfg-panel), .bt-run-row");
    targets.forEach((el) => {
      el.classList.remove("just-applied");
      // eslint-disable-next-line no-unused-expressions
      void el.offsetWidth; // restart animation
      el.classList.add("just-applied");
    });
    const runRow = document.querySelector(".bt-run-row");
    if (runRow) runRow.scrollIntoView({ behavior: "smooth", block: "center" });
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
          "N8N_BACKTEST_AI_URL isn't set yet in config.js, so I've got nowhere to send this. Point window.N8N_BACKTEST_AI_URL at your own n8n webhook (same pattern as N8N_CHAT_URL) and try again."
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
        mergeConfig(data && data.config);
        addBubble("ai", formatReply(reply));
        history.push({ role: "assistant", content: reply });

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
            `Couldn't reach the config webhook (${String(err.message)}). If N8N_BACKTEST_AI_URL in config.js still points at a placeholder, wire it up to your own n8n webhook first.`
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
