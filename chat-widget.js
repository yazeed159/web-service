// chat-widget.js — floating "AI Chat" launcher, shared by every app-shell
// page. Used to be its own sidebar tab pointing at chat.html; now it's a
// small popup like most normal sites' chat widgets, with a maximize
// button for a bigger view. Injects the launcher button + panel markup
// into the page, then loads chat.js (unmodified) against it -- chat.js
// only ever touches elements by id (#chat-messages, #chat-form, etc.),
// so it works identically whether those ids live on a full page or in
// this floating panel.
(function () {
  "use strict";

  // Login page has no trade data and no sidebar/topbar chrome -- skip.
  if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;
  if (!document.getElementById("sidebar")) return;

  const OPEN_KEY = "trade.log:chatWidgetOpen";

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.id = "chatw-launcher";
  launcher.className = "chatw-launcher";
  launcher.title = "AI Chat";
  launcher.setAttribute("aria-label", "Open AI chat");
  launcher.innerHTML = `
    <svg class="chatw-icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
    <svg class="chatw-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
  `;

  const panel = document.createElement("div");
  panel.id = "chatw-panel";
  panel.className = "chatw-panel";
  panel.innerHTML = `
    <div class="chatw-panel-head">
      <span class="chatw-head-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg></span>
      <span class="chatw-panel-title">AI Chat</span>
      <span class="chatw-panel-actions">
        <button type="button" class="chatw-icon-action" id="chatw-maximize-btn" title="Maximize" aria-label="Maximize chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>
        </button>
        <button type="button" class="chatw-icon-action" id="chatw-close-btn" title="Close" aria-label="Close chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </span>
    </div>
    <div class="chatw-body chat-content">
      <div class="chat-shell">
        <div class="chat-data-status" id="chat-data-status">
          <span class="chat-data-status-dot"></span> Loading your trade data…
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-chips" id="chat-chips"></div>
        <form class="chat-input-row" id="chat-form">
          <input
            type="text"
            id="chat-input"
            class="chat-input"
            placeholder="Ask about a trade, setup, or your stats…"
            autocomplete="off"
            disabled
          >
          <button type="submit" class="chat-send-btn" id="chat-send-btn" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </form>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  document.body.appendChild(launcher);

  function setOpen(open) {
    panel.classList.toggle("open", open);
    launcher.classList.toggle("open", open);
    if (!open) {
      // Reset maximize state on close so the launcher (hidden while
      // maximized, see below) always comes back once the panel isn't
      // covering it anymore, and the panel reopens at its normal size.
      panel.classList.remove("maximized");
      launcher.classList.remove("chatw-launcher-hidden");
    }
    try { sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch (e) { /* ignore */ }
  }

  launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  document.getElementById("chatw-close-btn").addEventListener("click", () => setOpen(false));
  document.getElementById("chatw-maximize-btn").addEventListener("click", (e) => {
    const isMax = panel.classList.toggle("maximized");
    // The round launcher button sits fixed at bottom-right in every
    // state, but the maximized panel's own bottom-right corner grows
    // to almost the same spot -- without this it sat directly on top
    // of the input row/send button. The header already has its own
    // close button, so just hide the redundant launcher while maximized.
    launcher.classList.toggle("chatw-launcher-hidden", isMax);
    e.currentTarget.title = isMax ? "Restore" : "Maximize";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) setOpen(false);
  });

  // Reopen automatically if the person had it open before navigating to
  // this page -- conversation history itself is per-page-load (same as
  // the old chat.html always was), only the open/closed state persists.
  let startOpen = false;
  try { startOpen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch (e) { /* ignore */ }
  if (startOpen) setOpen(true);

  // chat.js expects #chat-messages/#chat-form/etc. to already exist (it
  // looks them up as soon as it runs, not on DOMContentLoaded), so it's
  // only loaded now that the panel markup above is in the DOM.
  const chatScript = document.createElement("script");
  chatScript.src = "chat.js";
  document.body.appendChild(chatScript);
})();
