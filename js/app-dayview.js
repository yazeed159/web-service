(function () {
  "use strict";

  // Day View tab of index.html. Split out of the old app.js -- see the
  // big comment at the top of app-shared.js (loaded right before this
  // file on every navigation here) for how these files fit together.
  // Reads/writes shared trade data via `App.state`; registers its render
  // entry points on `App.tabs.dayview` so app-shared.js's fetch-then-
  // render pass can call them once data loads.

// escapeHtml() now in utils.js (loads first on every page).
// fmtMoney() now in utils.js (loads first on every page).
  // "$5.20", or an em dash when the price is missing/non-numeric. Prices
  // can come back null for a trade that has no fill price recorded, and
  // null.toFixed() used to throw here -- which aborted the whole day-detail
  // render, leaving the panel open with a title but no trades in it.
  function fmtPrice(v) {
    if (v == null || v === "" || !Number.isFinite(Number(v))) return "\u2014";
    return "$" + Number(v).toFixed(2);
  }
  // ¢/share = the raw price move, not a commission figure -- entry $8.33
  // -> exit $8.45 is +12.0¢/share no matter what commission did to the
  // dollar P&L. Short trades invert the sign (a lower exit is the win).
  // (This used to be named/implemented as commission-per-share, which is
  // a completely different number and not what the "C/Share" column is
  // supposed to show -- see commPerShare below, now unused by that
  // column.)
  function pricePerShareMove(entryPrice, exitPrice, side) {
    if (entryPrice == null || exitPrice == null) return `<span class="dim">—</span>`;
    const dir = String(side || "").toLowerCase() === "short" ? -1 : 1;
    const cents = dir * (exitPrice - entryPrice) * 100;
    const neg = cents < 0;
    const text = (neg ? "-" : "+") + Math.abs(cents).toFixed(1) + "¢";
    return `<span class="${neg ? "down" : "up"}">${text}</span>`;
  }
  // Commission per share, in cents -- e.g. $12 comm on 200 shares is 6.0¢/share.
  // Commission can go negative (rebates), so this renders a signed value,
  // colored red when negative and green otherwise.
  function commPerShare(commission, shares) {
    if (!shares) return `<span class="dim">—</span>`;
    const cents = (commission / shares) * 100;
    const neg = cents < 0;
    const text = (neg ? "-" : "") + Math.abs(cents).toFixed(1) + "¢";
    return `<span class="${neg ? "down" : "up"}">${text}</span>`;
  }
  function renderCalendar() {
    const map = App.pnlByDay();
    const y = App.state.calYear, m = App.state.calMonth;
    document.getElementById("cal-month-label").textContent = `${App.MONTHS[m]} ${y}`;

    const daysInMonth = new Date(y, m + 1, 0).getDate();

    let monthNet = 0, monthGross = 0, monthComm = 0, winDays = 0, lossDays = 0, tradingDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const entry = map.get(App.dateKey(y, m, d));
      if (entry) {
        monthNet += entry.net;
        monthGross += entry.gross;
        monthComm += entry.comm;
        tradingDays++;
        if (entry.net >= 0) winDays++; else lossDays++;
      }
    }

    document.getElementById("cal-summary-strip").innerHTML = `
      <div class="cal-summary-cells">
        <div class="cell"><div class="label">Month P&amp;L</div><div class="value ${monthNet >= 0 ? "up" : "down"}">${fmtMoney(monthNet)}</div></div>
        <div class="cell"><div class="label">Trading days</div><div class="value">${tradingDays}</div></div>
        <div class="cell"><div class="label">Win days</div><div class="value up">${winDays}</div></div>
        <div class="cell"><div class="label">Loss days</div><div class="value down">${lossDays}</div></div>
        <div class="cell"><div class="label">Gross P&amp;L</div><div class="value ${monthGross >= 0 ? "up" : "down"}">${fmtMoney(monthGross)}</div></div>
      </div>
      <div class="cal-summary-comm">Commission this month: $${monthComm.toFixed(2)}</div>
    `;

    document.getElementById("cal-grid").innerHTML = App.buildMonthGridHtml(y, m, { clickable: true, selectedDay: App.state.selectedDay });

    document.querySelectorAll("#cal-grid .cal-cell.has-trades").forEach((cell) => {
      cell.addEventListener("click", () => {
        const key = cell.dataset.day;
        App.state.selectedDay = App.state.selectedDay === key ? null : key;
        NavState.set({ day: App.state.selectedDay });
        renderCalendar();
        if (App.state.selectedDay) showDayDetail(App.state.selectedDay, map.get(App.state.selectedDay));
        else document.getElementById("day-detail-panel").style.display = "none";
      }, { signal: App.signal });
    });
  }
  function showDayDetail(key, entry) {
    const panel = document.getElementById("day-detail-panel");
    panel.classList.remove("hidden"); panel.style.display = "block";
    const dateLabel = new Date(key + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    document.getElementById("day-detail-title").textContent = `${dateLabel} — ${fmtMoney(entry.net)} · ${entry.count} trade${entry.count === 1 ? "" : "s"} · Gross ${fmtMoney(entry.gross)} · Comm $${entry.comm.toFixed(2)}`;
    const sorted = entry.trades.slice().sort((a, b) => String(a.entry_time || "").localeCompare(String(b.entry_time || "")));
    const rowHtml = (t) => `
      <tr data-id="${escapeHtml(t.id)}">
        <td class="sym"><span class="side-dot" style="background:${t.win ? "var(--green)" : "var(--red)"}"></span>${escapeHtml(t.symbol)}</td>
        <td class="mono">${fmtPrice(t.entry_price)} → ${fmtPrice(t.exit_price)}</td>
        <td class="mono">${pricePerShareMove(t.entry_price, t.exit_price, t.side)}</td>
        <td class="mono dim">${escapeHtml(t.shares == null ? "\u2014" : t.shares)}</td>
        <td class="mono dim">${App.fmtDurationPrecise(App.durationMinutes(t))}</td>
        <td class="mono ${t.pnl_before_comm >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_before_comm)}</td>
        <td class="mono dim">$${(Number(t.commission) || 0).toFixed(2)}</td>
        <td><span class="pnl-tag ${t.win ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></td>
        <td class="mono dim">${escapeHtml(t.entry_time || "\u2014")} → ${escapeHtml(t.exit_time || "\u2014")}</td>
      </tr>`;
    // Render each trade on its own so one malformed trade degrades to a
    // plain (still clickable) row instead of taking down the whole table.
    const rows = sorted.map((t) => {
      try {
        return rowHtml(t);
      } catch (err) {
        console.error("[dayview] couldn't render trade", t && t.id, err);
        return `<tr data-id="${escapeHtml(t && t.id)}"><td class="sym">${escapeHtml(t && t.symbol)}</td><td class="dim" colspan="8">Couldn't display this trade's details — click to open it.</td></tr>`;
      }
    }).join("");
    const body = document.getElementById("day-detail-body");
    body.innerHTML = `<div class="table-scroll"><table class="trade-table"><thead><tr><th>Symbol</th><th>Price</th><th>C/Share</th><th>Shares</th><th>Hold</th><th>Gross</th><th>Comm</th><th>Net P&amp;L</th><th>Entry/Exit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    App.bindTradeRows(body);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  document.getElementById("day-detail-close").addEventListener("click", () => {
    App.state.selectedDay = null;
    NavState.set({ day: null });
    document.getElementById("day-detail-panel").style.display = "none";
    renderCalendar();
  }, { signal: App.signal });
  document.getElementById("cal-prev").addEventListener("click", () => {
    App.state.calMonth--; if (App.state.calMonth < 0) { App.state.calMonth = 11; App.state.calYear--; }
    App.state.selectedDay = null;
    NavState.set({ cy: App.state.calYear, cm: App.state.calMonth, day: null });
    document.getElementById("day-detail-panel").style.display = "none";
    renderCalendar();
  }, { signal: App.signal });
  document.getElementById("cal-next").addEventListener("click", () => {
    App.state.calMonth++; if (App.state.calMonth > 11) { App.state.calMonth = 0; App.state.calYear++; }
    App.state.selectedDay = null;
    NavState.set({ cy: App.state.calYear, cm: App.state.calMonth, day: null });
    document.getElementById("day-detail-panel").style.display = "none";
    renderCalendar();
  }, { signal: App.signal });

  // Swipe left/right on the calendar grid to move a month, same as
  // tapping the prev/next arrows -- the buttons stay the source of
  // truth for the actual navigation (this just clicks them), so paging
  // logic never has to live in two places. A tap/click on a day cell
  // is unaffected: bindSwipe only fires once horizontal travel clears
  // its threshold, well past what a tap moves.
  window.bindSwipe(document.getElementById("cal-grid"), {
    signal: App.signal,
    onSwipeLeft: () => document.getElementById("cal-next").click(),
    onSwipeRight: () => document.getElementById("cal-prev").click(),
  });

  App.tabs.dayview.renderCalendar = renderCalendar;
  App.tabs.dayview.showDayDetail = showDayDetail;
})();
