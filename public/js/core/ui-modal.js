/* ===================================================================
   ui-modal — Promise-based confirm()/alert()/prompt() replacements
   that render as an in-app dialog instead of the browser's own
   chrome. Self-contained (no dependencies on app.js/rewind.js
   helpers) so it can be dropped into any page alongside ui-modal.css.

   window.UIModal.confirm(message, opts) -> Promise<boolean>
   window.UIModal.alert(message, opts)   -> Promise<void>
   window.UIModal.prompt(message, defaultValue, opts) -> Promise<string|null>

   opts (all optional): { title, tone: 'default'|'danger',
     confirmLabel, cancelLabel, inputType }
=================================================================== */
(function () {
// escapeHtml() now in utils.js (loads first on every page).

  function open(cfg) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "ui-modal-overlay";

      const iconSvg = cfg.tone === "danger"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';

      // Random-ish suffix so multiple modals (shouldn't normally overlap,
      // but better safe) never collide on id -- labelledby/describedby
      // need to point at real ids, not just rely on DOM order.
      const uid = "uim" + Math.random().toString(36).slice(2, 9);
      const titleId = uid + "-title";
      const msgId = uid + "-msg";

      overlay.innerHTML = `
        <div class="ui-modal-box" role="alertdialog" aria-modal="true"${cfg.title ? ` aria-labelledby="${titleId}"` : ""} aria-describedby="${msgId}">
          <div class="ui-modal-icon ${cfg.tone === "danger" ? "danger" : "default"}">${iconSvg}</div>
          ${cfg.title ? `<div class="ui-modal-title" id="${titleId}">${escapeHtml(cfg.title)}</div>` : ""}
          <div class="ui-modal-msg" id="${msgId}">${escapeHtml(cfg.message)}</div>
          ${cfg.input ? `<input class="ui-modal-input" type="${cfg.input.type === "number" ? "text" : "text"}" inputmode="${cfg.input.type === "number" ? "decimal" : "text"}" value="${escapeHtml(cfg.input.value)}">` : ""}
          <div class="ui-modal-actions">
            ${cfg.showCancel ? `<button type="button" class="btn-advanced" data-act="cancel">${escapeHtml(cfg.cancelLabel)}</button>` : ""}
            <button type="button" class="${cfg.tone === "danger" ? "btn-danger" : "btn-confirm"}" data-act="confirm">${escapeHtml(cfg.confirmLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const input = overlay.querySelector(".ui-modal-input");
      const confirmBtn = overlay.querySelector('[data-act="confirm"]');
      const cancelBtn = overlay.querySelector('[data-act="cancel"]');
      const box = overlay.querySelector(".ui-modal-box");
      // Element that had focus before the dialog opened -- restored on
      // close so a screen reader/keyboard user doesn't lose their place
      // in the page behind the dialog (e.g. the "Delete" button that
      // triggered a confirm()).
      const previouslyFocused = document.activeElement;

      requestAnimationFrame(() => {
        overlay.classList.add("open");
        (input || confirmBtn).focus({ preventScroll: true });
        if (input) input.select();
      });

      let done = false;
      function finish(result) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKeydown, true);
        overlay.classList.remove("open");
        setTimeout(() => overlay.remove(), 160);
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus({ preventScroll: true });
        resolve(result);
      }
      function onKeydown(e) {
        if (e.key === "Escape") { e.preventDefault(); finish(cfg.showCancel ? null : (cfg.input ? null : false)); }
        else if (e.key === "Enter" && (document.activeElement === input || document.activeElement === confirmBtn)) {
          e.preventDefault();
          finish(cfg.input ? (input ? input.value : "") : true);
        }
        // Focus trap: this is the only thing on the page that should be
        // tabbable while the dialog is open, so wrap Tab/Shift+Tab
        // between the dialog's own focusable elements instead of letting
        // it escape to the page underneath.
        else if (e.key === "Tab") {
          const focusable = Array.from(box.querySelectorAll("button, input")).filter((el) => !el.disabled);
          if (!focusable.length) return;
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      document.addEventListener("keydown", onKeydown, true);

      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(cfg.input ? null : false); });
      if (cancelBtn) cancelBtn.addEventListener("click", () => finish(cfg.input ? null : false));
      confirmBtn.addEventListener("click", () => finish(cfg.input ? (input ? input.value : "") : true));
    });
  }

  window.UIModal = {
    confirm(message, opts) {
      opts = opts || {};
      return open({
        message, title: opts.title, tone: opts.tone || "default",
        confirmLabel: opts.confirmLabel || "Confirm", cancelLabel: opts.cancelLabel || "Cancel",
        showCancel: true, input: null,
      });
    },
    alert(message, opts) {
      opts = opts || {};
      return open({
        message, title: opts.title, tone: opts.tone || "default",
        confirmLabel: opts.confirmLabel || "OK", showCancel: false, input: null,
      }).then(() => {});
    },
    prompt(message, defaultValue, opts) {
      opts = opts || {};
      return open({
        message, title: opts.title, tone: opts.tone || "default",
        confirmLabel: opts.confirmLabel || "OK", cancelLabel: opts.cancelLabel || "Cancel",
        showCancel: true, input: { type: opts.inputType || "text", value: defaultValue == null ? "" : defaultValue },
      });
    },
  };
})();
