// AI Chat tab — reads data/trades.json (the same index journal.html /
// stats.html / patterns.html already use), boils it down into an aggregate
// summary + a compact per-trade index, and sends that plus the running
// conversation to the CHAT_URL webhook on every message. Nothing here runs
// until the person actually sends a message, and each turn re-sends the
// full context, so the n8n side (and the LLM) never has to hold state.
//
// If the message looks like it's asking about a specific logged trade
// (mentions a symbol that's actually in the journal), this also pulls that
// trade's indicators (VWAP/EMA/MACD at entry, S/R levels, volume/float)
// straight from chart_service.py -- same Polygon-backed pipeline the
// Backtester tab and /generate-chart already use -- and includes just that
// small numeric block as extra context. It deliberately does NOT forward
// the chart image or the full per-minute bar series (both are in the
// /generate-chart response but would burn a lot of tokens for little
// benefit in a text chat), and it never triggers a second LLM call -- the
// fetch happens client-side, before the single request to n8n goes out.
(function () {
  "use strict";

  // The actual URL lives in config.js (window.N8N_CHAT_URL), same pattern
  // as the Support/Resistance webhook in trade.js -- point it at your own
  // n8n webhook there.
  const CHAT_URL = window.N8N_CHAT_URL || "";

  const messagesEl = document.getElementById("chat-messages");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const dataStatusEl = document.getElementById("chat-data-status");
  const chipsEl = document.getElementById("chat-chips");

  let trades = [];
  let history = []; // [{ role: 'user'|'assistant', content }]
  let requestInFlight = false;

  const STARTER_PROMPTS = [
    "What's my win rate on breakout setups?",
    "What's my most repeated mistake?",
    "How much did late exits cost me?",
    "Walk through my last losing trade",
    "Am I sizing risk consistently?",
  ];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Turns plain text (with occasional **bold**) into safe HTML with
  // paragraph/line breaks -- just enough formatting for LLM prose, no
  // full markdown parser needed.
  function formatReply(text) {
    const escaped = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return escaped
      .split(/\n{2,}/)
      .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  const AI_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg>`;

  function avatarHtml(role) {
    return role === "user"
      ? `<div class="chat-avatar user">Y</div>`
      : `<div class="chat-avatar ai">${AI_AVATAR_SVG}</div>`;
  }

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
    wrap.innerHTML = `${avatarHtml("ai")}<div class="chat-bubble chat-typing"><span></span><span></span><span></span></div>`;
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
      renderChips();
      setInputEnabled(true);
    });

  function onDataReady() {
    if (!trades.length) {
      dataStatusEl.innerHTML = `<span class="chat-data-status-dot"></span> No trades published yet.`;
    } else {
      const dates = trades.map((t) => t.trade_date).filter(Boolean).sort();
      const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "";
      dataStatusEl.innerHTML = `<span class="chat-data-status-dot ok"></span> Reading ${trades.length} trade${trades.length === 1 ? "" : "s"}${range ? " (" + escapeHtml(range) + ")" : ""}.`;
    }
    renderChips();
    setInputEnabled(true);
    if (!messagesEl.children.length) {
      addBubble(
        "ai",
        formatReply(
          "Hey — I can see your trade log. Ask me about specific trades, how a setup's performing, patterns in your lesson tags, or how your execution compares to a Ross Cameron style breakout/momentum playbook."
        )
      );
    }
  }

  const CHIP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg>`;

  function renderChips() {
    chipsEl.innerHTML = STARTER_PROMPTS.map(
      (p) => `<button type="button" class="chat-chip">${CHIP_ICON}${escapeHtml(p)}</button>`
    ).join("");
    chipsEl.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        inputEl.value = btn.textContent;
        formEl.requestSubmit();
      });
    });
  }

  function setInputEnabled(enabled) {
    inputEl.disabled = !enabled;
    sendBtn.disabled = !enabled;
  }

  // Aggregate numbers the LLM shouldn't have to (mis)compute itself from
  // a long trade list -- mirrors the math app.js/stats.html already do.
  function buildTradesSummary(rows) {
    if (!rows.length) return { trade_count: 0 };
    const wins = rows.filter((r) => r.win);
    const losses = rows.filter((r) => !r.win);
    const netPnl = rows.reduce((s, r) => s + (r.pnl_after_comm || 0), 0);
    const grossWin = wins.reduce((s, r) => s + Math.max(0, r.pnl_after_comm || 0), 0);
    const grossLoss = losses.reduce((s, r) => s + Math.max(0, -(r.pnl_after_comm || 0)), 0);
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0);

    const bySetup = {};
    for (const r of rows) {
      const key = r.setup_type || "unspecified";
      bySetup[key] = bySetup[key] || { count: 0, wins: 0, net_pnl: 0 };
      bySetup[key].count++;
      if (r.win) bySetup[key].wins++;
      bySetup[key].net_pnl += r.pnl_after_comm || 0;
    }
    for (const k of Object.keys(bySetup)) {
      const s = bySetup[k];
      s.win_rate_pct = Math.round((s.wins / s.count) * 100);
      s.net_pnl = Math.round(s.net_pnl * 100) / 100;
    }

    const tagCounts = {};
    for (const r of rows) {
      for (const tag of r.lesson_tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    const dates = rows.map((r) => r.trade_date).filter(Boolean).sort();

    return {
      trade_count: rows.length,
      date_range: dates.length ? [dates[0], dates[dates.length - 1]] : null,
      win_rate_pct: Math.round((wins.length / rows.length) * 100),
      net_pnl: Math.round(netPnl * 100) / 100,
      profit_factor: profitFactor === null ? "infinite (no losses)" : Math.round(profitFactor * 100) / 100,
      avg_win: wins.length ? Math.round((grossWin / wins.length) * 100) / 100 : 0,
      avg_loss: losses.length ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
      by_setup_type: bySetup,
      lesson_tag_counts: tagCounts,
    };
  }

  // Single-line format shared by the curated sample and by the specific-
  // trade lookup below, so both look identical to the model.
  function formatTradeLine(r) {
    const tags = (r.lesson_tags || []).join(",") || "-";
    const rvol = r.rvol_tag || "-";
    return [
      r.id || "-",
      r.trade_date || "-",
      r.symbol || "-",
      r.side || "-",
      r.setup_type || "-",
      r.win ? "WIN" : "LOSS",
      (r.pnl_after_comm != null ? r.pnl_after_comm.toFixed(2) : "-"),
      r.shares != null ? r.shares : "-",
      `${r.entry_price != null ? r.entry_price : "-"}->${r.exit_price != null ? r.exit_price : "-"}`,
      tags,
      rvol,
    ].join(" | ");
  }

  // NEVER sends the full journal. trades_summary (aggregates, built above)
  // already answers "how am I doing" / "how do setups compare" / "where
  // should I improve" style questions on its own. This adds just enough
  // concrete, citable examples for coaching-style answers without paying
  // for all 300+ rows on every single turn: worst losses, best wins, and
  // the most recent trades, deduped. A specific trade the message actually
  // asks about is looked up separately (see findRelevantTrade) and rides
  // along on top of this, so precision on a named symbol/date never
  // depends on it happening to land in this sample.
  const SAMPLE_WORST = 10;
  const SAMPLE_BEST = 5;
  const SAMPLE_RECENT = 10;

  function buildTradesSample(rows) {
    if (!rows.length) return [];
    const byPnl = [...rows].sort((a, b) => (a.pnl_after_comm || 0) - (b.pnl_after_comm || 0));
    const worst = byPnl.slice(0, SAMPLE_WORST);
    const best = byPnl.slice(-SAMPLE_BEST).reverse();
    const recent = [...rows]
      .sort((a, b) => (b.trade_date + (b.entry_time || "")).localeCompare(a.trade_date + (a.entry_time || "")))
      .slice(0, SAMPLE_RECENT);

    const seen = new Set();
    const picked = [];
    for (const r of [...worst, ...best, ...recent]) {
      const key = r.id || `${r.symbol}-${r.trade_date}-${r.entry_time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(r);
    }
    picked.sort((a, b) => (a.trade_date + (a.entry_time || "")).localeCompare(b.trade_date + (b.entry_time || "")));
    return picked.map(formatTradeLine);
  }

  // ---- chart data lookup (chart_service.py, on demand) -----------------

  // Finds the single logged trade a message is most likely asking about --
  // only matches symbols that actually appear in the journal (so "how do
  // I..." or other capitalized words never false-match), and picks the
  // most recent trade for that symbol unless the message contains another
  // trade's exact date.
  function findRelevantTrade(text) {
    if (!trades.length) return null;
    const symbols = Array.from(new Set(trades.map((t) => t.symbol).filter(Boolean)));
    if (!symbols.length) return null;

    const upper = text.toUpperCase();
    const matchedSymbol = symbols.find((sym) => new RegExp(`\\b${sym}\\b`).test(upper));
    if (!matchedSymbol) return null;

    const candidates = trades
      .filter((t) => t.symbol === matchedSymbol)
      .sort((a, b) => (a.trade_date + (a.entry_time || "")).localeCompare(b.trade_date + (b.entry_time || "")));

    const dateMatch = candidates.find((t) => t.trade_date && text.includes(t.trade_date));
    return dateMatch || candidates[candidates.length - 1] || null;
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

  // ---- sending messages ----------------------------------------------

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || requestInFlight) return;
    sendMessage(text);
  });

  function sendMessage(text) {
    if (!CHAT_URL) {
      addBubble("user", escapeHtml(text));
      addBubble(
        "ai",
        formatReply(
          "N8N_CHAT_URL isn't set yet in config.js, so I've got nowhere to send this. Point window.N8N_CHAT_URL at your own n8n chat webhook (same pattern as N8N_SR_URL) and try again."
        )
      );
      inputEl.value = "";
      return;
    }

    addBubble("user", escapeHtml(text));
    history.push({ role: "user", content: text });
    inputEl.value = "";
    requestInFlight = true;
    setInputEnabled(false);
    const typingBubble = addTypingBubble();

    // Resolved before the single request to n8n goes out -- if it matches a
    // logged trade, chart_context rides along in the same payload; nothing
    // here adds a second LLM call either way.
    const relevantTrade = findRelevantTrade(text);
    const chartContextPromise = relevantTrade ? fetchChartContext(relevantTrade) : Promise.resolve(null);

    chartContextPromise.then((chartContext) =>
      fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: history.slice(0, -1).slice(-12),
          trades_summary: buildTradesSummary(trades),
          trades_sample: buildTradesSample(trades),
          // Only present when the message actually named a symbol/date --
          // its own journal line (win/loss, pnl, tags), separate from the
          // chart indicators below, so a lookup outside the sample above
          // still gets full grounding without touching the other 300+ rows.
          matched_trade_line: relevantTrade ? formatTradeLine(relevantTrade) : null,
          chart_context: chartContext,
        }),
      })
    )
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => {
        const reply = (data && data.reply) || "Didn't get a usable reply back -- try again?";
        typingBubble.remove();
        addBubble("ai", formatReply(reply));
        history.push({ role: "assistant", content: reply });
      })
      .catch((err) => {
        typingBubble.remove();
        addBubble(
          "ai",
          formatReply(
            `Couldn't reach the chat webhook (${String(err.message)}). If N8N_CHAT_URL in config.js still points at a placeholder, wire it up to your own n8n webhook first.`
          )
        );
      })
      .finally(() => {
        requestInFlight = false;
        setInputEnabled(true);
        inputEl.focus();
      });
  }
})();
