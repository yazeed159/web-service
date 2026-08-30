# trade.log — interactive trading journal dashboard

A static, TradeZella-style site that reads two kinds of JSON files and
renders a full sidebar app — no backend, no build step, no framework.
It's plain HTML/CSS/JS plus two charting/font CDN scripts, so it works
as-is on GitHub Pages (or any static host).

- **`index.html`** — a sidebar app shell with four tabs, all driven by
  `data/trades.json`:
  - **Dashboard** — stat cards (Net P&L, Trade Win %, Profit Factor, Day
    Win %, Avg Win/Loss), a Zella-Score-style gauge, a mini month
    calendar, the equity curve, and recent trades.
  - **Day View** — a full month calendar heatmap (green/red day cells
    with net P&L + trade count), month navigation, and a click-to-expand
    day detail panel.
  - **Trade View** — the original day-grouped trade table, searchable by
    symbol and filterable by win/loss.
  - **Reports** — win/loss streaks, best/worst trade, breakdowns by
    symbol (small-sample-size trades flagged with an `n=` pill), day-of-
    week, time-of-day session bucket, and trade duration; a most-traded /
    most-profitable symbol leaderboard; and a sector/country breakdown
    (see `sector`/`country` in the schema below — empty until the publish
    step copies those over).
- **`trade.html?id=<trade_id>`** — a per-trade page (same sidebar shell)
  with a gross/commission/net breakdown, a real interactive candlestick
  chart (zoom, pan, hover crosshair) built from that trade's actual OHLC
  bars, VWAP/EMA9/EMA20 overlays (plus dotted price lines for the LLM's
  suggested better entry/exit), a synced MACD panel, entry/exit
  markers, the LLM's verdict, a one-click "Copy" button on the verdict
  text, a "PNG" button that exports the chart's current zoom/pan view as
  a downloadable image, prev/next sibling navigation between trades, an
  "About `<symbol>`" card with float / 30-day avg volume / relative-volume
  pills alongside sector/country, a **Support & Resistance (AI)** box
  (off by default — see below), and inline 👍/👎 feedback buttons on each
  better-entry/exit call and lesson (stored in `localStorage`, per
  browser — not synced anywhere, just tallied on the Performance page).
- **`journal.html`** — the full trade log as one filterable, sortable
  table: symbol search, date range, entry time-of-day range, setup type,
  win/loss, relative volume, 30-day average volume, float, and a "has
  better entry/exit flagged" checkbox. Each row also shows the trade's
  rel-volume / avg-volume / float tags as color-coded pills in a Tags
  column. Deep-linkable from a Playbooks card via `?setup=<setup_type>`,
  which pre-selects that setup's filter. Same sidebar shell as the rest
  of the site.
- **`stats.html`** ("Performance" in the nav) — net P&L, win rate,
  avg win/loss, current/longest streaks, an interactive equity curve,
  win rate by setup, a "money left on the table" slippage estimate
  (comparing actual fills to the LLM's suggested better entry/exit) split
  by entry vs. exit, a cumulative slippage trend chart, a slippage-by-
  setup breakdown, and a local tally of the 👍/👎 feedback left on trade
  pages.
- **`patterns.html`** — clusters every trade's `lesson_tags` (e.g.
  `chased_extension`, `late_exit`) by frequency so a mistake repeated
  across many trades stands out, with an expandable list of the
  trades behind each tag.
- **`playbooks.html`** — one scorecard per `setup_type`: win rate, trade
  count (flagged if under 5), net P&L, average P&L per trade, and the
  most common `lesson_tags` entry logged against that setup. Click a
  card to jump to `journal.html` pre-filtered to just that setup.

## Volume / relative volume / float

`chart_service.py`'s `/generate-chart` now also computes, best-effort,
alongside the existing VWAP/EMA/MACD indicators:

- `volume_on_entry_day` — that trading day's total volume (not just the
  minute-window shown on the chart)
- `avg_volume_30d` — mean daily volume over the ~30 trading days strictly
  before the trade date
- `relative_volume` — `volume_on_entry_day / avg_volume_30d`
- `float_shares` — Polygon's `share_class_shares_outstanding`, a common
  proxy for float (not an exact tradable-float figure — see the caveat in
  `chart_service.py`'s docstring)
- `avg_volume_tag` / `rvol_tag` / `float_tag` — bucketed classifications of
  the three numbers above (see `classify_avg_volume` /
  `classify_relative_volume` / `classify_float` in `chart_service.py` for
  the exact thresholds)

These land in `indicators` on the trade detail JSON automatically (nothing
publish-side needs to change for that), and the three `*_tag` fields plus
`relative_volume` are additionally copied flat onto each `data/trades.json`
index row — same reasoning as `sector`/`country` above — so `journal.html`
can filter and show them as pills without fetching every detail file.
`trade.html`'s "About `<symbol>`" card reads the raw numbers straight off
`indicators`. Any of it can come back `null`/`"*_unknown"` if the extra
Polygon calls fail — the whole chart generation still succeeds either way.
Set `ENABLE_VOLUME_FLOAT_STATS=false` to skip these calls entirely.

## Support & Resistance (AI) — optional, on-demand

`trade.html` has a "Support & Resistance (AI)" box that's **off by
default**: nothing runs when the page loads. Clicking "Analyze
support/resistance" POSTs `{symbol, trade_date, lookback_days}` to an n8n
webhook (`SR_ANALYSIS_URL` at the top of `trade.js` — point it at your own
n8n instance the same way `#import-trades-link` in `trade.html` is pointed
at its form URL), which:

1. Calls `chart_service.py`'s new `POST /generate-daily-chart` endpoint,
   which fetches the symbol's daily bars for the `lookback_days` (default
   40) trading days **strictly before** `trade_date` (never the trade day
   itself — only what the trader could have actually seen going in), plus
   a cheap no-LLM pivot-cluster support/resistance guess computed straight
   from the bars (`computed_levels`).
2. Sends a compact text summary of those daily bars (dates + OHLCV, not an
   image) to Gemini, asking for up to 4 support and 4 resistance levels —
   text-only to keep each click's token cost small; the endpoint still
   returns a rendered daily chart image (`image_base64`) if you'd rather
   wire up a real vision read instead.
3. Falls back to the computed pivot levels if the LLM response doesn't
   parse.

The response draws solid dashed price lines directly on the trade's
existing interactive candlestick chart — green for support, red for
resistance — distinct from the entry/exit (solid dashed green/red) and
better-entry/exit (dotted purple/pink) lines already on it.

This is implemented as its own small n8n sub-workflow (`SR Webhook
Trigger` → `SR: Fetch Daily Chart` → `SR: Summarize Daily Bars` → `SR:
Vision LLM Analysis` → `SR: Parse Levels` → `SR: Respond`), completely
separate from the daily 8PM pipeline — reviewing or even publishing a
trade never triggers it. It only runs, and only spends a Polygon +
Gemini call, when you explicitly click the button on that trade's page.

The color system lives in `style.css` as CSS variables (`--primary` is
the indigo/violet accent, `--green`/`--red` are win/loss) — swap those to
retheme without touching any JS.

## Running it locally

Browsers block `fetch()` against `file://` URLs, so don't just double-click
`index.html`. Serve the folder instead:

```bash
cd dashboard
python3 -m http.server 8000
# open http://localhost:8000
```

## File layout

```
dashboard/
  index.html          home page (Dashboard / Day View / Trade View / Reports tabs)
  journal.html          filterable, sortable log of every trade
  stats.html             "Performance" — equity curve, setup win rates, slippage, feedback tally
  patterns.html           recurring lesson-tag clusters
  playbooks.html          per-setup_type scorecards, links into journal.html
  backtester.html         ORB / gap-gainer strategy backtester (see below)
  chat.html                AI Chat — ask questions about your trade history (see below)
  rewind.html              Rewind — chart-reading practice on your own logged trades (see below)
  trade.html              per-trade page (reads ?id=... from the URL)
  style.css               shared design tokens + app-shell/sidebar layout
  features.css              additive styles for journal/stats/patterns/playbooks/backtester/chat (filters, data table, bar rows, playbook cards, run cards, progress bar, chat bubbles)
  rewind.css                  additive styles for the Rewind tab
  app.js                  home page logic
  trade.js                  trade page + chart logic
  backtester.js            backtester tab logic (start job, poll status, render results/history)
  chat.js                  AI Chat tab logic (builds trade context, talks to the n8n chat webhook)
  rewind.js                Rewind tab logic (per-trade flow, chart cropping/markers, feedback, localStorage history)
  data/
    trades.json          index: one row per trade, feeds the home table and journal/stats/patterns/playbooks pages
    trades/<id>.json      full detail per trade, feeds trade.html
  n8n/
    chat-workflow.json    n8n workflow export backing the AI Chat tab (import into n8n, see below)
```

## Backtester tab

`backtester.html` runs an intraday gap-gainer breakout backtest against real
Polygon minute bars — pick an entry style (opening range breakout, break of
the previous red candle's high, Donchian breakout, inside-bar break, or VWAP
reclaim), a stop style (pattern-based, fixed cents/%, prior-bar low, or ATR
multiple), and stack any combination of profit exits (fixed R target, time
stop, trailing giveback in cents or % of gain, momentum-stall exit, plus an
optional breakeven ratchet on the stop). Hit **Run Backtest** and it scans
every trading day in the range for the top-N gappers, simulates the strategy
on each, and shows a stats row, an equity curve, and a sortable trade log.
Past runs are listed at the bottom — click one to reload its settings into
the form, or delete it.

Unlike the other tabs (which just read `data/*.json`), this one talks
**directly** to `chart_service.py` over HTTP — no n8n involved, since a
multi-day scan takes a while under Polygon's free-tier rate limit and needs
to be started then polled rather than answered in one request. It calls
these routes, added to `chart_service.py` alongside the existing
`/generate-chart` pipeline (implemented in `orb_strategy.py` / `engine.py` /
`polygon_client.py`, copied in next to it — same modules as the standalone
`orb-backtester-site` CLI tool, just wrapped in a JSON API instead of a
server-rendered form):

- `POST /backtest/start` — body is the form's config as JSON; returns `{job_id}`
- `GET /backtest/status/<job_id>` — `{status: "running", current, total, day}` while in progress, or `{status: "done", stats, trades}` / `{status: "error", error}` when finished
- `GET /backtest/history` — past runs (label, date range, summary stats) persisted to `backtest_history.json` next to `chart_service.py`
- `DELETE /backtest/history/<job_id>` — removes one past run
- `GET /backtest/defaults` — the strategy's default parameter values, so the form doesn't hardcode a second copy

**Setup:** point `window.CHART_SERVICE_URL` in `config.js` at whatever
ngrok prints when you run `start_chart_service.ps1` (same server the chart
pipeline uses — `POLYGON_API_KEY` just needs to already be set for it, which
it is if `/generate-chart` already works). Free-tier ngrok URLs change every
restart, so update that line each session. These four routes also add
permissive CORS headers (`Access-Control-Allow-Origin: *`) since, unlike
`/generate-chart`, they're called straight from the browser — that's scoped
to this local personal tool, not something to carry over if this backend
ever serves untrusted traffic.

`gen_sample_data.py` generated the sample data currently in `data/` (15
synthetic trades) so you can preview the site immediately. Delete
`data/trades.json` and `data/trades/*` and replace them with real output
once the pipeline is publishing.

## Rewind — real tick playback (optional)

`rewind.html`'s entry and mid-trade "watch it play out" moments normally
synthesize a plausible second-by-second path inside each 1-minute bar
(see the comment above `genSecondTicks` in `rewind.js`) — Polygon's minute
bars are all that's needed for the rest of the site, so there's no real
intra-bar data to draw on offline. The setup screen's **Tick playback**
picker adds a second option, **Real ticks (from server)**, that instead
asks `chart_service.py` for the actual trade prints in that window.
Simulated stays the default and always works with zero setup; Real is
opt-in per session and falls back to simulated automatically (per trade,
with a small note in the UI) if the server's unreachable or has no prints
for that window — it never blocks the session.

**Setup:** same `window.CHART_SERVICE_URL` in `config.js` the Backtester
tab uses, pointing at your `chart_service.py`, which now also serves:

- `POST /tick-data` — body `{ symbol, start, end }` (`start`/`end` are ISO
  8601 timestamps, start inclusive / end exclusive, capped to a 5-minute
  window); returns `{ ticks: [{ t, p }, ...] }` — real Polygon `v3/trades`
  prints, ordered oldest first. Always 200, `{ ticks: [] }` on no
  data/failure (logged server-side) rather than an error, since Rewind
  treats "nothing came back" and "couldn't reach the server" the same way
  (fall back to simulated). Same CORS, rate-limiter, and small
  process-lifetime cache as the rest of `chart_service.py`; `TICK_DATA_MAX_TRADES`
  (default 2000) caps how many prints one call can return for a busy
  ticker/minute.

## AI Chat tab

`chat.html` is a conversational interface for asking questions about your
trade history — win rates on specific setups, recurring mistakes, cost of
late exits, walkthroughs of individual trades, and so on. It reads the same
`data/trades.json` index that `journal.html` / `stats.html` / `patterns.html`
already use, boils it down into an aggregate summary plus a compact
per-trade index, and sends that (plus the running conversation) to an n8n
webhook on every message. Nothing runs until you actually send a message,
and each turn re-sends the full context, so the n8n side (and the LLM
behind it) never has to hold state between turns.

**Setup:** point `window.N8N_CHAT_URL` in `config.js` at your own n8n
webhook (`n8n/chat-workflow.json` in this repo is the workflow export —
import it into n8n and grab the webhook URL it generates). This is a
separate n8n workflow from the trade-pipeline one and from the
Support/Resistance webhook — same pattern as `N8N_SR_URL` in `trade.js`.

**Chart data:** if a message names a symbol that's actually in the
journal (e.g. "how'd the AAPL trade go"), `chat.js` resolves it to that
symbol's most recent logged trade (or an exact date match if the message
names one), fetches that trade's indicators — VWAP/EMA/MACD at entry,
computed stop/target, volume & float context — from `chart_service.py`'s
existing `/generate-chart` route (same Polygon-backed pipeline the
Backtester tab uses), and includes just that small JSON block as extra
context in the *same* request to n8n. It never sends the chart image or
the full per-minute bar series (both are in `/generate-chart`'s response
but would add a lot of tokens for little benefit in a text chat), and it
never triggers a second LLM call. This only covers symbols you've actually
logged a trade for — it's not a general "look up any ticker" lookup.
Needs `window.CHART_SERVICE_URL` set (see the Backtester section above);
if it's unset, unreachable, or the message doesn't match a logged trade,
chat just falls back to the journal text alone.

⚠️ **Before sharing or committing `n8n/chat-workflow.json` anywhere:** the
export as-is has a live Gemini API key hardcoded in the "Chat: LLM
Analysis" node's query parameters. Rotate/remove it (move it to an n8n
credential instead) before this file leaves your machine.

## Rewind tab

`rewind.html` / `rewind.js` turn your own logged trades into a
chart-reading practice tool. It's entirely client-side — no
`chart_service.py` call, no n8n webhook — it just reads the same
`data/trades.json` index and `data/trades/<id>.json` detail files that
`journal.html` / `trade.html` already read, and crops what it shows you.
It's deliberately not a graded test: there's no score, accuracy
percentage, or streak anywhere in it, just descriptive feedback on each
call so you can spot your own tendencies.

**Flow, per trade:**
1. **Entry** — the candlestick chart (with VWAP/EMA9/EMA20 + volume, same
   overlays as `trade.html`) cropped to the minute of the actual entry.
   You're told the side (long/short) and setup type and asked whether
   you'd take it. Nothing that would give away the outcome (verdict,
   lessons, suggested stop, etc.) is shown yet.
2. **Stop-loss** (only if you entered) — type a price or click directly
   on the chart to drop a stop line; a live risk-per-share preview updates
   as you move it.
3. **Mid-trade check-in** — reveals more candles up to a checkpoint
   between your entry and the real exit (or the exit bar itself, on fast
   trades with only one bar in between) and asks "exit now or hold?"
   showing your running unrealized P&L. If price would have already hit
   your stop before this point, you're auto-stopped-out and skipped
   straight to the reveal.
4. **Reveal** — the full chart with the real entry/exit markers, the AI's
   `suggested_stop`/`suggested_target` and `better_entry`/`better_exit`
   lines (same color scheme as `trade.html`), plus descriptive feedback on
   your entry call, your stop placement (compared against
   `suggested_stop`, when it's on the sane side of the real entry — see
   note below), and your hypothetical exit versus what actually happened.
   The trade's `verdict`, `lessons`, and `walk_away_rule` are shown
   underneath.

**Filters** on the setup screen: setup type, win/loss/flagged-only, trade
count, and a **blind mode** toggle (hides symbol & date until the reveal,
so you're reading the chart instead of remembering the trade — setup type
and side still show, since that's the information a real scan would
give you).

**Feedback, not scoring:** each call (entry, stop, exit, size) gets a
descriptive good/off/bad tag rather than points — "was this stop good" is
a judgment call, not a binary, so nothing gets tallied into a percentage,
and there's no streak counter. The session recap at the end just states
plain counts (trades reviewed / entered / passed) and a chip breakdown of
how each kind of call read. Session results are saved to `localStorage`
(`rewind:history`) so the setup screen shows past sessions plus a "setups
worth revisiting" list (linking into `playbooks.html?setup=...`)
aggregated from calls that didn't read as good.

**Data quirk to know about:** on a small number of trades (~1%),
`suggested_stop` / `suggested_target` were computed relative to the AI's
suggested `better_entry` price rather than the real entry — e.g. a chase
entry that's already past where a sane stop for *that* entry would sit.
`rewind.js` only draws/uses those fields as a benchmark when they land on
the correct side of the real entry price for the trade's side; otherwise
it silently falls back to a plain risk-percentage note with no AI
comparison.

## Data schema

### `data/trades.json` — the index

A flat JSON array, one object per trade, with the real dollar figures
straight from the IBKR Flex report (not a recomputed percentage):

```json
{
  "id": "AAPL-20260812-095948",
  "symbol": "AAPL",
  "side": "long",
  "trade_date": "2026-08-12",
  "entry_time": "09:59:48",
  "exit_time": "10:14:12",
  "entry_price": 231.44,
  "exit_price": 232.10,
  "shares": 200,
  "pnl_before_comm": 132.00,
  "commission": 3.20,
  "pnl_after_comm": 128.80,
  "win": true,
  "equity_after": 412.55,
  "setup_type": "vwap_reclaim",
  "lesson_tags": ["late_exit"],
  "better_entry_price": 231.02,
  "better_exit_price": 232.55
}
```

- `id` — used as the filename (`data/trades/<id>.json`) and the
  `trade.html?id=` query param. Convention: `{symbol}-{trade_date without
  dashes}-{entry_time without colons}`.
- `pnl_before_comm` / `commission` / `pnl_after_comm` — gross P&L, total
  commission (entry + exit legs), and net P&L, all in dollars, matching the
  `'P&L Before Comm'` / `'Commission'` / `'P&L After Comm'` fields the FIFO
  matcher (`Extract & Match Trades1`) already computes.
- `equity_after` — cumulative sum of `pnl_after_comm` up through this
  trade, in chronological order. The home page uses this directly for the
  equity curve rather than recomputing it, so the publish step owns that
  math.
- `setup_type` / `lesson_tags` / `better_entry_price` / `better_exit_price`
  — flat copies of fields that otherwise only live in the per-trade detail
  file (`setup_type`, `lesson_tags`, and the `.price` of `better_entry` /
  `better_exit`). **`journal.html`, `stats.html`, and `patterns.html` read
  only `data/trades.json`** (never fetching every detail file, to stay
  fast with hundreds of trades), so the publish step needs to copy these
  four values onto the index row alongside the detail file whenever they're
  set. Omit `better_entry_price`/`better_exit_price` when that trade has no
  flagged better fill, and `lesson_tags` when the trade has none — all four
  are optional and every page treats a missing value as "no data for this
  trade" rather than an error.
- `sector` / `country` — optional flat copies of `symbol_info.sector` /
  `symbol_info.country` from the detail file (same reasoning as the four
  fields above: the Reports tab's sector/country breakdown reads only the
  index, not every detail file). Not required — the breakdown just shows
  an empty state until the publish step starts copying these over.
- `avg_volume_tag` / `rvol_tag` / `float_tag` / `relative_volume` —
  optional flat copies of `indicators.avg_volume_tag` /
  `indicators.rvol_tag` / `indicators.float_tag` /
  `indicators.relative_volume` from the detail file, same
  reasoning/pattern as `sector`/`country`. See "Volume / relative volume /
  float" below for what produces them and their possible values. Omitted
  (not just empty) when the underlying stat couldn't be computed.

### `data/trades/<id>.json` — the detail record

```json
{
  "id": "AAPL-20260812-095948",
  "symbol": "AAPL",
  "side": "long",
  "trade_date": "2026-08-12",
  "entry_time": "09:59:48",
  "exit_time": "10:14:12",
  "entry_price": 231.44,
  "exit_price": 232.10,
  "shares": 200,
  "time_in_trade": "14:24",
  "pnl_before_comm": 132.00,
  "commission": 3.20,
  "pnl_after_comm": 128.80,
  "win": true,
  "verdict": "Clean breakout above VWAP with EMA9 already leading...",
  "setup_type": "VWAP reclaim",
  "indicators": {
    "vwap_at_entry": 231.02,
    "ema9_at_entry": 230.88,
    "ema20_at_entry": 230.41,
    "macd_at_entry": 0.14,
    "macd_signal_at_entry": 0.09,
    "macd_hist_at_entry": 0.05,
    "entry_vs_vwap": "above",
    "entry_vs_ema9": "above",
    "entry_vs_ema20": "above"
  },
  "bars": [
    {
      "t": "2026-08-12T08:30:00",
      "o": 231.10, "h": 231.30, "l": 231.05, "c": 231.20, "v": 4231,
      "vwap": 231.02, "ema9": 230.88, "ema20": 230.41,
      "macd": 0.14, "macd_signal": 0.09, "macd_hist": 0.05
    }
  ]
}
```

`bars` is exactly the `chart_service.py` `/generate-chart` response's new
`bars` field (see below) — the display-window minute bars with indicators
already computed, so the frontend just plots numbers and never re-derives
VWAP/EMA/MACD itself.

## `chart_service.py` change

`/generate-chart` now returns a third field alongside `image_base64` and
`indicators`:

```json
"bars": [ { "t": "...", "o": ..., "h": ..., "l": ..., "c": ..., "v": ...,
            "vwap": ..., "ema9": ..., "ema20": ...,
            "macd": ..., "macd_signal": ..., "macd_hist": ... }, ... ]
```

It's the same display window used to render the PNG (not the padded
lookback used to warm up EMA/MACD), already serialized to plain JSON —
nothing in n8n needs to touch pandas or do any indicator math.

## What the n8n workflow still needs (not yet wired into `perfection.json`)

Two additions to the existing daily-summary branch, after `Generate Chart` /
`Vision LLM Analysis` produce the verdict:

1. **Build trade detail JSON** (Code node) — assemble the
   `data/trades/<id>.json` shape above from: the trade fields already in
   the item, the `indicators` + `bars` now returned by `/generate-chart`,
   and the verdict text from `Parse Verdict & Attach Chart`.

2. **Publish to GitHub Pages** (two HTTP Request nodes against the GitHub
   Contents API, `PUT /repos/{owner}/{repo}/contents/{path}`):
   - Write `data/trades/<id>.json` (the file from step 1).
   - Fetch the current `data/trades.json`, append/update this trade's
     index row (including the running `equity_after`), and write it back.
   Both need `sha` from a preceding GET when the file already exists (GitHub
   requires it for updates) and a personal access token with `repo` scope
   in the request headers.

Once you've got the GitHub repo created and Pages enabled (Settings →
Pages → Deploy from branch), send over `owner/repo` and the exact branch/
folder Pages serves from, and the two HTTP Request nodes can be wired in
with the real URLs.

## Troubleshooting: "404" when clicking into a trade

`trade.html` fetches `data/trades/<id>.json`. If that comes back 404, the
row exists in `data/trades.json` but the matching detail file was never
actually written to the repo. The most common cause: `trades.json` gets
updated by a *separate* node/branch (`Update Trade Index`) from the one
that writes each detail file (`Build Trade JSON` → `Publish Trade Detail to
GitHub`). If the detail-file branch failed for a run (auth error, chart
service down, etc.) while the index branch succeeded, you end up with
index rows pointing at files that don't exist.

To check: open `data/trades/` in the GitHub repo and confirm a file exists
for the `id` you clicked. If it's missing, re-run the workflow for that
trade (or delete the stale row from `data/trades.json` and re-run) once
whatever caused the original failure — usually a GitHub token permission
issue — is fixed.


## Update: better entry/exit + symbol info
Data starts empty — populated only by the n8n pipeline. Each trade detail JSON now also includes better_entry / better_exit (price, time, reason), suggested_stop / suggested_target, risk_reward, walk_away_rule, lessons[], and symbol_info (name, country, sector, description), all produced by the Vision LLM step and drawn on the chart image (via a second /generate-chart pass) and on the interactive chart.
