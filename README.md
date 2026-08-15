# trade.log — interactive trading journal dashboard

A static site that reads two kinds of JSON files and renders:

- **`index.html`** — a home page with a scrolling ticker, win-rate / P&L
  stats, an animated equity curve, and a sortable, searchable, filterable
  trade table.
- **`trade.html?id=<trade_id>`** — a per-trade page with a real interactive
  candlestick chart (zoom, pan, hover crosshair) built from that trade's
  actual OHLC bars, with VWAP/EMA9/EMA20 overlays, a synced MACD panel,
  entry/exit markers, and the LLM's verdict.

No backend, no build step — it's plain HTML/CSS/JS plus two charting/font
CDN scripts, so it works as-is on GitHub Pages (or any static host).

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
  index.html          home page
  trade.html           per-trade page (reads ?id=... from the URL)
  style.css            shared styles
  app.js                home page logic
  trade.js              trade page + chart logic
  data/
    trades.json          index: one row per trade, feeds the home table
    trades/<id>.json      full detail per trade, feeds trade.html
```

`gen_sample_data.py` generated the sample data currently in `data/` (15
synthetic trades) so you can preview the site immediately. Delete
`data/trades.json` and `data/trades/*` and replace them with real output
once the pipeline is publishing.

## Data schema

### `data/trades.json` — the index

A flat JSON array, one object per trade:

```json
{
  "id": "AAPL-20260812-01",
  "symbol": "AAPL",
  "trade_date": "2026-08-12",
  "entry_time": "09:59:48",
  "exit_time": "10:14:12",
  "entry_price": 231.44,
  "exit_price": 232.10,
  "pnl_pct": 0.29,
  "win": true,
  "equity_after": 4.87
}
```

- `id` — used as the filename (`data/trades/<id>.json`) and the
  `trade.html?id=` query param. Suggested convention:
  `{symbol}-{trade_date without dashes}-{counter for that day}`.
- `equity_after` — cumulative sum of `pnl_pct` up through this trade, in
  chronological order. The home page uses this directly for the equity
  curve rather than recomputing it, so the publish step owns that math.

### `data/trades/<id>.json` — the detail record

```json
{
  "id": "AAPL-20260812-01",
  "symbol": "AAPL",
  "side": "long",
  "trade_date": "2026-08-12",
  "entry_time": "09:59:48",
  "exit_time": "10:14:12",
  "entry_price": 231.44,
  "exit_price": 232.10,
  "pnl_pct": 0.29,
  "win": true,
  "verdict": "Clean breakout above VWAP with EMA9 already leading...",
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
