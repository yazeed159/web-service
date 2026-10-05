// today-strip.js -- the card at the very top of the dashboard.
//
// What you open the app for on a phone: how's the day going, am I inside my
// own limits, did I do the pre-market checklist. One card, four lenses:
//   Today | Yesterday (the previous trading day: "Fri" on a Monday) | This week | Last week
//
// Day lenses show net P&L, a cumulative-P&L sparkline, trade count / W-L / win%,
// how many trades are journaled, a max-loss meter (worst intraday drawdown vs.
// your plan) and a goal meter, plus -- for today -- a tappable pre-market
// checklist and a "you're at your limit" banner. Week lenses show a bar per day
// and how well the plan held (max loss held, plan followed, days planned).
// Every figure is computed from data already on the page (App.state.trades,
// DailyNotes, TradeNotes); nothing new is stored except the last-picked lens.
(function () {
  "use strict";
  const App = window.App;
  const mount = document.getElementById("today-strip");
  if (!App || !App.tabs || !mount) return;

  const TAB_KEY = "trade.log:today_tab";
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s));
  const money = (v) => (window.fmtMoney ? window.fmtMoney(v) : (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2));
  const plain = (v) => "$" + Math.abs(v).toFixed(0);

  // ---- dates (local calendar, same convention as daily.html) ----
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const dow = (s) => parse(s).getDay();
  const isWeekend = (s) => dow(s) === 0 || dow(s) === 6;
  const mondayOf = (s) => addDays(s, -((dow(s) + 6) % 7));
  const pretty = (s) => { const d = parse(s); return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; };
  function prevTradingDay(s) {
    let p = addDays(s, -1);
    while (isWeekend(p)) p = addDays(p, -1);
    return p;
  }

  let tab = null;
  try { tab = localStorage.getItem(TAB_KEY); } catch (e) { /* ignore */ }
  let checklistOpen = null; // null = auto (open while items remain), else the person's choice

  function periodOf(id, today) {
    if (id === "prev") {
      const p = prevTradingDay(today);
      return { id, kind: "day", date: p, from: p, to: p, tab: p === addDays(today, -1) ? "Yesterday" : DOW[dow(p)] };
    }
    if (id === "week") {
      const m = mondayOf(today);
      return { id, kind: "week", from: m, to: addDays(m, 4), tab: "This week" };
    }
    if (id === "lastweek") {
      const m = addDays(mondayOf(today), -7);
      return { id, kind: "week", from: m, to: addDays(m, 4), tab: "Last week" };
    }
    return { id: "today", kind: "day", date: today, from: today, to: today, tab: "Today" };
  }

  // ---- numbers ----
  const pnlOf = (t) => (typeof t.pnl_after_comm === "number" ? t.pnl_after_comm : 0);
  const byTime = (a, b) => (a.trade_date + (a.entry_time || "")).localeCompare(b.trade_date + (b.entry_time || ""));
  function entriesMap() { return window.TradeNotes ? window.TradeNotes.all() : {}; }

  function summarize(rows) {
    const list = rows.slice().sort(byTime);
    const entries = entriesMap();
    let net = 0, wins = 0, low = 0, cum = 0, journaled = 0, broke = 0;
    const pts = [0];
    list.forEach((t) => {
      const p = pnlOf(t);
      net += p; cum += p; pts.push(cum);
      if (cum < low) low = cum;
      if (p > 0 || (t.win && p >= 0)) wins++;
      const e = entries[t.id];
      if (e) { journaled++; if (e.followed_rules === false) broke++; }
    });
    return { list, n: list.length, net, wins, losses: list.length - wins, winRate: list.length ? Math.round((wins / list.length) * 100) : 0, low, pts, journaled, broke };
  }
  function tradesBetween(from, to) {
    return App.state.trades.filter((t) => t.trade_date >= from && t.trade_date <= to);
  }
  // Typical net for the same lens, from the stretch just before it.
  function baseline(period) {
    const byKey = new Map();
    App.state.trades.forEach((t) => {
      if (t.trade_date >= period.from) return;
      const key = period.kind === "week" ? mondayOf(t.trade_date) : t.trade_date;
      byKey.set(key, (byKey.get(key) || 0) + pnlOf(t));
    });
    const keys = Array.from(byKey.keys()).sort().slice(period.kind === "week" ? -8 : -20);
    if (keys.length < 3) return null;
    return keys.reduce((s, k) => s + byKey.get(k), 0) / keys.length;
  }

  // ---- little graphics ----
  function sparkline(pts) {
    const W = 132, H = 48, P = 4;
    if (pts.length < 2) {
      return `<svg class="ts-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="${P}" x2="${W - P}" y1="${H / 2}" y2="${H / 2}" class="ts-zero"/></svg>`;
    }
    const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
    const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
    const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(pts.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;
    const up = pts[pts.length - 1] >= 0;
    const last = pts.length - 1;
    return `<svg class="ts-spark ${up ? "up" : "down"}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cumulative P&L through the day">
      <line x1="${P}" x2="${W - P}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="ts-zero"/>
      <path d="${area}" class="ts-area"/><path d="${line}" class="ts-line"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(pts[last]).toFixed(1)}" r="2.6" class="ts-dot"/></svg>`;
  }
  function dayBars(days, today) {
    const max = Math.max(1, ...days.map((d) => Math.abs(d.net)));
    return `<div class="ts-bars" role="img" aria-label="Net P&L per day">` + days.map((d) => {
      const h = d.n ? Math.max(6, Math.round((Math.abs(d.net) / max) * 100)) : 0;
      const cls = d.n ? (d.net >= 0 ? "up" : "down") : "";
      return `<div class="ts-bar-col${d.date === today ? " now" : ""}${d.date > today ? " future" : ""}" title="${esc(pretty(d.date))}: ${d.n ? esc(money(d.net)) : "no trades"}">
        <div class="ts-bar-up">${d.n && d.net >= 0 ? `<i class="${cls}" style="height:${h}%"></i>` : ""}</div>
        <div class="ts-bar-dn">${d.n && d.net < 0 ? `<i class="${cls}" style="height:${h}%"></i>` : ""}</div>
        <span>${DOW[dow(d.date)].charAt(0)}</span></div>`;
    }).join("") + `</div>`;
  }
  function meter(label, used, cap, text, kind) {
    const ratio = cap > 0 ? Math.max(0, used) / cap : 0;
    const tone = kind === "loss" ? (ratio >= 1 ? "bad" : ratio >= 0.6 ? "warn" : "ok") : (ratio >= 1 ? "hit" : "ok");
    return `<div class="ts-meter ${tone}"><div class="ts-meter-top"><span>${label}</span><b>${text}</b></div>
      <div class="ts-track"><i style="width:${Math.min(100, Math.round(ratio * 100))}%"></i></div></div>`;
  }

  // ---- render ----
  function render() {
    if (!mount.isConnected) return;
    const DN = window.DailyNotes;
    const today = iso(new Date());
    if (!tab) tab = isWeekend(today) ? "week" : "today";
    const periods = ["today", "prev", "week", "lastweek"].map((id) => periodOf(id, today));
    const p = periods.find((x) => x.id === tab) || periods[0];

    const rows = tradesBetween(p.from, p.to);
    const s = summarize(rows);
    const base = baseline(p);
    const delta = base !== null && s.n ? s.net - base : null;

    let hero, aside, chips = [], plan = "";

    if (p.kind === "day") {
      const day = (DN && DN.get(p.date)) || {};
      const isToday = p.id === "today";
      const sub = isToday && isWeekend(today)
        ? `${pretty(p.date)} · market closed`
        : `${pretty(p.date)}${s.n ? "" : isToday ? " · no trades yet" : " · no trades"}`;
      hero = { sub };
      aside = sparkline(s.pts);
      if (s.n) {
        chips.push(`${s.n} trade${s.n === 1 ? "" : "s"}`, `${s.wins}W · ${s.losses}L`, `${s.winRate}% win`);
        chips.push(`<span class="${s.journaled === s.n ? "ok" : ""}">Journaled ${s.journaled}/${s.n}</span>`);
        if (s.broke) chips.push(`<span class="bad">${s.broke} rule break${s.broke === 1 ? "" : "s"}</span>`);
      }
      const used = -s.low;
      const breached = day.max_loss != null && used >= day.max_loss;
      const goalHit = day.goal != null && s.net >= day.goal;
      if (isToday && s.n && breached) plan += `<div class="ts-banner bad">Max daily loss reached. Your plan says stop for the day.</div>`;
      else if (isToday && s.n && goalHit) plan += `<div class="ts-banner good">Daily goal reached. Your plan says you can stop.</div>`;
      if (day.max_loss != null) plan += meter("Max loss", used, day.max_loss, `${plain(used)} / ${plain(day.max_loss)}`, "loss");
      if (day.goal != null) plan += meter("Goal", Math.max(0, s.net), day.goal, `${plain(Math.max(0, s.net))} / ${plain(day.goal)}`, "goal");

      if (isToday && DN) {
        const list = DN.getChecklist();
        if (list.length) {
          const done = list.filter((it) => (day.checks || {})[it]).length;
          const open = checklistOpen === null ? done < list.length : checklistOpen;
          plan += `<details class="ts-check"${open ? " open" : ""}><summary><span>Pre-market checklist</span><b class="${done === list.length ? "ok" : ""}">${done === list.length ? "✓ " : ""}${done}/${list.length}</b></summary>` +
            list.map((it, i) => `<label class="ts-item"><input type="checkbox" data-i="${i}"${(day.checks || {})[it] ? " checked" : ""}><span>${esc(it)}</span></label>`).join("") + `</details>`;
        }
        if (day.max_loss == null && day.goal == null) {
          const last = DN.lastPlanned(today);
          plan += `<div class="ts-plan-cta"><a href="daily.html" class="ts-link">Set today's plan →</a>` +
            (last ? `<button type="button" class="ts-ghost" data-reuse>Reuse ${last.max_loss != null ? "max loss " + plain(last.max_loss) : ""}${last.max_loss != null && last.goal != null ? " · " : ""}${last.goal != null ? "goal " + plain(last.goal) : ""}</button>` : "") + `</div>`;
        }
      } else if (!isToday && DN) {
        const reviewed = day.followed_plan != null || (day.went_well_tags || []).length || (day.to_fix_tags || []).length;
        plan += reviewed
          ? `<div class="ts-review ok">Reviewed${day.followed_plan === true ? " · followed plan" : day.followed_plan === false ? " · didn't follow plan" : ""}</div>`
          : (s.n ? `<a class="ts-review todo" href="daily.html?date=${p.date}">Not reviewed yet. Review ${esc(p.tab === "Yesterday" ? "yesterday" : p.tab)} →</a>` : "");
      }
      const thoughts = (day.thoughts || []);
      if (thoughts.length) {
        const lastT = thoughts[thoughts.length - 1];
        const when = lastT.t ? new Date(lastT.t) : null;
        const hm = when && !isNaN(when) ? `${pad(when.getHours())}:${pad(when.getMinutes())} ` : "";
        plan += `<div class="ts-note"><span>${thoughts.length} note${thoughts.length === 1 ? "" : "s"}</span> ${esc(hm)}“${esc(lastT.text.length > 90 ? lastT.text.slice(0, 88) + "…" : lastT.text)}”</div>`;
      }
      const streak = DN ? DN.streak(isToday && !day.plan && !s.n ? addDays(today, -1) : p.date) : 0;
      if (streak > 1 && isToday) chips.push(`<span class="ok">🔥 ${streak}-day journal streak</span>`);
    } else {
      // week lenses
      const days = [];
      for (let i = 0; i < 5; i++) {
        const d = addDays(p.from, i);
        const r = tradesBetween(d, d);
        days.push({ date: d, n: r.length, net: r.reduce((a, t) => a + pnlOf(t), 0), low: summarize(r).low });
      }
      const traded = days.filter((d) => d.n);
      hero = { sub: `${pretty(p.from)} – ${pretty(p.to)}${traded.length ? "" : " · no trades"}` };
      aside = dayBars(days, today);
      if (s.n) {
        chips.push(`${s.n} trade${s.n === 1 ? "" : "s"} · ${traded.length} day${traded.length === 1 ? "" : "s"}`, `${s.wins}W · ${s.losses}L`, `${s.winRate}% win`);
        const best = traded.slice().sort((a, b) => b.net - a.net)[0];
        const worst = traded.slice().sort((a, b) => a.net - b.net)[0];
        if (best && best.net > 0) chips.push(`<span class="ok">Best ${DOW[dow(best.date)]} ${esc(money(best.net))}</span>`);
        if (worst && worst.net < 0) chips.push(`<span class="bad">Worst ${DOW[dow(worst.date)]} ${esc(money(worst.net))}</span>`);
        chips.push(`<span class="${s.journaled === s.n ? "ok" : ""}">Journaled ${s.journaled}/${s.n}</span>`);
      }
      if (DN && traded.length) {
        const notes = DN.allDays();
        const planned = traded.filter((d) => notes[d.date] && notes[d.date].max_loss != null);
        const held = planned.filter((d) => -d.low < notes[d.date].max_loss).length;
        const reviewed = traded.filter((d) => notes[d.date] && notes[d.date].followed_plan != null);
        const followed = reviewed.filter((d) => notes[d.date].followed_plan === true).length;
        const row = (label, ok, total) => total
          ? `<div class="ts-adh"><span>${label}</span><b class="${ok === total ? "ok" : ok < total / 2 ? "bad" : ""}">${ok}/${total}</b></div>` : "";
        plan += `<div class="ts-adh-wrap">` +
          row("Days with a max loss set", planned.length, traded.length) +
          row("Max loss held", held, planned.length) +
          row("Plan followed (reviewed days)", followed, reviewed.length) + `</div>`;
      }
    }

    const heroCls = s.n ? (s.net >= 0 ? "up" : "down") : "";
    const deltaChip = delta === null ? "" :
      `<span class="ts-delta ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${plain(delta)} vs avg ${p.kind === "week" ? "week" : "day"}</span>`;
    const lastTrade = s.list[s.list.length - 1] || App.state.trades[App.state.trades.length - 1];
    const planLink = p.kind === "day" ? `daily.html?date=${p.date}` : "daily.html";

    mount.innerHTML = `
      <div class="ts-card${s.n ? (s.net >= 0 ? " tone-up" : " tone-down") : ""}">
        <div class="ts-tabs" role="tablist" aria-label="Period">
          ${periods.map((x) => `<button type="button" role="tab" data-tab="${x.id}" aria-selected="${x.id === p.id}" class="${x.id === p.id ? "on" : ""}">${esc(x.tab)}</button>`).join("")}
        </div>
        <div class="ts-main">
          <div class="ts-left">
            <div class="ts-sub">${esc(hero.sub)}</div>
            <div class="ts-pnl ${heroCls}">${s.n ? esc(money(s.net)) : "$0.00"}</div>
            ${deltaChip}
          </div>
          <div class="ts-right">${aside}</div>
        </div>
        ${chips.length ? `<div class="ts-chips">${chips.map((c) => `<span class="ts-chip">${c}</span>`).join("")}</div>` : ""}
        ${plan ? `<div class="ts-plan">${plan}</div>` : ""}
        <div class="ts-actions">
          <button type="button" class="ts-btn primary" data-quick="${lastTrade ? esc(lastTrade.id) : ""}">＋ Note</button>
          <a class="ts-btn" href="${planLink}">${p.id === "today" ? "Daily plan" : p.kind === "day" ? "Daily review" : "Week review"} →</a>
        </div>
      </div>`;
  }

  // ---- interactions (delegated; this mount is replaced on every SPA visit) ----
  mount.addEventListener("click", (e) => {
    const t = e.target.closest("button[data-tab]");
    if (t) {
      tab = t.getAttribute("data-tab");
      try { localStorage.setItem(TAB_KEY, tab); } catch (err) { /* ignore */ }
      render();
      return;
    }
    const q = e.target.closest("button[data-quick]");
    if (q && window.QuickAdd) {
      const id = q.getAttribute("data-quick");
      window.QuickAdd.open({ mode: id ? "trade" : "day", tradeId: id || undefined });
      return;
    }
    if (e.target.closest("button[data-reuse]") && window.DailyNotes) {
      const today = iso(new Date());
      const last = window.DailyNotes.lastPlanned(today);
      if (last) window.DailyNotes.save(today, Object.assign({}, window.DailyNotes.get(today) || {}, { max_loss: last.max_loss, goal: last.goal }));
      render();
    }
  });
  mount.addEventListener("change", (e) => {
    const cb = e.target.closest(".ts-item input");
    if (!cb || !window.DailyNotes) return;
    const list = window.DailyNotes.getChecklist();
    window.DailyNotes.setCheck(iso(new Date()), list[Number(cb.getAttribute("data-i"))], cb.checked);
    render();
  });
  mount.addEventListener("toggle", (e) => {
    if (e.target.matches && e.target.matches("details.ts-check")) checklistOpen = e.target.open;
  }, true);

  // A note saved from the quick sheet / swipe changes "Journaled x/y" and the note line.
  const onSaved = () => { if (!mount.isConnected) { window.removeEventListener("tradelog:note-saved", onSaved); return; } render(); };
  window.addEventListener("tradelog:note-saved", onSaved);

  App.tabs.dashboard.renderToday = render;
  // Notes/plan sync down from the account a moment after load; redraw once they land.
  if (window.KV && window.KV.ready) window.KV.ready.then(() => { if (!App.signal.aborted) render(); });
})();
