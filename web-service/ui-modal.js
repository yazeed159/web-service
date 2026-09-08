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
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function open(cfg) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "ui-modal-overlay";

      const iconSvg = cfg.tone === "danger"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';

      overlay.innerHTML = `
        <div class="ui-modal-box" role="alertdialog" aria-modal="true">
          <div class="ui-modal-icon ${cfg.tone === "danger" ? "danger" : "default"}">${iconSvg}</div>
          ${cfg.title ? `<div class="ui-modal-title">${escapeHtml(cfg.title)}</div>` : ""}
          <div class="ui-modal-msg">${escapeHtml(cfg.message)}</div>
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
        resolve(result);
      }
      function onKeydown(e) {
        if (e.key === "Escape") { e.preventDefault(); finish(cfg.showCancel ? null : (cfg.input ? null : false)); }
        else if (e.key === "Enter" && (document.activeElement === input || document.activeElement === confirmBtn)) {
          e.preventDefault();
          finish(cfg.input ? (input ? input.value : "") : true);
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
