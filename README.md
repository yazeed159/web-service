# trade.log — trading journal dashboard

A TradeZella-style trading journal. Static frontend (HTML/CSS/vanilla JS,
no build step) deployed on **Cloudflare Pages**, backed by **Supabase**
(auth + database, via Row Level Security) and a small Python/Flask API
(`chart_service.py`, in the companion `chart-service` repo) deployed on
**Render**. A daily GitHub Actions cron kicks off the IBKR sync.

> This project used to be a single-user, no-backend static site (read
> `data/trades.json` off disk, AI features wired through n8n webhooks).
> It has since been migrated to the multi-user/Supabase/Render setup
> described below — see "History" at the bottom if you're looking for
> the old architecture.

## Stack

| Layer | What | Where |
|---|---|---|
| Frontend | Static HTML/CSS/JS, one page per section, shared `common.css` + `common.js` shell | Cloudflare Pages |
| Auth + data | Supabase (`trades`, `trade_details`, `broker_accounts`, `backtest_runs` tables, `user_kv` for settings), Row Level Security scopes every query to `auth.uid()` | Supabase |
| AI / heavy compute | Flask API — chart generation, vision-LLM verdicts, backtesting, support/resistance, chat, CSV import | Render (`chart-service` repo) |
| Daily sync | Pulls the day's IBKR Flex report, matches fills, generates charts, gets an AI verdict, publishes to Supabase | GitHub Actions cron → `POST /daily-sync` on Render |

Pages live at the project root; shared JS lives in `js/` and shared CSS in
`css/` (e.g. `js/config.js`, `css/common.css`).

Every page loads, in this order: `js/config.js` (sets `window.SUPABASE_URL` /
`SUPABASE_ANON_KEY` and the Render API base URL) → the Supabase JS CDN
script → `js/auth.js` (resolves the session, exposes `window.fetchTradesIndex()`
/ `window.fetchTradeDetail()` / etc., and redirects to `login.html` if
there's no session) → the page's own script.

## Pages

**Main nav (all present in every page's sidebar):**

- **`index.html`** — Dashboard / Day View / Reports tabs (hash-routed, one page)
- **`journal.html`** — full trade log, filterable/sortable, deep-linkable via `?setup=`
- **`stats.html`** ("Performance") — equity curve, win rate, setup breakdown, slippage, feedback tally
- **`edge-analysis.html`** — deeper statistical breakdown of what's actually working: setup decay, volume/float tags, confidence ranges (t-test + bootstrap), regret curve, MAE/MFE with stop/target sweeps, position sizing, and a trade-shuffle simulation of losing streaks and drawdown. The bar-level sections (regret + MAE/MFE) share one on-demand run over the most recent 100 trades. Pure math lives in `js/edge-stats.js` (unit-tested: `npm run test:unit`).
- **`patterns.html`** — recurring `lesson_tags` clustered by frequency
- **`calculator.html`** — position-size / risk-per-trade calculator
- **`backtester.html`** — ORB/gap-gainer strategy backtester against real Polygon minute bars
- **`rewind.html`** — chart-reading practice replaying your own logged trades, not graded
- **`practice.html`** — paper-trade a logged chart bar-by-bar; its Analytics tab used to be `practice-analytics.html`
- **`daily.html`** — daily plan (max loss, goal, checklist) and end-of-day review, plus a weekly table and discipline score
- **`accounts.html`** ("Trading accounts") — real accounts, deposits/withdrawals, **periods**, and paper-trading attempts (see "Accounts, periods & paper attempts" below)

- **`settings.html`** — capital ledger (deposits/withdrawals), account prefs

**Per-trade / support:**
- **`trade.html?id=<trade_id>`** — full trade detail: interactive candlestick chart, AI verdict, Support/Resistance (on-demand), star grade, and your own journal card (planned stop/target, setup, mistakes, rules followed, notes)
- **`import-trades.html`** — CSV import of new trades
- **`login.html`** — Supabase email/password sign-in; `auth.js` redirects here on any page when there's no session

**Redirect stubs** (old standalone pages, features moved elsewhere; each just bounces to the new location so old bookmarks/links don't 404):
- `notes.html` → `journal.html` (Notes Search is now the search icon / `/` shortcut in every topbar)
- `chat.html` → `index.html` (AI Chat is now the floating chat bubble on every page)
- `practice-analytics.html` → `practice.html?tab=analytics`
- `playbooks.html` → `stats.html` (the per-setup scorecard it showed is now part of Performance's setup breakdown)

## Shared assets

All shared/page JS lives in `js/`, all shared/page CSS lives in `css/`;
pages themselves (`index.html`, `journal.html`, etc.) stay at the project
root so existing links between pages don't need `js/`/`css/` prefixes.

- **`css/common.css`** — design tokens + app-shell/sidebar layout + additive feature styles (including the floating AI Chat launcher/panel), loaded by every page. Consolidation of what used to be separate `core.css` / `chat-widget.css` / `global-search.css` files.
- Page-specific CSS loaded only where needed: `css/dashboard.css` (Dashboard tab), `css/rewind.css`, `css/practice.css`, `css/quiz-shared.css`, `css/report.css`, `css/ui-modal.css` (shared modal widget, loaded everywhere). Backtester/report-only styles (previously `css/polish.css`) now live in a scoped section at the end of `css/common.css`.
- **`js/common.js`** — shared sidebar (main-nav + "More" section, both generated from a single item list — see `SIDEBAR_MAIN_ITEMS` / `SIDEBAR_MORE_ITEMS`) + mobile-nav wiring + the floating AI Chat widget + `NavState` (mirrors in-page UI state into the URL via `history.replaceState` so Back doesn't lose your place — every page here is a real navigation, not an SPA route). Consolidation of what used to be separate `nav.js` / `chat-widget.js` files.
- **`js/auth.js`** — session/auth layer + `window.KV` (a small per-user key/value store backed by Supabase, used for things like Settings' capital ledger) + `window.fetchTradesIndex()` / `window.fetchTradeDetail()`. Falls back to rejected-promise stubs instead of throwing if the Supabase CDN script fails to load, so a blocked/slow CDN request degrades to an error message instead of a blank broken page.
- **`js/config.js`** — the only file you should need to touch per-deployment: Supabase project URL/anon key, and the Render API base URL used for chart generation, backtesting, AI chat, and Support/Resistance.

## Config

Set in `js/config.js`:

```js
window.SUPABASE_URL = "https://<project>.supabase.co";
window.SUPABASE_ANON_KEY = "<anon key>";       // safe to expose — RLS scopes everything to auth.uid()
window.CHART_SERVICE_URL = "https://<your-render-service>.onrender.com";
window.N8N_SR_URL = "<render>/support-resistance";
window.N8N_CHAT_URL = "<render>/trade-chat";
window.N8N_BACKTEST_AI_URL = "<render>/backtest-ai";
window.N8N_BACKTEST_IMPORT_URL = "<render>/backtest-import";
```

(The `N8N_*` names are historical — these all point straight at the Render
API now, not n8n. See the companion `chart-service` repo's README for what
each route does.)

## Running locally

Browsers block `fetch()` against `file://` URLs, so don't just double-click
`index.html`. Serve the folder instead:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

You'll need a real Supabase project (with the schema the backend expects —
see the `chart-service` README) and to be logged in via `login.html`
before any page will show data.

## AI features (all now hosted on Render, see `chart-service` repo)

- **Support & Resistance** (on `trade.html`) — off by default, on-demand per click
- **AI Chat** — floating bubble on every page, reads your trade history + optionally one trade's live indicators
- **Backtester** — `POST /backtest/start` + poll `/backtest/status/<job_id>`; "Configure with AI" panel drives it conversationally; "Send to Journal" posts results through the same AI-verdict pipeline as real trades, into that run's own isolated report (never your real journal)

## History

Earlier version of this project was a fully static, single-user,
no-backend site: `data/trades.json` + `data/trades/<id>.json` published by
hand, and the AI features (Support/Resistance, Chat, Backtest config)
wired to n8n webhooks calling Gemini, with a local `chart_service.py` run
via `start_chart_service.ps1` + ngrok for the backtester. That's all been
replaced by the Supabase + Render setup above — n8n is no longer part of
this project. (The one-time `import-legacy.html` tool that moved data
from that era into Supabase has since been removed, now that every
account's history is confirmed migrated.)

## Phone navigation (<=760px)

Built in `js/nav-render.js` (+ `js/global-search.js`, styles at the end of `css/common.css`). None of it shows on desktop.

- **Editable tab bar** -- the bar is four pages of your choosing, a centre "+" quick note, Search, and More. Press and hold any tab, or use "Customize tab bar" at the foot of the drawer, to pick four pages (the order you tap them is the order on the bar; Reset restores Home / Journal / Daily / Practice). Stored per device in `localStorage["trade.log:bottom-tabs"]`. The choices come from the sidebar item lists, so a page added there is selectable automatically; long names get a short form on the bar via `BAR_SHORT`.
- **Search in the bar** -- the top-right search icon is hidden on phones. The Search tab opens the same control (`window.GlobalSearch.open/close/toggle`) as a sheet docked to the bottom edge and lifted above the keyboard. While open it is moved to `<body>`, because the topbar's `backdrop-filter` would otherwise make it the containing block for `position: fixed`.
- **Recent pages** -- the last pages visited (`localStorage["trade.log:recent-pages"]`) are listed above the drawer's scrolling list. Pages that already have a tab, and the page you are on, are left out.

## Installable app + seamless page transitions

The site is an installable PWA and is meant to be wrapped as an Android APK
(PWABuilder / Bubblewrap TWA, or Capacitor pointed at the live URL).

- `manifest.json` + `icons/` -- app name, icons, standalone display, theme colour.
- `sw.js` -- service worker. Pre-caches the whole shell on install and serves
  same-origin files (and the supabase-js / lightweight-charts CDN scripts)
  stale-while-revalidate, so page loads come from the device. API calls
  (Supabase, Render, the live-trading tunnel) are never intercepted. A deploy
  shows up one navigation later; bump `CACHE_VERSION` in `sw.js` to force a
  full purge. If you add a page/CSS/JS file, add it to `SHELL` in `sw.js` so
  it is pre-cached (it still works if you forget -- it just caches on first use).
- `js/pwa-register.js` -- registers the service worker; loaded from every page's `<head>`.
- **View transitions** -- `css/common.css` opts every page into cross-document
  view transitions (`@view-transition`), so a normal page load cross-fades from
  the old page instead of flashing a loader; the desktop sidebar is pinned so
  it never animates. `js/page-transition.js` skips the loader overlay when the
  browser supports this (Chrome / Android WebView 126+) and wraps the in-place
  SPA swaps in `document.startViewTransition()`. Browsers without support, or
  with `prefers-reduced-motion`, keep the original loader-overlay behaviour.
- `<link rel="expect" href="#page-title" blocking="render">` in each page's
  `<head>` holds the first paint until the sidebar + topbar exist, so the new
  page never appears half-built inside a transition.


## Reliability notes
- `js/auth.js` retries transient data failures (network blips, 5xx/429, expired JWT with a session refresh, clock skew, hung requests) before any page sees an error; the dashboard/reports page then shows a banner with a Retry button and retries on its own (backoff, `online`, tab refocus).
- `supabase-js` and `lightweight-charts` are self-hosted in `js/vendor/` (no CDN dependency). Bump `CACHE_VERSION` in `sw.js` when you update them.
- `tests/browser-harness/flaky_test.py` injects failures against the real pages.

## Accounts, periods & paper attempts

Run `001_accounts.sql` (shipped alongside this repo, not inside it) once in the
Supabase SQL editor. Until it runs, the site behaves exactly as before.

- **Accounts** (`accounts` table): `kind = 'live'` for real accounts, `'paper'` for
  practice attempts. `trades.account_id` says which real account a trade belongs to;
  `broker_accounts.account_id` says which account the daily IBKR sync feeds.
- **Scope**: `js/accounts.js` (loaded right after `auth.js` everywhere) wraps
  `fetchTradesIndex()` / `fetchCapitalLedger()` so every page automatically shows only
  the accounts (and optional period) picked in the top-bar switcher. `equity_after` is
  recomputed over the filtered set. `fetchTradesIndexRaw()` is the unfiltered version
  (used by Practice/Rewind/search so their chart pool doesn't shrink).
- **Periods**: not a table. A period starts at a capital-ledger entry with
  `period: true` (deposits default to starting one unless `period: false`) and runs
  until the next one. Name/reflection live on that same ledger entry in `user_kv`.
- **Paper attempts**: one `accounts` row each; fills in `user_kv` key
  `practice:account:v3:<id>`. "Reset" on the Practice tab archives the old attempt and
  starts a new one. The old `practice:account:v2` slot is migrated into "Attempt 1" on
  first load (and left untouched as a backup).
- Backend (`chart-service`): `/import-trades` accepts an optional `account_id` form
  field (validated against the caller); `publish.py` recomputes `equity_after` per
  account.

## Phone daily-use features

- **`js/mobile-extras.js`** (loaded on every app page): quick-note sheet (`QuickAdd`, opened by the bottom-nav "+", the `?quick=trade|note` home-screen shortcuts, and Journal swipes), pull-to-refresh (`PullRefresh.set(fn)` — dashboard + Journal opt in), scroll memory (`ScrollMemory`), and Journal card swipe gestures (left: Tag/Delete, right: Note).
- **`js/today-strip.js`**: the dashboard "Today" card (Today / Yesterday / This week / Last week).
- Quick day notes are stored in `DailyNotes` as `thoughts: [{t, text}]` and listed on `daily.html`.
- Trades are not created by hand in the app (they come from the IBKR sync / CSV import), so "log a trade" = a note/tags on a trade.

## Phone helpers (PWA)

- **Share a CSV into the app** -- `manifest.json` declares a `share_target`; `sw.js` answers the POST to `/share-target`, parks the file in the `tradelog-share` cache and redirects to `import-trades.html?shared=1`, which loads it into the file field (you still tap Import). Android Chrome only, and only once the app is installed.
- **Keypads** -- `js/mobile-extras.js` gives every `type="number"` field with `min >= 0` a numeric (whole numbers) or decimal keypad automatically; the calculator's text price fields set `inputmode` by hand.
- **Skeletons** -- `.skel-cards` / `.skel-stack` placeholders (css/common.css) on Journal, Patterns, Performance and Edge Analysis.
- **Offline** -- `TradeCache` + `swrFetch` (js/auth.js) keep the last loaded trades on the device; Journal falls back to them and shows "Offline - data from ...".
- **Haptics** -- `Haptics.play("tap"|"select"|"success"|"warn"|"buy"|"sell")` or `data-haptic="..."` on a button. Off switch: `localStorage["trade.log:haptics"] = "off"`.

## Phone charts & Practice (portrait + landscape)

- **Chart gestures** (`touchChartOpts()` / `buildStandardChart()` in `js/chart-indicators.js`, rules at `.chart-touch*` in `css/common.css`). Every price chart on a phone: pinch zooms, horizontal drag pans, a long press (~0.25 s) drops the crosshair and dragging moves it; lifting your finger clears it (so the OHLC/indicator readout never freezes). The browser's long-press menu is suppressed on the chart. Trade/Report charts still hand a *vertical* swipe back to the page; **Practice** passes `touchMode: "capture"`, so one finger owns the chart (`touch-action: none`) and the page doesn't scroll under it -- scroll from the transport row or anywhere outside the chart.
- **Landscape charts**: "phone" now also means a short touch screen (`(orientation: landscape) and (max-height: 500px) and (pointer: coarse)`), so the fullscreen / zoom buttons show sideways too. Turning the phone to landscape while a Trade/Report chart is on screen opens it fullscreen; turning back closes it (only if the rotation opened it).
- **Practice order dock** (`js/practice-mobile.js`, styles at the end of `css/practice.css`). On phones the order ticket is re-parented into a body-level `#pp-dock`: your shortcut buttons (key badges hidden -- no keyboard) and big BUY / SELL stay pinned above the tab bar; tap the price/size handle (or the dim background) to slide the full ticket up -- size, % presets, position, fills, the shortcuts gear. Order feedback floats above the dock so buttons never shift under your thumb. On desktop widths nothing changes and the ticket goes back to its column.
- **Practice landscape**: `html.pp-landscape` makes the play screen full-screen -- slim header, chart filling the middle, transport row, and the dock as one strip (size - shortcuts - BUY - SELL) with the same slide-up sheet. `practice.js` only calls `PracticeMobile.sync()` / `onChartBuilt()` and tags the chart handle as `window.__ppChart`; all order logic is unchanged.

## Phone daily-use: shortcut icons & resume-last-view

- **Home-screen shortcuts** now have icons (`icons/shortcut-*.png`, 96x96, declared per shortcut in `manifest.json`): long-press the installed app for Trade note, Day note, Journal, Daily plan. Android launchers show only the first four, so keep the best four first. After changing the manifest, reinstall the app (or clear its data) -- Android caches shortcuts at install time.
- **Resume your last view** (`journal.html`, phones only): opening a bare Journal from the tab bar while a filtered/sorted view from earlier in the session exists (`sessionStorage["tl:journal:url"]`, under 6 h old) shows a chip at the top. Tap it to restore the filters, sort, depth and scroll; tap the x or change any filter to dismiss. It never auto-applies, so a fresh visit can't hide trades by surprise. Back from a trade still restores everything with no chip, as before.


## Chart fullscreen + drawing tools

- **Fullscreen** (`attachFullscreen()` in `js/chart-indicators.js`): the expand button (top-right of every price chart built by `buildStandardChart()` -- Trade, Report, Practice, Rewind) now shows on desktop as well as phones. `Esc` closes it.
- **Drawing tools** (`js/chart-draw.js`, toolbar down the left edge while fullscreen): horizontal line (support / resistance, with a price tag), trend line, ray, zone (rectangle), fib retracement, measure (price / % / bars / time, not saved) and text note. Also: colour picker, snap-to-candle (magnet), stay-in-tool, undo (Ctrl+Z), delete (Del), clear all. Click-click or press-drag-release to draw; in Select mode click a drawing to move it, drag its dots to reshape it. `Esc` backs out of a tool / selection first, then closes fullscreen.
- Drawings render through a lightweight-charts series primitive (follows pan / zoom / resize automatically) and are stored as `{t, p}` (time + price), so they carry across the 1m / 5m / 15m / 1h switcher. Trade and Report save them in `localStorage` under `trade.log:draw:v1:<SYMBOL>:<date>` (same key on both pages); Practice / Rewind keep them for the session only so a replay never shows lines from an earlier round. Pass `drawKey` to `buildStandardChart()` to persist elsewhere, or `fullscreen: false` to turn the whole thing off for a chart.
