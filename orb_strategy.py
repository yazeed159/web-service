"""
orb_strategy.py
A configurable long-only intraday breakout strategy. Entry, stop, and exit
are each picked independently from a menu of styles via params, so you can
mix e.g. a VWAP-reclaim entry with an ATR stop and a giveback exit. Nothing
is hard-coded -- the original "5-min ORB, range-low stop, 2R target" is
just the default if you touch nothing.

------------------------------------------------------------------------
ENTRY STYLES  (params["entry_mode"])
------------------------------------------------------------------------
"orb_breakout"  (default)
    Opening range = high/low of the first `orb_minutes` minutes after
    `session_open`. Entry = first bar after that window whose High trades
    above the range high. Fill approximated at max(bar Open, range high).

"red_candle_break"
    Walks the session watching for red candles (Close < Open). Entry =
    first later bar whose High breaks above that red candle's High --
    "buy the break of the last down candle's high."

"donchian_break"
    A rolling/trailing version of ORB with no fixed clock window: entry
    on the first bar whose High exceeds the highest High of the previous
    `donchian_lookback` bars. Keeps re-arming all session (first bar that
    satisfies it wins).

"inside_bar_break"
    Watches for an "inside bar" (High <= previous bar's High AND Low >=
    previous bar's Low -- a one-bar consolidation). Entry = first later
    bar whose High breaks above that inside bar's High.

"vwap_reclaim"
    Tracks session VWAP (cumulative typical-price*volume / cumulative
    volume). Entry = first bar whose High trades back above VWAP after
    the previous bar closed below it -- "buy the reclaim."

Common knob: `red_break_after_orb` / `donchian_after_orb` / etc. are not
needed -- all non-ORB entry styles accept `entry_after_orb` (bool,
default True) to decide whether they're allowed to fire during the
opening-range window or must wait until it closes.

------------------------------------------------------------------------
STOP STYLES  (params["stop_mode"])
------------------------------------------------------------------------
"pattern"  (default) -- stop = whatever level the entry style naturally
    implies (range low / red-candle low / donchian lookback low / inside
    bar low / pre-reclaim swing low).
"fixed_cents"   -- stop = entry_price - fixed_stop_cents / 100
"fixed_pct"     -- stop = entry_price * (1 - fixed_stop_pct / 100)
"prior_bar_low" -- stop = Low of the single bar immediately before entry
"atr_multiple"  -- stop = entry_price - atr_mult * ATR(atr_period),
    ATR computed from the `atr_period` session bars before entry.
    Falls back to pattern stop if there isn't enough history yet.

Stop management (applies on top of any stop_mode):
  breakeven_after_cents -- once price has moved this many cents in your
    favor, the stop ratchets up to entry_price (never moves down again).
    0/None disables it (default).

------------------------------------------------------------------------
EXIT LAYERS -- all optional, all stackable. Checked in this order on
every bar after entry (most protective first):
------------------------------------------------------------------------
1. Hard stop (with breakeven ratchet applied if configured).
2. Time stop: params["time_stop_minutes"] + params["time_stop_min_gain_cents"].
   If the trade has been open at least `time_stop_minutes` and hasn't
   gained at least `time_stop_min_gain_cents`, exit at that bar's close --
   "cut it if it's just sitting there."
3. Fixed R target: params["target_r"]. 0/None disables it.
4. Giveback / trailing exit:
     giveback_cents / giveback_pct -- exit once price pulls back that much
     from the peak reached since entry (cents, or % of the open gain).
     giveback_arm_cents -- don't watch for giveback until price has first
     moved this many cents in your favor.
5. Momentum-stall exit: params["stall_exit"] = true. Exit at the close of
   the first bar, while in profit, that closes red AND closes below the
   previous bar's close.
6. Flatten at `flatten_time` if nothing else fired.

None of the new params change anything if left at their defaults --
default config reproduces the original single-rule ORB breakout.

Params (all optional):
  # session
  orb_minutes            - opening range length in minutes (default 5)
  session_open           - "HH:MM" ET session open (default "09:30")
  flatten_time           - "HH:MM" ET force-exit time (default "15:55")

  # entry
  entry_mode             - "orb_breakout" | "red_candle_break" | "donchian_break"
                            | "inside_bar_break" | "vwap_reclaim" (default "orb_breakout")
  entry_after_orb        - bool, gates non-ORB entry styles to only fire
                            after the opening-range window (default True)
  donchian_lookback      - bars, used by donchian_break (default 10)

  # stop
  stop_mode              - "pattern" | "fixed_cents" | "fixed_pct"
                            | "prior_bar_low" | "atr_multiple" (default "pattern")
  fixed_stop_cents       - cents, for stop_mode "fixed_cents" (default 5.0)
  fixed_stop_pct         - percent, for stop_mode "fixed_pct" (default 1.0)
  atr_period             - bars, for stop_mode "atr_multiple" (default 14)
  atr_mult               - ATR multiple, for stop_mode "atr_multiple" (default 1.5)
  breakeven_after_cents  - ratchet stop to entry after this much favorable
                            move; 0/None disables (default None)

  # exits
  target_r                    - R multiple, 0/None disables (default 2.0)
  time_stop_minutes           - minutes, 0/None disables (default None)
  time_stop_min_gain_cents    - required gain by then (default 0.0)
  giveback_cents               - cents pullback from peak (default None)
  giveback_pct                 - % of open gain given back (default None)
  giveback_arm_cents           - cents in favor before giveback arms (default 0.0)
  stall_exit                   - bool (default False)
"""

from datetime import datetime, timedelta, time as dtime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

DEFAULT_PARAMS = {
    "orb_minutes": 5,
    "session_open": "09:30",
    "flatten_time": "15:55",

    "entry_mode": "orb_breakout",
    "entry_after_orb": True,
    "donchian_lookback": 10,

    "stop_mode": "pattern",
    "fixed_stop_cents": 5.0,
    "fixed_stop_pct": 1.0,
    "atr_period": 14,
    "atr_mult": 1.5,
    "breakeven_after_cents": None,

    "target_r": 2.0,
    "time_stop_minutes": None,
    "time_stop_min_gain_cents": 0.0,
    "giveback_cents": None,
    "giveback_pct": None,
    "giveback_arm_cents": 0.0,
    "stall_exit": False,
}


def _parse_hhmm(s: str) -> dtime:
    h, m = s.split(":")
    return dtime(int(h), int(m))


# ---------------------------------------------------------------------------
# Entry finders. Each returns (entry_idx, entry_price, pattern_stop, extra
# dict) or None. `pattern_stop` is what stop_mode="pattern" will use.
# ---------------------------------------------------------------------------

def _find_orb_breakout_entry(session_bars, orb_end_dt):
    orb_bars = session_bars[session_bars.index < orb_end_dt]
    if orb_bars.empty:
        return None
    orb_high = float(orb_bars["High"].max())
    orb_low = float(orb_bars["Low"].min())
    if orb_high <= orb_low:
        return None

    post_orb = session_bars[session_bars.index >= orb_end_dt]
    if post_orb.empty:
        return None

    breakout_mask = post_orb["High"] > orb_high
    if not breakout_mask.any():
        return None

    entry_idx = post_orb.index[breakout_mask][0]
    entry_bar = post_orb.loc[entry_idx]
    entry_price = max(float(entry_bar["Open"]), orb_high)
    return entry_idx, entry_price, orb_low, {"orb_high": orb_high, "orb_low": orb_low}


def _find_red_candle_break_entry(scan_bars):
    last_red_high = None
    last_red_low = None

    for ts, bar in scan_bars.iterrows():
        bar_high = float(bar["High"])
        bar_open = float(bar["Open"])
        bar_close = float(bar["Close"])
        bar_low = float(bar["Low"])

        if last_red_high is not None and bar_high > last_red_high:
            entry_price = max(bar_open, last_red_high)
            return ts, entry_price, last_red_low, {
                "pattern_red_high": last_red_high,
                "pattern_red_low": last_red_low,
            }

        if bar_close < bar_open:
            last_red_high = bar_high
            last_red_low = bar_low

    return None


def _find_donchian_break_entry(scan_bars, lookback):
    highs = scan_bars["High"].tolist()
    lows = scan_bars["Low"].tolist()
    opens = scan_bars["Open"].tolist()
    idxs = scan_bars.index.tolist()

    for i in range(1, len(idxs)):
        start = max(0, i - lookback)
        window_high = max(highs[start:i]) if highs[start:i] else None
        if window_high is None:
            continue
        if highs[i] > window_high:
            entry_price = max(opens[i], window_high)
            window_low = min(lows[start:i])
            return idxs[i], entry_price, window_low, {"donchian_high": window_high, "donchian_low": window_low}
    return None


def _find_inside_bar_break_entry(scan_bars):
    highs = scan_bars["High"].tolist()
    lows = scan_bars["Low"].tolist()
    opens = scan_bars["Open"].tolist()
    idxs = scan_bars.index.tolist()

    inside_high = None
    inside_low = None
    for i in range(1, len(idxs)):
        if inside_high is not None and highs[i] > inside_high:
            entry_price = max(opens[i], inside_high)
            return idxs[i], entry_price, inside_low, {
                "pattern_inside_high": inside_high, "pattern_inside_low": inside_low,
            }
        # is bar i an inside bar relative to bar i-1?
        if highs[i] <= highs[i - 1] and lows[i] >= lows[i - 1]:
            inside_high = highs[i]
            inside_low = lows[i]
        else:
            inside_high = None
            inside_low = None
    return None


def _find_vwap_reclaim_entry(session_bars, scan_start_idx):
    """VWAP computed cumulatively from session open (not from scan_start_idx),
    since VWAP is a session-wide construct; the scan window just decides
    where we're allowed to trigger."""
    typical = (session_bars["High"] + session_bars["Low"] + session_bars["Close"]) / 3.0
    cum_pv = (typical * session_bars["Volume"]).cumsum()
    cum_vol = session_bars["Volume"].cumsum().replace(0, float("nan"))
    vwap = cum_pv / cum_vol

    idxs = session_bars.index.tolist()
    highs = session_bars["High"].tolist()
    lows = session_bars["Low"].tolist()
    closes = session_bars["Close"].tolist()
    opens = session_bars["Open"].tolist()
    vwap_vals = vwap.tolist()

    swing_low = None
    below_vwap = False
    for i in range(len(idxs)):
        if vwap_vals[i] != vwap_vals[i]:  # NaN guard
            continue
        if closes[i] < vwap_vals[i]:
            below_vwap = True
            swing_low = lows[i] if swing_low is None else min(swing_low, lows[i])
            continue
        if below_vwap and i >= scan_start_idx and highs[i] > vwap_vals[i]:
            entry_price = max(opens[i], vwap_vals[i])
            stop = swing_low if swing_low is not None else lows[i]
            return idxs[i], entry_price, stop, {"vwap_at_entry": round(vwap_vals[i], 4)}
        below_vwap = False
        swing_low = None
    return None


# ---------------------------------------------------------------------------
# Stop resolvers
# ---------------------------------------------------------------------------

def _atr_before(session_bars, entry_idx, period):
    pos = session_bars.index.get_loc(entry_idx)
    if pos < 2:
        return None
    start = max(0, pos - period)
    window = session_bars.iloc[start:pos]
    if len(window) < 2:
        return None
    trs = []
    prev_close = None
    for _, bar in window.iterrows():
        h, l, c = float(bar["High"]), float(bar["Low"]), float(bar["Close"])
        tr = (h - l) if prev_close is None else max(h - l, abs(h - prev_close), abs(l - prev_close))
        trs.append(tr)
        prev_close = c
    return sum(trs) / len(trs) if trs else None


def _resolve_stop(p, session_bars, entry_idx, entry_price, pattern_stop):
    mode = p["stop_mode"]
    if mode == "fixed_cents":
        return entry_price - float(p["fixed_stop_cents"]) / 100.0
    if mode == "fixed_pct":
        return entry_price * (1 - float(p["fixed_stop_pct"]) / 100.0)
    if mode == "prior_bar_low":
        pos = session_bars.index.get_loc(entry_idx)
        if pos >= 1:
            return float(session_bars.iloc[pos - 1]["Low"])
        return pattern_stop
    if mode == "atr_multiple":
        atr = _atr_before(session_bars, entry_idx, int(p["atr_period"]))
        if atr:
            return entry_price - float(p["atr_mult"]) * atr
        return pattern_stop
    return pattern_stop  # "pattern" or unrecognized


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def simulate_orb_trade(bars: "pd.DataFrame", trade_date, params: dict = None) -> dict | None:
    """
    bars: 1-minute OHLCV DataFrame for ONE trading day, tz-aware index
          (America/New_York), as returned by polygon_client.fetch_minute_bars.
    trade_date: date object, just used to build session boundary timestamps.
    Returns a trade dict, or None if no valid setup.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}
    if bars.empty:
        return None

    session_open = _parse_hhmm(p["session_open"])
    flatten = _parse_hhmm(p["flatten_time"])

    open_dt = datetime.combine(trade_date, session_open, tzinfo=ET)
    orb_end_dt = open_dt + timedelta(minutes=p["orb_minutes"])
    flatten_dt = datetime.combine(trade_date, flatten, tzinfo=ET)

    session_bars = bars[(bars.index >= open_dt) & (bars.index <= flatten_dt)]
    if session_bars.empty:
        return None

    entry_mode = p["entry_mode"]
    after_orb = bool(p.get("entry_after_orb", True))

    if entry_mode == "orb_breakout":
        found = _find_orb_breakout_entry(session_bars, orb_end_dt)
    elif entry_mode == "red_candle_break":
        scan_bars = session_bars[session_bars.index >= orb_end_dt] if after_orb else session_bars
        found = _find_red_candle_break_entry(scan_bars) if not scan_bars.empty else None
    elif entry_mode == "donchian_break":
        scan_bars = session_bars[session_bars.index >= orb_end_dt] if after_orb else session_bars
        found = _find_donchian_break_entry(scan_bars, int(p["donchian_lookback"])) if not scan_bars.empty else None
    elif entry_mode == "inside_bar_break":
        scan_bars = session_bars[session_bars.index >= orb_end_dt] if after_orb else session_bars
        found = _find_inside_bar_break_entry(scan_bars) if not scan_bars.empty else None
    elif entry_mode == "vwap_reclaim":
        if "Volume" not in session_bars.columns:
            return None
        scan_start_idx = len(session_bars[session_bars.index < orb_end_dt]) if after_orb else 0
        found = _find_vwap_reclaim_entry(session_bars, scan_start_idx)
    else:
        found = _find_orb_breakout_entry(session_bars, orb_end_dt)

    if found is None:
        return None
    entry_idx, entry_price, pattern_stop, extra = found

    stop_price = _resolve_stop(p, session_bars, entry_idx, entry_price, pattern_stop)
    risk = entry_price - stop_price
    if risk <= 0:
        return None

    target_r = p.get("target_r") or 0
    target_price = entry_price + target_r * risk if target_r > 0 else None

    giveback_cents = p.get("giveback_cents") or None
    giveback_pct = p.get("giveback_pct") or None
    giveback_arm = float(p.get("giveback_arm_cents") or 0.0) / 100.0
    stall_exit = bool(p.get("stall_exit"))
    breakeven_after = p.get("breakeven_after_cents") or None
    time_stop_minutes = p.get("time_stop_minutes") or None
    time_stop_min_gain = float(p.get("time_stop_min_gain_cents") or 0.0) / 100.0

    after_entry = session_bars.loc[entry_idx:]
    exit_price = None
    exit_time = None
    exit_reason = None

    peak_price = entry_price
    prev_close = None
    current_stop = stop_price
    breakeven_armed = False

    for ts, bar in after_entry.iterrows():
        if ts == entry_idx:
            prev_close = float(bar["Close"])
            continue

        low = float(bar["Low"])
        high = float(bar["High"])
        close = float(bar["Close"])
        openp = float(bar["Open"])

        # breakeven ratchet (evaluated on the high reached so far, before stop check)
        if breakeven_after and not breakeven_armed and (peak_price - entry_price) >= float(breakeven_after) / 100.0:
            current_stop = max(current_stop, entry_price)
            breakeven_armed = True

        # 1. hard stop
        if low <= current_stop:
            exit_price, exit_time, exit_reason = current_stop, ts, "stop"
            break

        peak_price = max(peak_price, high)

        # 2. time stop
        if time_stop_minutes:
            elapsed_min = (ts - entry_idx).total_seconds() / 60.0
            if elapsed_min >= float(time_stop_minutes) and (close - entry_price) < time_stop_min_gain:
                exit_price, exit_time, exit_reason = close, ts, "time_stop"
                break

        # 3. fixed R target
        if target_price is not None and high >= target_price:
            exit_price, exit_time, exit_reason = target_price, ts, "target"
            break

        # 4. giveback / trailing exit
        gain_so_far = peak_price - entry_price
        if gain_so_far >= giveback_arm:
            giveback_amt = peak_price - low
            if giveback_cents and giveback_amt >= float(giveback_cents) / 100.0:
                trigger_price = peak_price - float(giveback_cents) / 100.0
                exit_price, exit_time, exit_reason = trigger_price, ts, "giveback"
                break
            if giveback_pct and gain_so_far > 0 and giveback_amt >= (float(giveback_pct) / 100.0) * gain_so_far:
                trigger_price = peak_price - (float(giveback_pct) / 100.0) * gain_so_far
                exit_price, exit_time, exit_reason = trigger_price, ts, "giveback_pct"
                break

        # 5. momentum-stall exit
        if stall_exit and close > entry_price and close < openp and prev_close is not None and close < prev_close:
            exit_price, exit_time, exit_reason = close, ts, "momentum_stall"
            break

        prev_close = close

    if exit_price is None:
        last_ts = after_entry.index[-1]
        exit_price = float(after_entry.loc[last_ts, "Close"])
        exit_time = last_ts
        exit_reason = "eod_flatten"

    pnl_per_share = exit_price - entry_price
    r_multiple = pnl_per_share / risk

    result = {
        "entry_time": entry_idx,
        "entry_price": round(entry_price, 4),
        "stop_price": round(stop_price, 4),
        "target_price": round(target_price, 4) if target_price is not None else None,
        "exit_time": exit_time,
        "exit_price": round(exit_price, 4),
        "exit_reason": exit_reason,
        "risk_per_share": round(risk, 4),
        "pnl_per_share": round(pnl_per_share, 4),
        "r_multiple": round(r_multiple, 3),
        "win": pnl_per_share > 0,
    }
    result.update({k: (round(v, 4) if isinstance(v, float) else v) for k, v in extra.items()})
    return result
