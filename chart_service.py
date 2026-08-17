"""
chart_service.py
Flask microservice for the trade-review pipeline.

POST /generate-chart
{
  "symbol": "AAPL",
  "trade_date": "2026-08-12",     # from the 'Trade Date' field
  "entry_time": "09:59:48",       # HH:MM:SS, from 'Entry Time'
  "exit_time": "10:14:12",        # HH:MM:SS, from 'Exit Time'
  "entry_price": 231.44,
  "exit_price": 232.10
}

Returns:
{
  "image_base64": "...",          # PNG, ready to pin into Sheets / send to vision LLM
  "indicators": {                 # ground-truth numbers, not read off pixels
    "vwap_at_entry": 231.02,
    "ema9_at_entry": 230.88,
    "ema20_at_entry": 230.41,
    "macd_at_entry": 0.14,
    "macd_signal_at_entry": 0.09,
    "macd_hist_at_entry": 0.05,
    "macd_hist_prior_bar": 0.03,
    "entry_vs_vwap": "above",
    "entry_vs_ema9": "above",
    "entry_vs_ema20": "above"
  },
  "bars": [                       # display-window OHLCV + indicators, one
                                   # object per minute, for the dashboard's
                                   # client-side interactive chart (see
                                   # dashboard/README.md). NOT the full
                                   # lookback-padded series -- same window
                                   # that's rendered into image_base64.
    {
      "t": "2026-08-12T08:30:00",
      "o": 231.10, "h": 231.30, "l": 231.05, "c": 231.20, "v": 4231,
      "vwap": 231.02, "ema9": 230.88, "ema20": 230.41,
      "macd": 0.14, "macd_signal": 0.09, "macd_hist": 0.05
    },
    ...
  ]
}

Data source: Polygon.io (consolidated tape across all US exchanges — not just
IEX, which matters for thinly-traded small caps where the IEX-only slice of
volume can badly distort VWAP).

Indicator accuracy notes:
  - VWAP resets at the 9:30 ET session open every trading day (a real
    "anchored" session VWAP), not from an arbitrary point mid-window.
  - EMA9 / EMA20 / MACD are computed over a multi-day lookback so they have
    a proper warm-up period before the display window, instead of being
    seeded artificially at the first bar of the chart.

Env vars:
  POLYGON_API_KEY          - your Polygon.io API key
  CHART_WINDOW_BEFORE_MIN  - minutes of context before entry (default 90)
  CHART_WINDOW_AFTER_MIN   - minutes of context after exit (default 30)
  CHART_LOOKBACK_DAYS      - calendar days of prior bars fetched purely to
                              warm up EMA/MACD (default 5, not displayed)
  POLYGON_BATCH_SIZE       - Polygon calls allowed per batch before the
                              service pauses (default 5, matching free tier)
  POLYGON_BATCH_WINDOW_S   - seconds to wait between batches (default 65,
                              i.e. Polygon's 60s/5-call window plus buffer)
  POLYGON_BATCH_MIN_GAP_S  - minimum stagger between calls within one batch
                              (default 2.0)
"""

import os
import io
import time
import base64
import threading
import traceback
import logging
from datetime import datetime, timedelta, date, time as dtime
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

import requests
import pandas as pd
import matplotlib
matplotlib.use("Agg")  # headless rendering — must be set before importing mplfinance/pyplot
import mplfinance as mpf
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import MaxNLocator, AutoMinorLocator
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("chart_service")

app = Flask(__name__)

# matplotlib/mplfinance keep process-global state (current figure/axes) that is
# NOT thread-safe. app.run(threaded=True) below hands each request its own
# thread, so two requests rendering at the same time can corrupt or deadlock on
# that shared state -- which then wedges the *whole* process, not just the one
# request (this is what turns "one slow trade" into "every request after it
# times out with connection refused/aborted"). Serialize anything that touches
# matplotlib through this lock so only one render runs at a time.
RENDER_LOCK = threading.Lock()

# Hard ceiling on total request handling time, independent of fetch_bars'
# internal network deadline. If ANYTHING hangs (a lock wait, a matplotlib
# stall, etc.) this guarantees the request fails with a clean error instead of
# hanging indefinitely and taking the server down for every request behind it.
# The n8n workflow already paces calls to this endpoint one-at-a-time, 13s
# apart (see the Generate Chart node's batching options) -- so this only
# needs to cover an occasional 429 backoff plus render time, not a long
# queue wait. Keep the n8n node's own "timeout" option comfortably above
# this value (it was 45000ms, which is too tight -- see chat).
REQUEST_HARD_TIMEOUT_S = 60
_request_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="chart-req")

POLYGON_API_KEY = os.environ["POLYGON_API_KEY"]
WINDOW_BEFORE = int(os.environ.get("CHART_WINDOW_BEFORE_MIN", 90))
WINDOW_AFTER = int(os.environ.get("CHART_WINDOW_AFTER_MIN", 30))
LOOKBACK_DAYS = int(os.environ.get("CHART_LOOKBACK_DAYS", 5))

# Polygon's free tier allows 5 API calls/minute. The n8n workflow itself
# already sends requests to this endpoint one-at-a-time, spaced 13s apart
# (the Generate Chart node's batching option), which is already under the
# 12s-per-call minimum the free tier needs -- so in normal operation this
# limiter should rarely if ever have to wait. It exists as a safety net for
# anything that doesn't go through that pacing (manual testing, retries,
# future workflow changes with a larger batch). BATCH_SIZE=1 makes it a
# plain "wait at least WINDOW_S since the last call" limiter rather than a
# 5-then-wait-a-minute one, matching the workflow's actual call pattern
# instead of fighting it.
POLYGON_BATCH_SIZE = int(os.environ.get("POLYGON_BATCH_SIZE", 1))
POLYGON_BATCH_WINDOW_S = float(os.environ.get("POLYGON_BATCH_WINDOW_S", 13))
POLYGON_BATCH_MIN_GAP_S = float(os.environ.get("POLYGON_BATCH_MIN_GAP_S", 2.0))  # only matters if BATCH_SIZE > 1

ET = ZoneInfo("America/New_York")
SESSION_VWAP_START = dtime(4, 0)  # session VWAP resets here each day — pre-market open, not 9:30 regular open


class _PolygonBatchLimiter:
    """Process-wide '5 calls, then wait, then next 5' pacing matching
    Polygon's free-tier limit, instead of continuous spacing. Every call to
    wait_turn() either passes straight through (still under the batch cap,
    respecting the small in-batch stagger) or blocks until the next batch
    window opens -- so a burst of requests naturally gets throttled into
    batches no matter how many arrive at once or how they're spaced by n8n."""

    def __init__(self, batch_size: int, window_s: float, min_gap_s: float):
        self._batch_size = batch_size
        self._window_s = window_s
        self._min_gap_s = min_gap_s
        self._lock = threading.Lock()
        self._count_in_batch = 0
        self._window_started_at = None
        self._last_call_at = None

    def wait_turn(self):
        with self._lock:
            now = time.monotonic()
            if self._window_started_at is None:
                self._window_started_at = now

            if self._count_in_batch >= self._batch_size:
                remaining = self._window_s - (now - self._window_started_at)
                if remaining > 0:
                    log.info(
                        "Polygon batch limiter: %d calls done, waiting %.1fs before next batch of %d",
                        self._count_in_batch, remaining, self._batch_size,
                    )
                    time.sleep(remaining)
                now = time.monotonic()
                self._count_in_batch = 0
                self._window_started_at = now
                self._last_call_at = None

            if self._last_call_at is not None:
                gap_remaining = self._min_gap_s - (now - self._last_call_at)
                if gap_remaining > 0:
                    time.sleep(gap_remaining)
                    now = time.monotonic()

            self._count_in_batch += 1
            self._last_call_at = now


_polygon_limiter = _PolygonBatchLimiter(POLYGON_BATCH_SIZE, POLYGON_BATCH_WINDOW_S, POLYGON_BATCH_MIN_GAP_S)

# The raw bar fetch depends only on (symbol, trade_date) -- NOT on the
# specific entry/exit times -- so multiple trades on the same symbol/day
# (common when reviewing a batch from one session) would otherwise each pay
# for an identical Polygon call. Cache it. Small process-lifetime cache, no
# TTL needed since past-day bars don't change; capped size with FIFO eviction
# so it can't grow unbounded across a long-running n8n batch.
_BARS_CACHE_MAX = 200
_bars_cache = {}
_bars_cache_lock = threading.Lock()


def fetch_bars(symbol: str, trade_date: str, entry_dt: datetime, exit_dt: datetime):
    """
    Pull 1-minute bars from Polygon covering [trade_date - LOOKBACK_DAYS, trade_date].
    The extra lookback is only there to warm up EMA/MACD — it's not shown on
    the chart. Returns (full_df, display_mask).
    """
    trade_date_obj = datetime.strptime(trade_date, "%Y-%m-%d").date()
    cache_key = (symbol, trade_date_obj)

    with _bars_cache_lock:
        cached = _bars_cache.get(cache_key)
    if cached is not None:
        log.info("Bars cache hit for %s %s -- skipping Polygon call", symbol, trade_date_obj)
        df = cached
    else:
        df = _fetch_raw_bars_from_polygon(symbol, trade_date_obj)
        with _bars_cache_lock:
            if len(_bars_cache) >= _BARS_CACHE_MAX:
                _bars_cache.pop(next(iter(_bars_cache)))  # evict oldest (dict insertion order)
            _bars_cache[cache_key] = df

    window_start = entry_dt - timedelta(minutes=WINDOW_BEFORE)
    window_end = exit_dt + timedelta(minutes=WINDOW_AFTER)
    display_mask = (df.index >= window_start) & (df.index <= window_end)

    if not display_mask.any():
        raise ValueError(f"No bars in display window {window_start}–{window_end} for {symbol} (thin small-cap volume can leave gaps — try widening CHART_WINDOW_BEFORE_MIN)")

    return df, display_mask


def _fetch_raw_bars_from_polygon(symbol: str, trade_date_obj: date) -> pd.DataFrame:
    fetch_start_date = trade_date_obj - timedelta(days=LOOKBACK_DAYS)

    url = f"https://api.polygon.io/v2/aggs/ticker/{symbol}/range/1/minute/{fetch_start_date}/{trade_date_obj}"
    params = {"adjusted": "true", "sort": "asc", "limit": 50000, "apiKey": POLYGON_API_KEY}

    all_bars = []
    next_url = url
    page_count = 0
    max_pages = 10
    # Hard wall-clock cap across ALL pages combined, including limiter waits.
    # Sized to fit comfortably under REQUEST_HARD_TIMEOUT_S (60s) with room
    # left over for rendering.
    fetch_deadline = time.monotonic() + 45
    while next_url:
        page_count += 1
        if page_count > max_pages:
            raise ValueError(f"Polygon pagination for {symbol} exceeded {max_pages} pages -- aborting instead of hanging.")
        if time.monotonic() > fetch_deadline:
            raise ValueError(f"Fetching bars for {symbol} took longer than 45s across {page_count} page(s) -- aborting instead of hanging.")

        # Wait for our turn under the batch limiter BEFORE calling -- this is
        # what actually enforces "5 calls, then wait ~60s, then next 5"
        # across every request hitting this process, regardless of how n8n
        # schedules them (parallel or sequential).
        _polygon_limiter.wait_turn()

        # Still retry on 429 for the rare case another process/instance is
        # also burning the shared free-tier quota -- but with a tighter
        # budget now that proactive pacing should make this the exception,
        # not the norm. IMPORTANT: this stays well under n8n's real HTTP
        # Request timeout. n8n's "timeout" option is unreliable (known n8n
        # bug -- it often silently falls back to a hardcoded ~300s
        # regardless of what's configured), so this service must never let a
        # single request run anywhere near that long. If Polygon's
        # Retry-After is large (daily quota exhausted, not just per-minute
        # throttling), we fail fast instead of sleeping through it.
        max_attempts = 3
        max_single_wait_s = 15
        max_total_wait_s = 30
        total_waited = 0.0
        for attempt in range(1, max_attempts + 1):
            resp = requests.get(next_url, params=params if next_url == url else None, timeout=15)
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                wait_s = min(float(retry_after), max_single_wait_s) if retry_after else min(2 ** attempt * 3, max_single_wait_s)
                log.warning(
                    "Polygon 429 for %s (attempt %d/%d, Retry-After=%r) despite pacing -- waiting %.1fs",
                    symbol, attempt, max_attempts, retry_after, wait_s
                )
                if attempt == max_attempts or total_waited + wait_s > max_total_wait_s:
                    raise ValueError(
                        f"Polygon rate-limited us repeatedly for {symbol} (429, Retry-After={retry_after!r}) "
                        f"even with the {POLYGON_BATCH_SIZE}-per-{POLYGON_BATCH_WINDOW_S:.0f}s batch limiter. "
                        f"This likely means another process is sharing the same free-tier key/quota, or it's a "
                        f"daily/monthly quota rather than per-minute throttling -- consider lowering "
                        f"POLYGON_BATCH_SIZE, raising POLYGON_BATCH_WINDOW_S, or upgrading the Polygon plan."
                    )
                time.sleep(wait_s)
                total_waited += wait_s
                continue
            resp.raise_for_status()
            break

        payload = resp.json()
        if payload.get("status") not in ("OK", "DELAYED") and not payload.get("results"):
            raise ValueError(f"Polygon returned status={payload.get('status')} for {symbol}: {payload.get('error') or payload.get('message')}")
        n_results = len(payload.get("results") or [])
        all_bars.extend(payload.get("results") or [])
        next_url = payload.get("next_url")
        if next_url:
            log.info("Polygon page %d for %s: %d bars, more pages pending", page_count, symbol, n_results)
            next_url = f"{next_url}&apiKey={POLYGON_API_KEY}"

    if not all_bars:
        raise ValueError(f"No bars returned for {symbol} between {fetch_start_date} and {trade_date_obj} (check the ticker is correct and Polygon's plan covers this history)")

    df = pd.DataFrame(all_bars)
    df["t"] = pd.to_datetime(df["t"], unit="ms", utc=True).dt.tz_convert(ET)
    df = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume", "vw": "vwap_bar"})
    df = df.set_index("t")[["Open", "High", "Low", "Close", "Volume", "vwap_bar"]].sort_index()
    return _fill_intraday_gaps(df)


def _fill_intraday_gaps(df: pd.DataFrame) -> pd.DataFrame:
    """Polygon only returns a bar for a minute if a trade actually printed
    in it -- thin/illiquid tickers (especially pre/post-market on small
    caps) can leave real gaps of several minutes with no bar at all. Left
    as-is, that silently compresses the chart: a candlestick chart plots
    bar-by-bar, not on a true time axis, so 20 real minutes with only 3
    prints renders as if only 3 minutes passed -- which is why widening
    CHART_WINDOW_BEFORE_MIN/AFTER_MIN alone didn't fix a chart that looked
    like it only covered ~10 minutes. Reindex each trading day present to a
    continuous 1-minute grid and forward-fill the missing minutes as flat,
    zero-volume bars at the last known price, so the configured window
    actually renders as that much time."""
    if df.empty:
        return df
    filled = []
    for _, day_df in df.groupby(df.index.date):
        full_idx = pd.date_range(day_df.index.min(), day_df.index.max(), freq="1min", tz=day_df.index.tz)
        day_df = day_df.reindex(full_idx)
        day_df["Volume"] = day_df["Volume"].fillna(0)
        day_df["Close"] = day_df["Close"].ffill()
        day_df["Open"] = day_df["Open"].fillna(day_df["Close"])
        day_df["High"] = day_df["High"].fillna(day_df["Close"])
        day_df["Low"] = day_df["Low"].fillna(day_df["Close"])
        day_df["vwap_bar"] = day_df["vwap_bar"].fillna(day_df["Close"])
        filled.append(day_df)
    return pd.concat(filled).sort_index()


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """VWAP resets every session at SESSION_VWAP_START (4:00 AM ET pre-market
    open) so it includes pre-market volume — the standard anchor for small-cap
    gap-and-go setups. EMA/MACD run continuously across the whole fetched
    series so they're properly warmed up by the display window."""
    df = df.copy()

    typical_price = (df["High"] + df["Low"] + df["Close"]) / 3
    pv = typical_price * df["Volume"]
    session_date = df.index.date
    in_vwap_session = df.index.time >= SESSION_VWAP_START

    vol_for_vwap = df["Volume"].where(in_vwap_session, 0.0)
    pv_for_vwap = pv.where(in_vwap_session, 0.0)
    df["cum_vol"] = vol_for_vwap.groupby(session_date).cumsum()
    df["cum_pv"] = pv_for_vwap.groupby(session_date).cumsum()
    df["VWAP"] = df["cum_pv"] / df["cum_vol"]

    df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()

    ema12 = df["Close"].ewm(span=12, adjust=False).mean()
    ema26 = df["Close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_signal"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_hist"] = df["MACD"] - df["MACD_signal"]

    return df


def nearest_row(df: pd.DataFrame, ts: datetime) -> pd.Series:
    idx = df.index.get_indexer([ts], method="nearest")[0]
    return df.iloc[idx]


def compute_trade_levels(full_bars: pd.DataFrame, entry_dt: datetime, entry_price: float, side: str) -> dict:
    """Rule-based read of the setup + a chart-grounded stop/target, computed
    from real levels (swing points, VWAP/EMA9) so the LLM has defensible
    numbers instead of guessing. side is 'long' or 'short'."""
    is_long = side != "short"
    pre_entry = full_bars.loc[:entry_dt]
    lookback = pre_entry.tail(30)  # ~30 min of structure before entry

    avg_vol = pre_entry["Volume"].tail(20).mean() or 1.0
    entry_bar_vol = pre_entry["Volume"].iloc[-1] if len(pre_entry) else 0.0
    at_entry = nearest_row(full_bars, entry_dt)
    vwap_e, ema9_e = float(at_entry["VWAP"]), float(at_entry["EMA9"])

    recent_high = float(lookback["High"].max()) if len(lookback) else entry_price
    recent_low = float(lookback["Low"].min()) if len(lookback) else entry_price
    prior_high = float(lookback["High"].iloc[:-1].max()) if len(lookback) > 1 else recent_high

    breakout = is_long and entry_price >= prior_high * 0.999 and entry_bar_vol >= 1.5 * avg_vol
    dip_buy = is_long and abs(entry_price - vwap_e) / max(entry_price, 1) < 0.006 or (is_long and abs(entry_price - ema9_e) / max(entry_price, 1) < 0.006)
    setup_type = "breakout" if breakout else ("dip_buy" if dip_buy else "other")

    if is_long:
        swing_stop = recent_low - (recent_high - recent_low) * 0.05
        stop_price = min(swing_stop, vwap_e - 0.01) if setup_type == "dip_buy" else swing_stop
        stop_price = min(stop_price, entry_price - 0.01)
        risk = entry_price - stop_price
        target_price = entry_price + risk * 2
    else:
        swing_stop = recent_high + (recent_high - recent_low) * 0.05
        stop_price = max(swing_stop, vwap_e + 0.01) if setup_type == "dip_buy" else swing_stop
        stop_price = max(stop_price, entry_price + 0.01)
        risk = stop_price - entry_price
        target_price = entry_price - risk * 2

    reward = abs(target_price - entry_price)
    return {
        "setup_type": setup_type,
        "stop_price": round(stop_price, 4),
        "target_price": round(target_price, 4),
        "risk_per_share": round(abs(risk), 4),
        "reward_per_share": round(reward, 4),
        "r_multiple": 2,
    }


def serialize_bars(df: pd.DataFrame) -> list:
    """Display-window bars -> plain JSON-able dicts for the dashboard's
    client-side candlestick chart. Timestamps are naive local (ET) strings --
    the frontend renders them as wall-clock time, same as the PNG chart does,
    so it never has to reason about the ET tzinfo itself."""
    out = []
    for ts, row in df.iterrows():
        out.append({
            "t": ts.strftime("%Y-%m-%dT%H:%M:%S"),
            "o": round(float(row["Open"]), 4),
            "h": round(float(row["High"]), 4),
            "l": round(float(row["Low"]), 4),
            "c": round(float(row["Close"]), 4),
            "v": int(row["Volume"]),
            "vwap": round(float(row["VWAP"]), 4),
            "ema9": round(float(row["EMA9"]), 4),
            "ema20": round(float(row["EMA20"]), 4),
            "macd": round(float(row["MACD"]), 4),
            "macd_signal": round(float(row["MACD_signal"]), 4),
            "macd_hist": round(float(row["MACD_hist"]), 4),
        })
    return out


def render_chart(df: pd.DataFrame, symbol: str, entry_dt, exit_dt, entry_price, exit_price,
                  vwap_at_entry, ema9_at_entry, ema20_at_entry,
                  stop_price=None, target_price=None,
                  better_entry=None, better_exit=None) -> bytes:
    # Histogram bars colored per-bar: green when positive, red when negative.
    macd_hist_colors = ["#2ca02c" if v >= 0 else "#d62728" for v in df["MACD_hist"]]
    # MACD lives on its own panel (2), separate from volume (panel 1) -- both
    # were previously defaulting to panel 1 at once (volume's implicit default
    # collided with MACD's explicit panel=1), which is why MACD was rendering
    # on top of the volume bars instead of in its own lane below them.
    macd_panel = [
        mpf.make_addplot(df["MACD"], panel=2, color="blue", ylabel="MACD", width=1.0),
        mpf.make_addplot(df["MACD_signal"], panel=2, color="orange", width=1.0),
        mpf.make_addplot(df["MACD_hist"], panel=2, type="bar", color=macd_hist_colors, width=0.7, alpha=0.75),
    ]
    overlays = [
        mpf.make_addplot(df["VWAP"], color="orange", width=1.3),
        mpf.make_addplot(df["EMA9"], color="gray", width=1.0),
        mpf.make_addplot(df["EMA20"], color="blue", width=1.0),
    ]

    style = mpf.make_mpf_style(base_mpf_style="yahoo", gridstyle="")

    # mpf.plot / plt.close touch matplotlib's process-global state, which
    # isn't safe to hit from multiple threads at once -- serialize the whole
    # render under RENDER_LOCK. try/finally guarantees the lock is released
    # even if something raises mid-render, so one failed chart can't
    # permanently wedge every request behind it.
    RENDER_LOCK.acquire()
    try:
        return _render_chart_locked(
            df, symbol, entry_dt, exit_dt, entry_price, exit_price,
            macd_panel, overlays, style,
            vwap_at_entry, ema9_at_entry, ema20_at_entry,
            stop_price, target_price, better_entry, better_exit,
        )
    finally:
        RENDER_LOCK.release()


def _render_chart_locked(df, symbol, entry_dt, exit_dt, entry_price, exit_price,
                          macd_panel, overlays, style,
                          vwap_at_entry, ema9_at_entry, ema20_at_entry,
                          stop_price=None, target_price=None,
                          better_entry=None, better_exit=None) -> bytes:
    """Everything here runs with RENDER_LOCK held -- see render_chart()."""
    fig, axes = mpf.plot(
        df,
        type="candle",
        style=style,
        addplot=overlays + macd_panel,
        volume=True,
        volume_panel=1,
        # price : volume : macd -- volume and MACD each get a smaller slice
        # than a plain (3, 1, 1) split so they stop crowding each other now
        # that they're on their own panels.
        panel_ratios=(4, 1, 1),
        returnfig=True,
        figsize=(12, 8.2),
        title=f"{symbol} — trade review",
        datetime_format="%H:%M",
        xrotation=0,
    )

    price_ax = axes[0]
    price_ax.yaxis.set_major_locator(MaxNLocator(nbins=14, prune=None))
    price_ax.yaxis.set_minor_locator(AutoMinorLocator(2))
    price_ax.grid(True, which="major", axis="y", linestyle="--", linewidth=0.6, color="#999999", alpha=0.55)
    price_ax.grid(True, which="minor", axis="y", linestyle=":", linewidth=0.4, color="#cccccc", alpha=0.35)
    price_ax.grid(True, which="major", axis="x", linestyle="--", linewidth=0.4, color="#cccccc", alpha=0.25)

    # mplfinance addplots don't auto-populate a legend — build one explicitly.
    # The line color itself is enough to tell VWAP/EMA9/EMA20 apart, so the
    # label just carries each one's price at entry instead of spelling out
    # the color or the VWAP session-reset note.
    legend_lines = [
        Line2D([0], [0], color="orange", lw=1.3, label=f"VWAP  ${vwap_at_entry:.2f}"),
        Line2D([0], [0], color="gray", lw=1.0, label=f"EMA 9  ${ema9_at_entry:.2f}"),
        Line2D([0], [0], color="blue", lw=1.0, label=f"EMA 20  ${ema20_at_entry:.2f}"),
    ]
    # Placed above the axes (not inside upper-left corner) so it can never
    # collide with the entry/exit labels, which also live near the top.
    price_ax.legend(
        handles=legend_lines, loc="lower center", bbox_to_anchor=(0.5, 1.01),
        ncol=3, fontsize=8, framealpha=0.9, borderaxespad=0,
    )

    entry_x = df.index.get_indexer([entry_dt], method="nearest")[0]
    exit_x = df.index.get_indexer([exit_dt], method="nearest")[0]

    price_ax.axhline(entry_price, color="green", linestyle=":", linewidth=0.8, alpha=0.6)
    price_ax.axhline(exit_price, color="red", linestyle=":", linewidth=0.8, alpha=0.6)

    price_high = df["High"].max()
    price_low = df["Low"].min()
    price_range = price_high - price_low

    # Anchor each label to the candle highs right around ITS OWN arrow,
    # instead of a fixed height above the whole chart's peak -- that's what
    # keeps the label close to the arrow instead of floating way up top.
    def _local_high(center_x, half_window=4):
        lo = max(0, center_x - half_window)
        hi = min(len(df) - 1, center_x + half_window)
        return float(df["High"].iloc[lo:hi + 1].max())

    label_gap = price_range * 0.05      # clearance above the nearest candle tops
    box_half_height = price_range * 0.06  # room the two-line label box needs above its anchor

    entry_label_y = _local_high(entry_x) + label_gap + box_half_height
    exit_label_y = _local_high(exit_x) + label_gap + box_half_height

    # On fast trades entry_x and exit_x can be only a few bars apart, which
    # would put both label boxes at nearly the same spot -- push whichever
    # one is lower up above the other so they never collide.
    if abs(entry_x - exit_x) < 10 and abs(entry_label_y - exit_label_y) < box_half_height * 2:
        if entry_label_y <= exit_label_y:
            entry_label_y = exit_label_y + box_half_height * 2
        else:
            exit_label_y = entry_label_y + box_half_height * 2

    # Better entry/exit label positions -- computed HERE, before ylim is set,
    # so their headroom actually gets counted below. (Previously these were
    # computed later inside _mark_better, after ylim was already locked in,
    # so a better-entry/exit label could land above the visible range --
    # and since the figure is saved with bbox_inches="tight", matplotlib
    # would just stretch the whole image upward to reach it, which is what
    # made the marker look like it had jumped somewhere far away.)
    def _better_pos(dt_val, kind):
        if dt_val is None:
            return None
        try:
            x = int(df.index.get_indexer([pd.Timestamp(dt_val)], method="nearest")[0])
        except Exception:
            return None
        y = _local_high(x) + label_gap + box_half_height * (3 if kind == "entry" else 3.6)
        return (x, y)

    better_entry_pos = _better_pos(better_entry.get("time"), "entry") if better_entry else None
    better_exit_pos = _better_pos(better_exit.get("time"), "exit") if better_exit else None

    # Headroom needs to cover whichever label ends up highest, plus a small
    # margin -- not a fixed fraction of the whole chart like before.
    candidate_tops = [price_high, entry_label_y + box_half_height, exit_label_y + box_half_height]
    if better_entry_pos is not None:
        candidate_tops.append(better_entry_pos[1] + box_half_height)
    if better_exit_pos is not None:
        candidate_tops.append(better_exit_pos[1] + box_half_height)
    chart_top = max(candidate_tops)
    top_pad = max(price_range * 0.08, (chart_top - price_high) + price_range * 0.04)
    bottom_pad = price_range * 0.06
    price_ax.set_ylim(price_low - bottom_pad, price_high + top_pad)

    # Label text floats up in the headroom band with NO arrow attached to it --
    # this is what used to stretch a long arrow across the whole candle area.
    price_ax.annotate(
        f"ENTRY ${entry_price:.2f}\n{entry_dt.strftime('%H:%M:%S')}",
        xy=(entry_x, entry_label_y), xycoords="data",
        color="green", fontweight="bold", fontsize=8.5, ha="center", va="center",
        bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="green", alpha=0.9),
    )
    price_ax.annotate(
        f"EXIT ${exit_price:.2f}\n{exit_dt.strftime('%H:%M:%S')}",
        xy=(exit_x, exit_label_y), xycoords="data",
        color="red", fontweight="bold", fontsize=8.5, ha="center", va="center",
        bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="red", alpha=0.9),
    )

    # No arrow shaft at all -- just a tiny triangle glyph hovering a few points
    # above the exact price, tip pointing straight down at it.
    price_ax.annotate(
        "\u25bc", xy=(entry_x, entry_price), xycoords="data",
        xytext=(0, 5), textcoords="offset points",
        ha="center", va="bottom", fontsize=9, color="green",
    )
    price_ax.annotate(
        "\u25bc", xy=(exit_x, exit_price), xycoords="data",
        xytext=(0, 5), textcoords="offset points",
        ha="center", va="bottom", fontsize=9, color="red",
    )

    # Structural / suggested stop & target — dashed reference lines so the
    # levels used to grade the trade are visible on the chart itself.
    if stop_price is not None:
        price_ax.axhline(stop_price, color="#b02a2a", linestyle="--", linewidth=0.9, alpha=0.7)
        price_ax.annotate(f"stop ${stop_price:.2f}", xy=(1, stop_price), xycoords=("axes fraction", "data"),
                           xytext=(4, 0), textcoords="offset points", ha="left", va="center",
                           fontsize=7.5, color="#b02a2a")
    if target_price is not None:
        price_ax.axhline(target_price, color="#1a7a4c", linestyle="--", linewidth=0.9, alpha=0.7)
        price_ax.annotate(f"target ${target_price:.2f}", xy=(1, target_price), xycoords=("axes fraction", "data"),
                           xytext=(4, 0), textcoords="offset points", ha="left", va="center",
                           fontsize=7.5, color="#1a7a4c")

    # Better entry/exit — where the trade SHOULD have been taken, per the
    # review verdict. Blue, drawn beneath the actual entry/exit labels so
    # both are readable on the same image. Position was already computed
    # above (and folded into the ylim headroom) -- just draw it here.
    def _mark_better(pos, price_val, kind):
        if pos is None or price_val is None:
            return
        x, y = pos
        price_ax.annotate(
            f"BETTER {kind.upper()}\n${price_val:.2f}",
            xy=(x, y), xycoords="data",
            color="#2f6fed", fontweight="bold", fontsize=8, ha="center", va="center",
            bbox=dict(boxstyle="round,pad=0.22", fc="white", ec="#2f6fed", alpha=0.92),
        )
        price_ax.annotate(
            "\u25b2", xy=(x, price_val), xycoords="data",
            xytext=(0, -5), textcoords="offset points",
            ha="center", va="top", fontsize=9, color="#2f6fed",
        )

    if better_entry:
        _mark_better(better_entry_pos, better_entry.get("price"), "entry")
    if better_exit:
        _mark_better(better_exit_pos, better_exit.get("price"), "exit")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def _build_chart_response(body, start):
    """The actual work for one /generate-chart call. Runs inside the worker
    pool so generate_chart() below can enforce a hard wall-clock timeout on it."""
    symbol = body["symbol"]
    trade_date = body["trade_date"]
    log.info("Received request: %s on %s", symbol, trade_date)
    entry_dt = datetime.fromisoformat(f"{trade_date}T{body['entry_time']}").replace(tzinfo=ET)
    exit_dt = datetime.fromisoformat(f"{trade_date}T{body['exit_time']}").replace(tzinfo=ET)
    entry_price = float(body["entry_price"])
    exit_price = float(body["exit_price"])
    side = (body.get("side") or "long").lower()

    full_bars, display_mask = fetch_bars(symbol, trade_date, entry_dt, exit_dt)
    full_bars = compute_indicators(full_bars)
    display_bars = full_bars.loc[display_mask]

    # Computed up front (not after rendering) because the chart legend now
    # shows each indicator's price at entry instead of a color name.
    at_entry = nearest_row(full_bars, entry_dt)
    levels = compute_trade_levels(full_bars, entry_dt, entry_price, side)

    # Optional second-pass fields: once the review verdict is known, the
    # workflow calls this endpoint again with these so the FINAL chart (the
    # one that gets published) shows where the trade should've been taken,
    # not just where it was.
    def _better(price_key, time_key):
        p, t = body.get(price_key), body.get(time_key)
        if p is None or t is None:
            return None
        return {"price": float(p), "time": f"{trade_date}T{t}"}

    better_entry = _better("better_entry_price", "better_entry_time")
    better_exit = _better("better_exit_price", "better_exit_time")
    stop_for_chart = float(body["suggested_stop"]) if body.get("suggested_stop") is not None else levels["stop_price"]
    target_for_chart = float(body["suggested_target"]) if body.get("suggested_target") is not None else levels["target_price"]

    png_bytes = render_chart(
        display_bars, symbol, entry_dt, exit_dt, entry_price, exit_price,
        vwap_at_entry=float(at_entry["VWAP"]),
        ema9_at_entry=float(at_entry["EMA9"]),
        ema20_at_entry=float(at_entry["EMA20"]),
        stop_price=stop_for_chart, target_price=target_for_chart,
        better_entry=better_entry, better_exit=better_exit,
    )

    prior_slice = full_bars["MACD_hist"].loc[:at_entry.name]
    prior_macd_hist = prior_slice.iloc[-2] if len(prior_slice) > 1 else None

    indicators = {
        "vwap_at_entry": round(float(at_entry["VWAP"]), 4),
        "ema9_at_entry": round(float(at_entry["EMA9"]), 4),
        "ema20_at_entry": round(float(at_entry["EMA20"]), 4),
        "macd_at_entry": round(float(at_entry["MACD"]), 4),
        "macd_signal_at_entry": round(float(at_entry["MACD_signal"]), 4),
        "macd_hist_at_entry": round(float(at_entry["MACD_hist"]), 4),
        "macd_hist_prior_bar": round(float(prior_macd_hist), 4) if prior_macd_hist is not None else None,
        "entry_vs_vwap": "above" if entry_price > at_entry["VWAP"] else "below",
        "entry_vs_ema9": "above" if entry_price > at_entry["EMA9"] else "below",
        "entry_vs_ema20": "above" if entry_price > at_entry["EMA20"] else "below",
        "setup_type": levels["setup_type"],
        "stop_price": levels["stop_price"],
        "target_price": levels["target_price"],
        "risk_per_share": levels["risk_per_share"],
        "reward_per_share": levels["reward_per_share"],
        "r_multiple": levels["r_multiple"],
        "display_price_low": round(float(display_bars["Low"].min()), 4),
        "display_price_high": round(float(display_bars["High"].max()), 4),
    }

    log.info("Done: %s in %.1fs", symbol, time.monotonic() - start)
    return {
        "image_base64": base64.b64encode(png_bytes).decode("utf-8"),
        "indicators": indicators,
        "bars": serialize_bars(display_bars),
    }


@app.route("/generate-chart", methods=["POST"])
def generate_chart():
    start = time.monotonic()
    try:
        body = request.get_json(force=True)
        if body is None:
            return jsonify({"error": "Request body was empty or not valid JSON"}), 400

        # Run the actual work in the worker pool and enforce a hard ceiling on
        # it. This is the key safety net: if anything unexpected hangs (a lock
        # wait, a stalled render, a stuck upstream call fetch_bars' own 90s
        # deadline didn't anticipate), this request fails cleanly at
        # REQUEST_HARD_TIMEOUT_S instead of hanging indefinitely and making
        # the whole service look "offline" for every request queued behind it.
        future = _request_pool.submit(_build_chart_response, body, start)
        try:
            result = future.result(timeout=REQUEST_HARD_TIMEOUT_S)
        except FutureTimeoutError:
            log.error(
                "Hard timeout after %.1fs for %s -- abandoning (worker thread "
                "may still be running in the background, but this connection "
                "is released so it can't take the rest of the queue down with it)",
                time.monotonic() - start, body.get("symbol"),
            )
            return jsonify({
                "error": f"generate-chart exceeded the {REQUEST_HARD_TIMEOUT_S}s hard timeout"
            }), 504

        return jsonify(result)
    except ValueError as e:
        log.warning("ValueError after %.1fs: %s", time.monotonic() - start, e)
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        # Temporary: surface the real traceback in the response so it shows up in n8n
        # instead of a generic 500 page. Remove this except block once things are stable.
        log.error("Unhandled error after %.1fs: %s", time.monotonic() - start, e)
        return jsonify({
            "error": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc()
        }), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
