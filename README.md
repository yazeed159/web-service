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
  a downloadable image, prev/next sibling navigation between trades, and
  inline 👍/👎 feedback buttons on each better-entry/exit call and lesson
  (stored in `localStorage`, per browser — not synced anywhere, just
  tallied on the Performance page).
- **`journal.html`** — the full trade log as one filterable, sortable
  table: symbol search, date range, entry time-of-day range, setup type,
  win/loss, and a "has better entry/exit flagged" checkbox. Deep-linkable
  from a Playbooks card via `?setup=<setup_type>`, which pre-selects that
  setup's filter. Same sidebar shell as the rest of the site.
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
  trade.html              per-trade page (reads ?id=... from the URL)
  style.css               shared design tokens + app-shell/sidebar layout
  features.css              additive styles for journal/stats/patterns/playbooks (filters, data table, bar rows, playbook cards)
  app.js                  home page logic
  trade.js                  trade page + chart logic
  data/
    trades.json          index: one row per trade, feeds the home table and journal/stats/patterns/playbooks pages
    trades/<id>.json      full detail per trade, feeds trade.html
```

`gen_sample_data.py` generated the sample data currently in `data/` (15
synthetic trades) so you can preview the site immediately. Delete
`data/trades.json` and `data/trades/*` and replace them with real output
once the pipeline is publishing.

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
