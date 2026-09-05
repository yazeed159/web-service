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
| Frontend | Static HTML/CSS/JS, one page per section, shared `core.css` + `nav.js` shell | Cloudflare Pages |
| Auth + data | Supabase (`trades`, `trade_details`, `broker_accounts`, `backtest_runs` tables, `user_kv` for settings), Row Level Security scopes every query to `auth.uid()` | Supabase |
| AI / heavy compute | Flask API — chart generation, vision-LLM verdicts, backtesting, support/resistance, chat, CSV import | Render (`chart-service` repo) |
| Daily sync | Pulls the day's IBKR Flex report, matches fills, generates charts, gets an AI verdict, publishes to Supabase | GitHub Actions cron → `POST /daily-sync` on Render |

Every page loads, in this order: `config.js` (sets `window.SUPABASE_URL` /
`SUPABASE_ANON_KEY` and the Render API base URL) → the Supabase JS CDN
script → `auth.js` (resolves the session, exposes `window.fetchTradesIndex()`
/ `window.fetchTradeDetail()` / etc., and redirects to `login.html` if
there's no session) → the page's own script.

## Pages

**Main nav (all present in every page's sidebar):**

- **`index.html`** — Dashboard / Day View / Reports tabs (hash-routed, one page)
- **`journal.html`** — full trade log, filterable/sortable, deep-linkable via `?setup=`
- **`stats.html`** ("Performance") — equity curve, win rate, setup breakdown, slippage, feedback tally
- **`edge-analysis.html`** — deeper statistical breakdown of what's actually working
- **`patterns.html`** — recurring `lesson_tags` clustered by frequency
- **`quiz.html`** — chart-reading quiz built from your own logged trades, client-side only
- **`calculator.html`** — position-size / risk-per-trade calculator
- **`backtester.html`** — ORB/gap-gainer strategy backtester against real Polygon minute bars
- **`rewind.html`** — chart-reading practice replaying your own logged trades, not graded
- **`practice.html`** — paper-trade a logged chart bar-by-bar; its Analytics tab used to be `practice-analytics.html`
- **`settings.html`** — capital ledger (deposits/withdrawals), account prefs

**Per-trade / support:**
- **`trade.html?id=<trade_id>`** — full trade detail: interactive candlestick chart, AI verdict, Support/Resistance (on-demand), 👍/👎 feedback
- **`import-trades.html`** — CSV import of new trades
- **`import-legacy.html`** — **one-time** migration tool that backfills an old `data/trades.json` + `data/trades/*.json` export into Supabase (safe to re-run — it upserts). Not linked from any nav; keep the URL around only until you're sure everyone's data has been migrated, then it can go.
- **`login.html`** — Supabase email/password sign-in; `auth.js` redirects here on any page when there's no session

**Redirect stubs** (old standalone pages, features moved elsewhere; each just bounces to the new location so old bookmarks/links don't 404):
- `notes.html` → `journal.html` (Notes Search is now the search icon / `/` shortcut in every topbar)
- `chat.html` → `index.html` (AI Chat is now the floating chat bubble on every page)
- `practice-analytics.html` → `practice.html?tab=analytics`
- `playbooks.html` → `stats.html` (the per-setup scorecard it showed is now part of Performance's setup breakdown)

## Shared assets

- **`core.css`** — design tokens + app-shell/sidebar layout + additive feature styles, loaded by every page. (Consolidation of three older files — see "Known quirks.")
- Page-specific CSS loaded only where needed: `dashboard.css` (Dashboard tab), `rewind.css`, `practice.css`, `quiz.css` / `quiz-shared.css`, `report.css`, `polish.css` (backtester + report), `chat-widget.css` / `global-search.css` / `ui-modal.css` (shared widgets, loaded everywhere).
- **`nav.js`** — shared sidebar/mobile-nav wiring + `NavState` (mirrors in-page UI state into the URL via `history.replaceState` so Back doesn't lose your place — every page here is a real navigation, not an SPA route).
- **`auth.js`** — session/auth layer + `window.KV` (a small per-user key/value store backed by Supabase, used for things like Settings' capital ledger) + `window.fetchTradesIndex()` / `window.fetchTradeDetail()`. Falls back to rejected-promise stubs instead of throwing if the Supabase CDN script fails to load, so a blocked/slow CDN request degrades to an error message instead of a blank broken page.
- **`config.js`** — the only file you should need to touch per-deployment: Supabase project URL/anon key, and the Render API base URL used for chart generation, backtesting, AI chat, and Support/Resistance.

## Config

Set in `config.js`:

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

## Known quirks

- **Sidebar isn't templated.** Each page carries its own copy of the sidebar
  markup rather than generating it from one shared list, so it's possible
  for pages to drift out of sync with each other. Worth turning into a
  single source of truth (e.g. injected by `nav.js`) if more pages get added.
- **`calculator.html` and `edge-analysis.html`** don't have their own
  `.js` file like the rest of the site — their logic is inline in the
  page. Every other feature page follows the `page.html` + `page.js`
  pattern; these two are the exception.
- **`import-legacy.html`** is a one-time migration tool from the old
  static-JSON architecture. Once you're confident every account's history
  has been backfilled into Supabase, it can be deleted.

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
this project. `import-legacy.html` exists specifically to move data from
that era into Supabase.
