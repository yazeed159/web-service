// mobile-extras.js -- phone-first daily-use helpers, loaded on every app-shell page.
//
//   QuickAdd      bottom sheet to jot a note on a trade (or on today) in two taps.
//                 Opened by the "+" in the bottom nav, by the home-screen
//                 shortcuts (?quick=trade / ?quick=note, see manifest.json),
//                 and by the Journal's swipe actions.
//   PullRefresh   pull down at the top of a page to re-fetch its data in place.
//                 A page opts in with PullRefresh.set(() => Promise).
//   ScrollMemory  remembers scroll position per page so Back from a trade lands
//                 where you were (filters/depth are already mirrored into the URL
//                 by NavState; this adds the missing scroll offset).
//   Swipe rows    swipe a Journal card left for Tag / Delete, right for Note. The
//                 gesture only reports intent (a "journal:swipe" event on the row);
//                 journal.html decides what each action does.
//
// Everything here is loaded once per document. The SPA router (page-transition.js)
// swaps page content but never reloads this file, so every listener is delegated
// on document/window and looks things up at event time.
(function () {
  "use strict";
  if (window.__mobileExtras) return;
  window.__mobileExtras = true;

  var phone = window.matchMedia ? window.matchMedia("(max-width: 760px)") : { matches: false };
  function esc(s) {
    return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(v) {
    if (window.fmtMoney) return window.fmtMoney(v);
    var n = Number(v) || 0;
    return (n < 0 ? "-$" : "+$") + Math.abs(n).toFixed(2);
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function hhmm() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  // ====================================================================
  // Haptics -- one small API for every "something happened" tap.
  //   Haptics.play("tap" | "select" | "success" | "warn" | "buy" | "sell")
  // Any button can also opt in declaratively: <button data-haptic="success">.
  // Android/Chrome uses navigator.vibrate. iOS Safari has no vibrate(), but
  // toggling a hidden <input switch> from a tap gives a light system tick on
  // iOS 17.4+, so that is used there. Anywhere neither works it is a silent
  // no-op. Respects reduced-motion, and can be turned off with
  // localStorage["trade.log:haptics"] = "off".
  // ====================================================================
  var Haptics = (function () {
    var PATTERNS = {
      tap: [8], select: [5], success: [10, 45, 14], warn: [18, 60, 18],
      buy: [14], sell: [10, 40, 10],
    };
    var canVibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
    var iosLabel = null;
    function disabled() {
      try { if (localStorage.getItem("trade.log:haptics") === "off") return true; } catch (e) { /* ignore */ }
      try { if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true; } catch (e) { /* ignore */ }
      return false;
    }
    function iosTick() {
      try {
        if (!iosLabel) {
          iosLabel = document.createElement("label");
          iosLabel.setAttribute("aria-hidden", "true");
          iosLabel.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
          var box = document.createElement("input");
          box.type = "checkbox";
          box.setAttribute("switch", "");
          box.tabIndex = -1;
          iosLabel.appendChild(box);
          document.body.appendChild(iosLabel);
        }
        iosLabel.click();
      } catch (e) { /* not supported */ }
    }
    function play(kind) {
      if (disabled()) return;
      var pattern = PATTERNS[kind] || PATTERNS.tap;
      if (canVibrate) {
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
        return;
      }
      // iOS: a tick per "on" segment of the pattern.
      var at = 0;
      for (var i = 0; i < pattern.length; i += 2) {
        (function (delay) { if (delay === 0) iosTick(); else setTimeout(iosTick, delay); })(at);
        at += pattern[i] + (pattern[i + 1] || 0) + 40;
      }
    }
    // data-haptic on a button/link fires on tap. Disabled controls never emit
    // a click, so a blocked buy/sell stays silent.
    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-haptic]") : null;
      if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;
      play(el.getAttribute("data-haptic") || "tap");
    }, true);
    return { play: play };
  })();
  window.Haptics = Haptics;
  function buzz(ms) { Haptics.play(ms && ms > 9 ? "tap" : "select"); }

  // ====================================================================
  // Number-field keypads
  // A phone shows a full QWERTY keyboard for type="number" text fields on some
  // browsers and no decimal point on others. Where a field can't be negative
  // (min >= 0) it gets a numeric keypad (whole numbers) or a decimal keypad
  // (prices, percents). Fields that may go negative (P&L filters) are left
  // alone, because the iOS number pads have no minus key. Fields that already
  // set inputmode are respected. Runs on every page and on SPA swaps.
  // ====================================================================
  (function numberKeypads() {
    function enhance(root) {
      var list = (root || document).querySelectorAll('input[type="number"]:not([inputmode])');
      Array.prototype.forEach.call(list, function (el) {
        var min = el.getAttribute("min");
        if (min === null || min === "" || !(parseFloat(min) >= 0)) return;
        var step = el.getAttribute("step");
        var whole = step !== null && /^[0-9]+$/.test(step);
        el.setAttribute("inputmode", whole ? "numeric" : "decimal");
        if (!el.hasAttribute("enterkeyhint")) el.setAttribute("enterkeyhint", "done");
      });
    }
    enhance(document);
    if (window.MutationObserver) {
      var queued = false;
      new MutationObserver(function () {
        if (queued) return;
        queued = true;
        setTimeout(function () { queued = false; enhance(document); }, 60);
      }).observe(document.body, { childList: true, subtree: true });
    }
  })();
  function toast(msg, opts) { if (window.showToast) window.showToast(msg, opts); }
  function loadScript(src, probe) {
    if (probe && window[probe]) return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = s.onerror = function () { resolve(); };
      document.body.appendChild(s);
    });
  }

  // ====================================================================
  // ScrollMemory
  // ====================================================================
  var ScrollMemory = (function () {
    var armed = {};
    var queued = false;

    function keyOf() {
      return (location.pathname.split("/").pop() || "index").replace(/\.html$/, "") || "index";
    }
    function skey(k) { return "tl:scroll:" + k; }
    function where() { return location.search + location.hash; }
    function readRec(k) {
      try { return JSON.parse(sessionStorage.getItem(skey(k)) || "null"); } catch (e) { return null; }
    }
    function writeRec(k) {
      try { sessionStorage.setItem(skey(k), JSON.stringify({ q: where(), y: Math.round(window.scrollY) })); } catch (e) { /* private mode */ }
    }
    // Was this page reached by Back/Forward (or by an in-app "back to list" link)?
    // A fresh tap on the nav should start at the top, so only those restore.
    function isBack(k) {
      var flagged = false;
      try {
        flagged = sessionStorage.getItem("tl:return") === k;
        if (flagged) sessionStorage.removeItem("tl:return");
      } catch (e) { /* ignore */ }
      if (flagged) return true;
      if (window.__navKind) return window.__navKind === "pop"; // set by page-transition.js on SPA swaps
      try {
        var n = performance.getEntriesByType("navigation")[0];
        return !!n && n.type === "back_forward";
      } catch (e) { return false; }
    }

    // Call at the very start of a page's script, BEFORE any scroll can happen
    // (the SPA router scrolls to the top once the swap finishes, which would
    // otherwise overwrite the saved offset).
    function begin(k) {
      armed[k] = false;
      try { history.scrollRestoration = "manual"; } catch (e) { /* ignore */ }
      return { key: k, rec: readRec(k), back: isBack(k), done: false };
    }
    // Call once the page has drawn its content (so the document is tall enough).
    function finish(snap) {
      if (!snap || snap.done) return;
      snap.done = true;
      if (snap.back && snap.rec && snap.rec.q === where() && snap.rec.y > 0) {
        window.scrollTo(0, snap.rec.y);
      }
      armed[snap.key] = true;
    }
    // The next visit to this page restores (used by "All trades" back-links).
    function markReturn(k) { try { sessionStorage.setItem("tl:return", k); } catch (e) { /* ignore */ } }
    function saveNow() {
      var k = keyOf();
      if (armed[k]) writeRec(k);
    }

    window.addEventListener("scroll", function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; saveNow(); }, 120);
    }, { passive: true });
    window.addEventListener("pagehide", saveNow);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") saveNow();
    });

    return { begin: begin, finish: finish, markReturn: markReturn, saveNow: saveNow };
  })();
  window.ScrollMemory = ScrollMemory;

  // "All trades" on trade.html goes back to the Journal as you left it (filters,
  // sort, how far you'd loaded) instead of a blank one.
  (function backLinks() {
    var url = null;
    try { url = sessionStorage.getItem("tl:journal:url"); } catch (e) { /* ignore */ }
    var links = document.querySelectorAll('a.back-link[href="journal.html"]');
    Array.prototype.forEach.call(links, function (a) {
      if (url) a.setAttribute("href", url);
      a.addEventListener("click", function () { ScrollMemory.markReturn("journal"); });
    });
  })();

  // ====================================================================
  // PullRefresh
  // ====================================================================
  var PullRefresh = (function () {
    var handler = null;
    var busy = false;
    var ind = null, label = null;
    var THRESH = 60;

    function ensureIndicator() {
      if (ind) return;
      ind = document.createElement("div");
      ind.className = "ptr";
      ind.setAttribute("aria-hidden", "true");
      ind.innerHTML = '<div class="ptr-pill"><span class="ptr-spin"></span><span class="ptr-label">Pull to refresh</span></div>';
      document.body.appendChild(ind);
      label = ind.querySelector(".ptr-label");
    }
    function show(offset, ready) {
      ensureIndicator();
      ind.style.setProperty("--ptr-y", offset + "px");
      ind.style.opacity = String(Math.min(1, offset / 36));
      ind.classList.toggle("ready", !!ready);
      ind.classList.remove("busy", "done");
      label.textContent = ready ? "Release to refresh" : "Pull to refresh";
    }
    function hide(delay) {
      if (!ind) return;
      setTimeout(function () {
        ind.classList.add("settling");
        ind.style.setProperty("--ptr-y", "0px");
        ind.style.opacity = "0";
        setTimeout(function () { if (ind) ind.classList.remove("settling", "busy", "done", "ready"); }, 260);
      }, delay || 0);
    }
    function nearHorizontalScroller(el) {
      for (var n = el; n && n !== document.body; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 2) {
          var ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll") return true;
        }
      }
      return false;
    }

    var startY = 0, startX = 0, dy = 0, tracking = false, pulling = false;
    function onMove(e) {
      if (!tracking) return;
      var t = e.touches[0];
      dy = t.clientY - startY;
      if (!pulling) {
        if (dy < 6) return;
        if (Math.abs(t.clientX - startX) > dy) { stop(); return; } // mostly sideways
        if (window.scrollY > 0) { stop(); return; }
        pulling = true;
      }
      if (e.cancelable) e.preventDefault();
      var off = Math.min(84, dy * 0.45);
      show(off, off >= THRESH * 0.9);
    }
    function onEnd() {
      var wasPulling = pulling, ready = ind && ind.classList.contains("ready");
      stop();
      if (!wasPulling) return;
      if (!ready || !handler) { hide(0); return; }
      run();
    }
    function stop() {
      tracking = false; pulling = false;
      document.removeEventListener("touchmove", onMove, { passive: false });
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    }
    function run() {
      if (busy || !handler) return;
      busy = true;
      ensureIndicator();
      ind.style.setProperty("--ptr-y", "52px");
      ind.style.opacity = "1";
      ind.classList.remove("ready");
      ind.classList.add("busy");
      label.textContent = "Refreshing…";
      buzz(10);
      var fn = handler;
      var started = Date.now();
      Promise.resolve().then(function () { return fn(); }).then(function () {
        return true;
      }, function () {
        return false;
      }).then(function (ok) {
        var wait = Math.max(0, 450 - (Date.now() - started)); // never flash
        setTimeout(function () {
          busy = false;
          ind.classList.remove("busy");
          ind.classList.add("done");
          label.textContent = ok ? "Updated" : "Couldn't refresh";
          hide(ok ? 550 : 1100);
        }, wait);
      });
    }

    document.addEventListener("touchstart", function (e) {
      if (!handler || busy || !phone.matches || e.touches.length !== 1) return;
      if (window.scrollY > 0) return;
      var root = document.documentElement;
      if (root.classList.contains("qa-open") || root.classList.contains("chart-fs-lock")) return;
      var el = e.target;
      if (!el || !el.closest) return;
      if (el.closest(".sidebar.mobile-open, .chatw-panel, .qa-sheet, .ui-modal-overlay, .modal, textarea, input, select, #equity-chart-wrap, svg, canvas")) return;
      if (nearHorizontalScroller(el)) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      dy = 0; tracking = true; pulling = false;
      // Registered only for the length of a candidate pull so the page's normal
      // scrolling is never held up by a non-passive listener.
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    }, { passive: true });

    return {
      // fn() should return a Promise; pass null to clear (the SPA router does on every swap).
      set: function (fn) {
        handler = typeof fn === "function" ? fn : null;
        document.documentElement.classList.toggle("has-ptr", !!handler);
      },
      trigger: function () { run(); },
    };
  })();
  window.PullRefresh = PullRefresh;

  // ====================================================================
  // QuickAdd
  // ====================================================================
  var QuickAdd = (function () {
    var built = false;
    var sheet, backdrop, ta, pick, chipsBox, rulesBox, tabsBox, tradeBox, saveBtn, titleEl, customIn;
    var st = { mode: "trade", focus: null, mistakes: [], rules: null, startMistakes: "", startRules: null };
    var cache = { at: 0, rows: null };

    function build() {
      if (built) return;
      built = true;
      backdrop = document.createElement("div");
      backdrop.className = "qa-backdrop";
      backdrop.addEventListener("click", close);
      sheet = document.createElement("div");
      sheet.className = "qa-sheet";
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-modal", "true");
      sheet.setAttribute("aria-label", "Quick note");
      sheet.innerHTML =
        '<div class="qa-grab" aria-hidden="true"></div>' +
        '<div class="qa-head"><span class="qa-title">Quick note</span><button type="button" class="qa-x" aria-label="Close">&#10005;</button></div>' +
        '<div class="qa-tabs" role="tablist">' +
          '<button type="button" role="tab" data-mode="trade">On a trade</button>' +
          '<button type="button" role="tab" data-mode="day">On today</button>' +
        '</div>' +
        '<div class="qa-trade qa-trade-top"><select class="qa-pick" aria-label="Trade"></select></div>' +
        '<textarea class="qa-text" rows="3" enterkeyhint="done" placeholder="What happened? One line is plenty…"></textarea>' +
        '<div class="qa-trade qa-trade-more">' +
          '<div class="qa-lbl">What went wrong? <span>tap any that apply</span></div>' +
          '<div class="qa-chips"></div>' +
          '<div class="qa-lbl">Followed my rules?</div>' +
          '<div class="qa-rules">' +
            '<button type="button" data-v="yes">Yes</button><button type="button" data-v="no">No</button>' +
          '</div>' +
        '</div>' +
        '<div class="qa-foot">' +
          '<a class="qa-link" href="import-trades.html">Import trades</a>' +
          '<button type="button" class="qa-save">Save</button>' +
        '</div>';
      document.body.appendChild(backdrop);
      document.body.appendChild(sheet);
      ta = sheet.querySelector(".qa-text");
      pick = sheet.querySelector(".qa-pick");
      chipsBox = sheet.querySelector(".qa-chips");
      rulesBox = sheet.querySelector(".qa-rules");
      tabsBox = sheet.querySelector(".qa-tabs");
      tradeBox = sheet.querySelectorAll(".qa-trade");
      saveBtn = sheet.querySelector(".qa-save");
      titleEl = sheet.querySelector(".qa-title");

      sheet.querySelector(".qa-x").addEventListener("click", close);
      saveBtn.addEventListener("click", save);
      tabsBox.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-mode]");
        if (b) setMode(b.getAttribute("data-mode"));
      });
      pick.addEventListener("change", function () { loadEntry(pick.value); });
      chipsBox.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-tag]");
        if (!b) return;
        var t = b.getAttribute("data-tag");
        var i = st.mistakes.indexOf(t);
        if (i === -1) st.mistakes.push(t); else st.mistakes.splice(i, 1);
        paintChips();
      });
      rulesBox.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-v]");
        if (!b) return;
        var v = b.getAttribute("data-v") === "yes";
        st.rules = st.rules === v ? null : v;
        paintRules();
      });
      sheet.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { close(); return; }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        var c = e.target.closest && e.target.closest(".qa-custom");
        if (c && e.key === "Enter") {
          e.preventDefault();
          var v = c.value.trim();
          if (v && st.mistakes.indexOf(v) === -1) st.mistakes.push(v);
          c.value = "";
          paintChips();
          var again = sheet.querySelector(".qa-custom");
          if (again) again.focus();
        }
      });
      // Lift the sheet above the on-screen keyboard.
      if (window.visualViewport) {
        var vv = window.visualViewport;
        var fit = function () {
          if (!sheet.classList.contains("open")) return;
          var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
          sheet.style.setProperty("--kb", kb + "px");
          sheet.style.setProperty("--vvh", vv.height + "px");
        };
        vv.addEventListener("resize", fit);
        vv.addEventListener("scroll", fit);
      }
    }

    function tradesCached() {
      if (cache.rows && Date.now() - cache.at < 45000) return Promise.resolve(cache.rows);
      if (!window.fetchTradesIndex) return Promise.resolve([]);
      return window.fetchTradesIndex().then(function (rows) {
        cache = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] };
        return cache.rows;
      }, function () { return cache.rows || []; });
    }
    function sortedDesc(rows) {
      return rows.slice().sort(function (a, b) {
        return String(b.trade_date + (b.entry_time || "")).localeCompare(String(a.trade_date + (a.entry_time || "")));
      });
    }
    function tradeLabel(r) {
      var d = r.trade_date === todayIso() ? "Today" : String(r.trade_date || "").slice(5);
      return r.symbol + " · " + d + " " + String(r.entry_time || "").slice(0, 5) + " · " + money(r.pnl_after_comm || 0);
    }

    function setMode(mode) {
      st.mode = mode;
      Array.prototype.forEach.call(tabsBox.children, function (b) {
        var on = b.getAttribute("data-mode") === mode;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      Array.prototype.forEach.call(tradeBox, function (n) { n.style.display = mode === "trade" ? "" : "none"; });
      ta.style.display = mode === "trade" && st.focus === "tags" ? "none" : "";
      ta.placeholder = mode === "trade" ? "What happened? One line is plenty…" : "A thought for today — mindset, market, lesson…";
      titleEl.textContent = mode === "trade" ? (st.focus === "tags" ? "Tag trade" : "Note on a trade") : "Note for today";
    }
    function paintChips() {
      var known = window.TradeNotes ? window.TradeNotes.knownTags().mistakes : [];
      var all = known.slice();
      st.mistakes.forEach(function (m) { if (all.indexOf(m) === -1) all.push(m); });
      chipsBox.innerHTML = all.map(function (t) {
        var on = st.mistakes.indexOf(t) !== -1;
        return '<button type="button" class="qa-chip' + (on ? " on" : "") + '" data-tag="' + esc(t) + '" aria-pressed="' + on + '">' + esc(t) + "</button>";
      }).join("") + '<input class="qa-custom" placeholder="+ custom" aria-label="Custom tag" maxlength="40">';
    }
    function paintRules() {
      Array.prototype.forEach.call(rulesBox.children, function (b) {
        var yes = b.getAttribute("data-v") === "yes";
        b.classList.toggle("on", st.rules === yes);
        b.classList.toggle("bad", st.rules === false && !yes);
      });
    }
    function loadEntry(id) {
      var e = (window.TradeNotes && window.TradeNotes.get(id)) || {};
      st.mistakes = (e.mistakes || []).slice();
      st.rules = e.followed_rules === true ? true : e.followed_rules === false ? false : null;
      st.startMistakes = JSON.stringify(st.mistakes.slice().sort());
      st.startRules = st.rules;
      paintChips();
      paintRules();
    }

    function open(opts) {
      opts = opts || {};
      build();
      st.focus = opts.focus || null;
      document.documentElement.classList.add("qa-open");
      backdrop.classList.add("open");
      sheet.classList.add("open");
      sheet.style.setProperty("--kb", "0px");
      ta.value = "";
      var wantMode = opts.mode === "day" ? "day" : "trade";
      setMode(wantMode);
      saveBtn.disabled = true; // until the trade list + notes libraries are in
      Promise.all([
        loadScript("js/trade-notes.js", "TradeNotes"),
        loadScript("js/daily-notes.js", "DailyNotes"),
        tradesCached(),
      ]).then(function (res) {
        var rows = sortedDesc(res[2]).slice(0, 15);
        if (!rows.length) {
          pick.innerHTML = '<option value="">No trades yet</option>';
          if (wantMode === "trade") setMode("day");
          tabsBox.querySelector('[data-mode="trade"]').disabled = true;
        } else {
          tabsBox.querySelector('[data-mode="trade"]').disabled = false;
          pick.innerHTML = rows.map(function (r) {
            return '<option value="' + esc(r.id) + '">' + esc(tradeLabel(r)) + "</option>";
          }).join("");
          if (opts.tradeId) {
            if (!rows.some(function (r) { return r.id === opts.tradeId; })) {
              var extra = (res[2] || []).filter(function (r) { return r.id === opts.tradeId; })[0];
              if (extra) pick.insertAdjacentHTML("afterbegin", '<option value="' + esc(extra.id) + '">' + esc(tradeLabel(extra)) + "</option>");
            }
            pick.value = opts.tradeId;
          }
          loadEntry(pick.value);
        }
        saveBtn.disabled = false;
      });
      setTimeout(function () { if (ta.style.display !== "none") ta.focus(); }, 260);
    }
    function close() {
      if (!built) return;
      sheet.classList.remove("open");
      backdrop.classList.remove("open");
      document.documentElement.classList.remove("qa-open");
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }

    function save() {
      var text = ta.value.trim();
      if (st.mode === "day") {
        if (!text) { ta.focus(); return; }
        if (!window.DailyNotes) { toast("Couldn't save — notes aren't loaded yet", { tone: "error" }); return; }
        window.DailyNotes.addThought(todayIso(), text);
        window.dispatchEvent(new CustomEvent("tradelog:note-saved", { detail: { day: todayIso() } }));
        Haptics.play("success");
        close();
        toast("Added to today's notes");
        return;
      }
      var id = pick.value;
      if (!id || !window.TradeNotes) { toast("Pick a trade first", { tone: "error" }); return; }
      var tagsOnly = st.focus === "tags";
      var changed = (tagsOnly ? false : !!text) ||
        JSON.stringify(st.mistakes.slice().sort()) !== st.startMistakes || st.rules !== st.startRules;
      if (!changed) { if (!tagsOnly) ta.focus(); else close(); return; }
      var cur = window.TradeNotes.get(id) || {};
      var notes = cur.notes || "";
      if (text && !tagsOnly) notes = (notes ? notes.replace(/\s+$/, "") + "\n" : "") + "[" + hhmm() + "] " + text;
      window.TradeNotes.save(id, Object.assign({}, cur, {
        mistakes: st.mistakes.slice(),
        followed_rules: st.rules,
        notes: notes,
      }));
      window.dispatchEvent(new CustomEvent("tradelog:note-saved", { detail: { tradeId: id } }));
      Haptics.play("success");
      var label = pick.options[pick.selectedIndex] ? pick.options[pick.selectedIndex].textContent.split(" · ")[0] : "trade";
      close();
      toast("Saved to " + label);
    }

    return { open: open, close: close, invalidate: function () { cache = { at: 0, rows: null }; } };
  })();
  window.QuickAdd = QuickAdd;

  // Home-screen shortcuts / deep links: ?quick=trade | note
  (function quickFromUrl() {
    var q;
    try { q = new URLSearchParams(location.search).get("quick"); } catch (e) { return; }
    if (!q) return;
    try {
      var p = new URLSearchParams(location.search);
      p.delete("quick");
      var qs = p.toString();
      history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    } catch (e) { /* ignore */ }
    var go = function () { QuickAdd.open({ mode: q === "note" ? "day" : "trade" }); };
    if (document.readyState === "complete") setTimeout(go, 150);
    else window.addEventListener("load", function () { setTimeout(go, 150); });
  })();

  // ====================================================================
  // Swipe rows (Journal cards)
  // ====================================================================
  var Swipe = (function () {
    var ROW = ".journal-data-table tbody tr[data-id]";
    var W_RIGHT = 144, W_LEFT = 76;     // revealed widths: [Tag][Delete] and [Note]
    var cur = null;                      // gesture in progress
    var openRow = null;                  // { tr, panel, side }
    var lastEnd = 0;

    function panelFor(tr, side) {
      var tbody = tr.parentElement;
      var p = document.createElement("div");
      p.className = "sw-panel sw-" + side;
      p.setAttribute("data-for", tr.getAttribute("data-id"));
      if (side === "right") {
        p.innerHTML =
          '<button type="button" class="sw-btn sw-tag" data-act="tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg><span>Tag</span></button>' +
          '<button type="button" class="sw-btn sw-del" data-act="delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg><span>Delete</span></button>';
      } else {
        p.innerHTML =
          '<button type="button" class="sw-btn sw-note" data-act="note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg><span>Note</span></button>';
      }
      tbody.appendChild(p);
      p.style.top = tr.offsetTop + "px";
      p.style.height = tr.offsetHeight + "px";
      return p;
    }
    function setX(tr, x) { tr.style.transform = x ? "translate3d(" + x + "px,0,0)" : ""; }

    function closeOpen(animate) {
      if (!openRow) return;
      var o = openRow;
      openRow = null;
      if (animate === false) o.tr.classList.remove("sw-anim");
      else o.tr.classList.add("sw-anim");
      setX(o.tr, 0);
      setTimeout(function () {
        o.tr.classList.remove("sw-anim", "sw-open");
        if (o.panel && o.panel.parentNode) o.panel.parentNode.removeChild(o.panel);
      }, animate === false ? 0 : 220);
    }

    document.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch" || !phone.matches) return;
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(".sw-panel")) return;
      var tr = t.closest(ROW);
      if (openRow && (!tr || tr !== openRow.tr)) closeOpen();
      if (!tr) return;
      if (t.closest("input, button, select, a, .quick-edit-panel")) return;
      cur = {
        tr: tr, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dir: null,
        base: openRow && openRow.tr === tr ? (openRow.side === "right" ? -W_RIGHT : W_LEFT) : 0,
        t0: Date.now(), panel: openRow && openRow.tr === tr ? openRow.panel : null,
        side: openRow && openRow.tr === tr ? openRow.side : null,
      };
    }, { passive: true });

    document.addEventListener("pointermove", function (e) {
      if (!cur || e.pointerId !== cur.id) return;
      var dx = e.clientX - cur.x0, dy = e.clientY - cur.y0;
      if (cur.dir === null) {
        if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.3) cur.dir = "h"; else { cur = null; return; }
        cur.tr.classList.add("sw-drag");
        cur.tr.classList.remove("sw-anim");
        try { cur.tr.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      var x = cur.base + dx;
      // Resistance past the revealed width.
      if (x < -W_RIGHT) x = -W_RIGHT + (x + W_RIGHT) * 0.25;
      if (x > W_LEFT) x = W_LEFT + (x - W_LEFT) * 0.25;
      var side = x < 0 ? "right" : "left";
      if (Math.abs(x) > 1 && (!cur.panel || cur.side !== side)) {
        if (cur.panel && cur.panel.parentNode) cur.panel.parentNode.removeChild(cur.panel);
        cur.panel = panelFor(cur.tr, side);
        cur.side = side;
      }
      cur.x = x;
      setX(cur.tr, x);
    }, { passive: true });

    function finish(e, cancelled) {
      if (!cur || (e && e.pointerId !== cur.id)) return;
      var g = cur;
      cur = null;
      if (g.dir !== "h") return;
      lastEnd = Date.now();
      g.tr.classList.remove("sw-drag");
      try { g.tr.releasePointerCapture(g.id); } catch (err) { /* ignore */ }
      var x = g.x || 0;
      var fast = Math.abs(x - g.base) > 30 && (Date.now() - g.t0) < 260;
      var snapRight = x < -W_RIGHT * (fast ? 0.18 : 0.45);
      var snapLeft = x > W_LEFT * (fast ? 0.25 : 0.5);
      if (cancelled) { snapRight = snapLeft = false; }
      g.tr.classList.add("sw-anim");
      if (snapRight || snapLeft) {
        var side = snapRight ? "right" : "left";
        if (g.panel && g.side !== side) { g.panel.remove(); g.panel = null; }
        if (!g.panel) g.panel = panelFor(g.tr, side);
        if (openRow && openRow.tr !== g.tr) closeOpen(false);
        openRow = { tr: g.tr, panel: g.panel, side: side };
        g.tr.classList.add("sw-open");
        setX(g.tr, snapRight ? -W_RIGHT : W_LEFT);
        if (!(g.base && g.base === (snapRight ? -W_RIGHT : W_LEFT))) buzz(8);
      } else {
        openRow = { tr: g.tr, panel: g.panel, side: g.side };
        closeOpen();
      }
    }
    document.addEventListener("pointerup", function (e) { finish(e, false); }, { passive: true });
    document.addEventListener("pointercancel", function (e) { finish(e, true); }, { passive: true });

    // Swallow the click a finished swipe (or a tap on an already-open row) would
    // otherwise turn into "open this trade".
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var panelBtn = t.closest(".sw-panel [data-act]");
      if (panelBtn) {
        e.preventDefault();
        e.stopPropagation();
        var panel = panelBtn.closest(".sw-panel");
        var id = panel.getAttribute("data-for");
        var tr = panel.parentElement.querySelector('tr[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
        var act = panelBtn.getAttribute("data-act");
        closeOpen(act === "delete" ? false : true);
        (tr || panel).dispatchEvent(new CustomEvent("journal:swipe", { bubbles: true, detail: { id: id, action: act } }));
        return;
      }
      if (Date.now() - lastEnd < 350 && t.closest(ROW)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      var row = t.closest(ROW);
      if (openRow && row && row === openRow.tr) {
        e.preventDefault();
        e.stopPropagation();
        closeOpen();
      }
    }, true);

    window.addEventListener("scroll", function () { if (openRow && !cur) closeOpen(); }, { passive: true });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeOpen(); });
    return { close: closeOpen };
  })();
  window.JournalSwipe = Swipe;

  // ====================================================================
  // Data freshness -- "Updated 2 min ago" next to the page title.
  // auth.js / app-shared.js announce every load as a "tradelog:data" event
  // (cached = painted from the on-device snapshot and refreshing, fresh =
  // just fetched, offline = refresh failed so the snapshot stays on screen).
  // Only shown on a page that announced something, and tapping it re-runs the
  // page's pull-to-refresh. The text re-renders on a timer so "2 min ago"
  // keeps counting while the page sits open.
  // ====================================================================
  var Fresh = (function () {
    var last = null; // {state, at, path}
    var btn = null;

    function ago(at) {
      var s = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (s < 45) return "just now";
      var m = Math.round(s / 60);
      if (m < 60) return m + " min ago";
      var h = Math.round(m / 60);
      if (h < 24) return h + " h ago";
      var d = new Date(at);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    function ensure() {
      var host = document.querySelector(".topbar-left");
      if (!host) return null;
      if (btn && btn.isConnected && btn.parentNode === host) return btn;
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "data-fresh";
      btn.id = "data-fresh";
      btn.addEventListener("click", function () {
        if (document.documentElement.classList.contains("has-ptr") && window.PullRefresh) window.PullRefresh.trigger();
      });
      host.appendChild(btn);
      return btn;
    }
    function render() {
      var el = ensure();
      if (!el) return;
      // A label left over from the previous page (SPA navigation) would be a lie here.
      if (!last || last.path !== location.pathname) { el.hidden = true; return; }
      el.hidden = false;
      var when = ago(last.at);
      var text, cls;
      if (last.state === "offline") { text = "Offline \u00b7 data from " + when; cls = "offline"; }
      else if (last.state === "cached") { text = "Updated " + when + " \u00b7 refreshing\u2026"; cls = "cached"; }
      else { text = "Updated " + when; cls = "fresh"; }
      el.textContent = text;
      el.className = "data-fresh " + cls;
      el.setAttribute("aria-label", text + (document.documentElement.classList.contains("has-ptr") ? ". Tap to refresh." : ""));
    }
    window.addEventListener("tradelog:data", function (e) {
      var d = e.detail || {};
      // A snapshot announcement must not replace a fresher "fresh" stamp that raced ahead of it.
      if (d.state === "cached" && last && last.path === d.path && last.state !== "cached" && last.at >= d.at) return;
      last = { state: d.state, at: d.at || Date.now(), path: d.path || location.pathname };
      render();
    });
    window.addEventListener("online", function () { if (last && last.state === "offline" && document.documentElement.classList.contains("has-ptr") && window.PullRefresh) window.PullRefresh.trigger(); });
    setInterval(render, 20000);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") render(); });
    return { render: render };
  })();
  window.DataFresh = Fresh;
})();
