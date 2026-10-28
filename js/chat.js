// AI Chat -- reads the trade journal (window.fetchTradesIndex, same rows the rest of the app
// uses) and answers questions about it, cheaply.
//
// How a message is handled (cheapest path first):
//   1. Local answer  -- plain "what's my win rate / best time of day / longest streak" questions
//      are answered in the browser from js/chat-facts.js. No network, no AI credits.
//   2. Cache         -- the same self-contained question on the same journal data is replayed.
//   3. One AI call   -- everything else. Instead of a thin summary + a few sample trades, the
//      request carries only the pre-computed fact tables the question needs (time of day,
//      streaks, revenge-trading checks, hold time...), chosen by chat-facts.js's router, so the
//      model reads real numbers instead of guessing, and the prompt stays a few hundred tokens.
//
// If the message names a logged trade (a symbol, "last losing trade", "worst trade"), that
// trade's journal line plus its entry-time indicators from chart_service.py ride along too.
// It never forwards the chart image or the per-minute bars.
(function () {
  "use strict";

  // The actual URL lives in config.js (window.N8N_CHAT_URL), same pattern
  // as the Support/Resistance webhook in trade.js -- point it at your own
  // n8n webhook there.
  const CHAT_URL = window.CHAT_URL || window.N8N_CHAT_URL || "";
  const Facts = window.ChatFacts || null; // js/chat-facts.js (loaded just before this file)

  const HISTORY_SENT = 6;      // turns sent with each AI call
  const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  const CACHE_MAX = 40;

  const messagesEl = document.getElementById("chat-messages");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const dataStatusEl = document.getElementById("chat-data-status");
  const chipsEl = document.getElementById("chat-chips");
  const hintsBtnEl = document.getElementById("chatw-hints-btn");

  let trades = [];
  let requestInFlight = false;

  // Conversation history persists across page navigations (same tab),
  // not just the panel's open/closed flag -- chat.js is torn down and
  // re-run fresh on every page load (see chat-widget.js), so without
  // this the whole thread was silently dropped every time you clicked
  // to another tab in the sidebar.
  const HISTORY_KEY = "trade.log:chatHistory";
  const HISTORY_LIMIT = 40; // trimmed turns kept in sessionStorage/memory

  function loadHistory() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT))); }
    catch (e) { /* ignore (private mode / storage full) */ }
  }

  let history = loadHistory(); // [{ role: 'user'|'assistant', content }]

  const STARTER_PROMPTS = [
    "What's my win rate on breakout setups?",
    "What's my most repeated mistake?",
    "How much did late exits cost me?",
    "Walk through my last losing trade",
    "Am I sizing risk consistently?",
    "Which setup makes me the most money?",
    "Which setup should I stop trading?",
    "How's my win rate trending over time?",
    "What time of day do I trade best?",
    "Am I cutting winners too early?",
    "What do my biggest losers have in common?",
    "How does my execution compare to a Ross Cameron breakout playbook?",
    "Which lesson tag costs me the most money?",
    "Am I revenge trading after losses?",
    "What's my average risk/reward ratio?",
    "Show me my longest losing streak and what caused it",
  ];

// escapeHtml() now in utils.js (loads first on every page).

  // Turns the reply (plain text with **bold**, `code`, and -/*/1. lists) into safe HTML.
  // Everything is escaped first; only the markup below is ever added.
  function inlineFmt(escaped) {
    return escaped
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function formatReply(text) {
    const lines = escapeHtml(String(text || "")).split("\n");
    const out = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inlineFmt(para.join("<br>"))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineFmt(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
    for (const raw of lines) {
      const b = raw.match(/^\s*[-*\u2022]\s+(.*)$/), n = raw.match(/^\s*\d+[.)]\s+(.*)$/);
      if (b || n) {
        flushPara();
        const tag = b ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((b || n)[1]);
      } else if (!raw.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(raw); }
    }
    flushPara(); flushList();
    return out.join("");
  }

  const AI_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg>`;

  function avatarHtml(role) {
    return role === "user"
      ? `<div class="chat-avatar user">Y</div>`
      : `<div class="chat-avatar ai">${AI_AVATAR_SVG}</div>`;
  }

  // Re-render whatever was restored from sessionStorage before any new
  // message goes out, so a tab switch looks like nothing happened.
  history.forEach((turn) => {
    addBubble(turn.role, turn.role === "user" ? escapeHtml(turn.content) : formatReply(turn.content));
  });

  function addBubble(role, html) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg " + (role === "user" ? "chat-msg-user" : "chat-msg-ai");
    wrap.innerHTML = `${avatarHtml(role)}<div class="chat-bubble">${html}</div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function addTypingBubble() {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg chat-msg-ai";
    wrap.innerHTML = `${avatarHtml("ai")}<div class="chat-bubble chat-typing" role="status" aria-label="AI Chat is typing"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  // ---- data loading + summarizing ----------------------------------

  window.fetchTradesIndex()
    .then((rows) => {
      trades = Array.isArray(rows) ? rows : [];
      onDataReady();
    })
    .catch((err) => {
      dataStatusEl.innerHTML = `<span class="chat-data-status-dot error"></span> Couldn't load your trades (${escapeHtml(String(err.message))}) — I can still chat, but without your trade data.`;
      setInputEnabled(true);
    });

  let facts = null;

  function updateStatus() {
    if (!trades.length) return;
    const dates = trades.map((t) => t.trade_date).filter(Boolean).sort();
    const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "";
    dataStatusEl.innerHTML = `<span class="chat-data-status-dot ok"></span> Reading ${trades.length} trade${trades.length === 1 ? "" : "s"}${range ? " (" + escapeHtml(range) + ")" : ""}`;
  }

  function onDataReady() {
    facts = Facts && trades.length ? Facts.computeFacts(trades) : null;
    if (!trades.length) {
      dataStatusEl.innerHTML = `<span class="chat-data-status-dot"></span> No trades published yet.`;
    } else {
      updateStatus();
    }
    setInputEnabled(true);
    if (!history.length) {
      addBubble(
        "ai",
        formatReply(
          "Hey — I've crunched your whole journal. Ask about time of day, weekdays, streaks, hold times, sizing, revenge trading, lesson tags, or any specific trade (try \"last losing trade\"). Simple stat questions are answered instantly and don't use any AI credits."
        )
      );
    }
  }

  const CHIP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg>`;

  // Only a handful of prompts show up front -- dumping all 16 into the
  // panel on first open ate up enough vertical space that the input row
  // (where you'd actually type your own first message) got pushed out of
  // view. A "More hints" chip reveals the rest in place on demand instead.
  const INITIAL_CHIP_COUNT = 4;
  let chipsExpanded = false;

  // The chip list is rebuilt (collapsed vs expanded) rather than being
  // destroyed after the first message -- its visibility is toggled from
  // then on, so the hints stay one tap away from the header button for
  // the rest of the conversation instead of only ever showing on an
  // empty chat.
  function renderChips() {
    const shown = chipsExpanded ? STARTER_PROMPTS : STARTER_PROMPTS.slice(0, INITIAL_CHIP_COUNT);
    const chipsHtml = shown
      .map((p) => `<button type="button" class="chat-chip">${CHIP_ICON}${escapeHtml(p)}</button>`)
      .join("");
    const moreHtml = chipsExpanded
      ? ""
      : `<button type="button" class="chat-chip chat-chip-more" id="chat-chips-more">More hints…</button>`;
    chipsEl.innerHTML = chipsHtml + moreHtml;

    chipsEl.querySelectorAll(".chat-chip:not(.chat-chip-more)").forEach((btn) => {
      btn.addEventListener("click", () => {
        inputEl.value = btn.textContent;
        setChipsVisible(false);
        formEl.requestSubmit();
      });
    });
    const moreBtn = document.getElementById("chat-chips-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        chipsExpanded = true;
        renderChips();
      });
    }
  }

  function setChipsVisible(visible) {
    chipsEl.classList.toggle("chatw-chips-hidden", !visible);
    if (hintsBtnEl) {
      hintsBtnEl.classList.toggle("active", visible);
      hintsBtnEl.setAttribute("aria-pressed", visible ? "true" : "false");
      hintsBtnEl.title = visible ? "Hide suggested questions" : "Suggested questions";
    }
  }

  renderChips();
  setChipsVisible(!history.length);
  if (hintsBtnEl) {
    hintsBtnEl.addEventListener("click", () => {
      setChipsVisible(chipsEl.classList.contains("chatw-chips-hidden"));
    });
  }

  function setInputEnabled(enabled) {
    inputEl.disabled = !enabled;
    sendBtn.disabled = !enabled;
  }

  // ---- reply cache (both in localStorage, both best-effort) ----

  const CACHE_KEY = "trade.log:chatCache";
  const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();
  // Only cache questions that make sense on their own -- "why?" / "and last week?" depend on the thread.
  const isSelfContained = (t) => t.length >= 18 && !/^(why|and|but|so|ok|okay|what about|how about|really|explain|more|go deeper|tell me more)\b/i.test(t.trim());
  const cacheKey = (t) => (facts ? facts.fingerprint : "x") + "|" + norm(t);

  function cacheGet(t) {
    if (!isSelfContained(t)) return null;
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      const hit = c[cacheKey(t)];
      return hit && Date.now() - hit.t < CACHE_TTL_MS ? hit.reply : null;
    } catch (e) { return null; }
  }
  function cachePut(t, reply) {
    if (!isSelfContained(t)) return;
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      c[cacheKey(t)] = { t: Date.now(), reply };
      const keys = Object.keys(c).sort((a, b) => c[b].t - c[a].t);
      keys.slice(CACHE_MAX).forEach((k) => delete c[k]);
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (e) { /* ignore (private mode / storage full) */ }
  }

  // Pulls just the numeric indicators for one trade from chart_service.py
  // -- never the chart image, never the full bar series, so this stays a
  // small, cheap addition to the prompt. Silent no-op (returns null) if
  // CHART_SERVICE_URL isn't set, isn't reachable, or the trade is missing
  // fields /generate-chart needs -- chat still works fine off the journal
  // text alone either way.
  function fetchChartContext(trade) {
    const base = (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
    if (!base || base.includes("YOUR-NGROK-SUBDOMAIN")) return Promise.resolve(null);
    if (!trade.entry_time || !trade.exit_time || trade.entry_price == null || trade.exit_price == null) {
      return Promise.resolve(null);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    return fetch(`${base}/generate-chart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        symbol: trade.symbol,
        trade_date: trade.trade_date,
        entry_time: trade.entry_time,
        exit_time: trade.exit_time,
        entry_price: trade.entry_price,
        exit_price: trade.exit_price,
        side: trade.side || "long",
        // Only ever reads data.indicators below -- never bars or the
        // image -- so skip the extra Polygon calls and the render.
        include_volume_stats: false,
        include_image: false,
      }),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => (data && data.indicators
        ? { symbol: trade.symbol, trade_date: trade.trade_date, indicators: data.indicators }
        : null))
      .catch((err) => {
        console.warn("chat.js: chart_service lookup skipped —", err.message);
        return null;
      })
      .finally(() => clearTimeout(timeout));
  }

  // ---- replies, follow-ups ----------------------------------------------

  function clearFollowups() {
    messagesEl.querySelectorAll(".chat-extra").forEach((el) => el.remove());
  }

  // Adds an AI bubble plus (optionally) a note, a "go deeper with AI" button, and 1-3 follow-up
  // suggestions -- all free, none of it calls the model.
  function addAiReply(text, opts) {
    opts = opts || {};
    const wrap = addBubble("ai", formatReply(text));
    const bubble = wrap.querySelector(".chat-bubble");
    const extra = document.createElement("div");
    extra.className = "chat-extra";
    if (opts.note) {
      const n = document.createElement("div");
      n.className = "chat-note";
      n.textContent = opts.note;
      extra.appendChild(n);
    }
    const chips = [];
    if (opts.deeperFor) chips.push({ label: "Ask AI to go deeper", ai: true });
    (opts.followups || []).forEach((q) => chips.push({ label: q }));
    if (chips.length) {
      const row = document.createElement("div");
      row.className = "chat-followups";
      chips.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chat-chip" + (c.ai ? " chat-chip-ai" : "");
        b.textContent = c.label;
        b.addEventListener("click", () => {
          if (requestInFlight) return;
          if (c.ai) sendMessage("Go deeper on that: what's driving it, and what should I change?", { forceAI: true, topicsFrom: opts.deeperFor });
          else sendMessage(c.label);
        });
        row.appendChild(b);
      });
      extra.appendChild(row);
    }
    if (extra.children.length) bubble.appendChild(extra);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  // ---- sending messages ----------------------------------------------

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || requestInFlight) return;
    sendMessage(text);
  });

  // History as sent to the model: last few turns, long replies clipped (older answers are
  // context, not something to pay to re-read in full every time).
  function trimmedHistory() {
    return history.slice(0, -1).slice(-HISTORY_SENT).map((t) => ({
      role: t.role,
      content: String(t.content || "").slice(0, t.role === "assistant" ? 600 : 400),
    }));
  }

  function finishTurn() {
    requestInFlight = false;
    setInputEnabled(true);
    inputEl.focus();
  }

  function sendMessage(text, opts) {
    opts = opts || {};
    addBubble("user", escapeHtml(text));
    history.push({ role: "user", content: text });
    saveHistory();
    clearFollowups();
    setChipsVisible(false);
    inputEl.value = "";

    // 1. Local, zero-credit answer for plain stat questions.
    if (!opts.forceAI && facts && Facts) {
      let local = null;
      try { local = Facts.localAnswer(text, facts); } catch (e) { console.warn("chat.js: local answer failed", e); }
      if (local) {
        history.push({ role: "assistant", content: local.text });
        saveHistory();
        addAiReply(local.text, {
          note: "Calculated from your journal, no AI credits used.",
          deeperFor: local.topics,
          followups: Facts.followupsFor(local.topics, [text]).concat(local.followups || []).filter((q, i, a) => a.indexOf(q) === i && q.toLowerCase() !== text.toLowerCase()).slice(0, 2),
        });
        return;
      }
    }

    if (!CHAT_URL) {
      addAiReply("The chat service isn't set up yet in config.js, so I've got nowhere to send this. Point it at your chat service and try again.");
      return;
    }

    // 2. Cached AI reply for the same question on the same data.
    if (!opts.forceAI) {
      const cached = cacheGet(text);
      if (cached) {
        history.push({ role: "assistant", content: cached });
        saveHistory();
        const topics = Facts ? Facts.routeTopics(text) : [];
        addAiReply(cached, { note: "Saved reply from earlier, no AI credits used.", followups: Facts ? Facts.followupsFor(topics, [text]) : [] });
        return;
      }
    }

    // 3. One lean AI call.
    requestInFlight = true;
    setInputEnabled(false);
    const typingBubble = addTypingBubble();

    const routeText = opts.topicsFrom ? "" : text;
    const topicList = opts.topicsFrom && opts.topicsFrom.length ? opts.topicsFrom.filter((t) => t !== "core") : null;
    const sel = facts && Facts
      ? (topicList
          ? { topics: topicList, blocks: Object.assign({ core: facts.blocks.core }, ...topicList.filter((t) => facts.blocks[t]).map((t) => ({ [t]: facts.blocks[t] }))) }
          : Facts.selectBlocks(routeText, facts))
      : { topics: [], blocks: null };

    // The trade the message is about (symbol, "last losing trade", ...), looked up on the
    // original question when this is a "go deeper" follow-up.
    const lookupText = opts.topicsFrom ? (history.filter((h) => h.role === "user").slice(-2, -1)[0] || {}).content || text : text;
    const relevantTrade = Facts ? Facts.findRelevantTrade(lookupText, trades) : null;
    const chartContextPromise = relevantTrade ? fetchChartContext(relevantTrade) : Promise.resolve(null);

    chartContextPromise.then((chartContext) =>
      fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: trimmedHistory(),
          // v2: pre-computed fact tables chosen for this question (see chat-facts.js).
          facts: sel.blocks,
          topics: sel.topics,
          // Small aggregate kept so an older server (which ignores `facts`) still has something.
          trades_summary: facts ? { trade_count: facts.n, win_rate_pct: facts.raw.winRate, net_pnl: facts.raw.net, profit_factor: facts.raw.profitFactor } : { trade_count: 0 },
          trades_sample: [],
          matched_trade_line: relevantTrade ? Facts.formatTradeLine(relevantTrade) : null,
          chart_context: chartContext,
        }),
      })
    )
      .then((r) => {
        if (r.status === 429) { const e = new Error("rate limited"); e.rateLimited = true; throw e; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        const reply = (data && data.reply) || "Didn't get a usable reply back -- try again?";
        typingBubble.remove();
        const ok = data && data.reply && !data.error && !data.rate_limited;
        history.push({ role: "assistant", content: reply });
        saveHistory();
        if (ok && !opts.forceAI) cachePut(text, reply);
        addAiReply(reply, { followups: ok && Facts ? Facts.followupsFor(sel.topics, [text]) : [] });
      })
      .catch((err) => {
        typingBubble.remove();
        addAiReply(
          err && err.rateLimited
            ? "The AI is rate-limited right now (free quota). Give it a minute and try again. Stat questions still work instantly."
            : `Couldn't reach the chat service (${String(err && err.message)}). If it's been idle it may be waking up, so try again in a few seconds.`
        );
      })
      .finally(finishTurn);
  }
})();
