// AI Chat tab — reads data/trades.json (the same index journal.html /
// stats.html / patterns.html already use), boils it down into an aggregate
// summary + a compact per-trade index, and sends that plus the running
// conversation to the CHAT_URL webhook on every message. Nothing here runs
// until the person actually sends a message, and each turn re-sends the
// full context, so the n8n side (and the LLM) never has to hold state.
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

  function addBubble(role, html) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg " + (role === "user" ? "chat-msg-user" : "chat-msg-ai");
    wrap.innerHTML = `<div class="chat-bubble">${html}</div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function addTypingBubble() {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg chat-msg-ai";
    wrap.innerHTML = `<div class="chat-bubble chat-typing"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  // ---- data loading + summarizing ----------------------------------

  fetch("data/trades.json")
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((rows) => {
      trades = Array.isArray(rows) ? rows : [];
      onDataReady();
    })
    .catch((err) => {
      dataStatusEl.innerHTML = `<span class="chat-data-status-dot error"></span> Couldn't load data/trades.json (${escapeHtml(String(err.message))}) — I can still chat, but without your trade data.`;
      renderChips();
      setInputEnabled(true);
    });

  function onDataReady() {
    if (!trades.length) {
      dataStatusEl.innerHTML = `<span class="chat-data-status-dot"></span> No trades published yet — data/trades.json is empty.`;
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

  function renderChips() {
    chipsEl.innerHTML = STARTER_PROMPTS.map(
      (p) => `<button type="button" class="chat-chip">${escapeHtml(p)}</button>`
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

  // One compact line per trade so the payload stays small even with
  // hundreds of trades logged -- same spirit as trade.js's daily-bar
  // summarizer for the SR feature.
  function buildTradesCompact(rows) {
    const MAX_ROWS = 400;
    const slice = rows.slice(-MAX_ROWS);
    const lines = slice.map((r) => {
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
    });
    if (rows.length > MAX_ROWS) {
      lines.unshift(`(showing the ${MAX_ROWS} most recent of ${rows.length} trades)`);
    }
    return lines;
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

    fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        history: history.slice(0, -1).slice(-12),
        trades_summary: buildTradesSummary(trades),
        trades_compact: buildTradesCompact(trades),
      }),
    })
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
