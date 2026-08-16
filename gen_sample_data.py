"""
Generates sample data/trades.json + data/trades/<id>.json matching the
dollar-based schema the n8n pipeline now publishes (gross P&L / commission /
net P&L, straight from the IBKR Flex report), so the dashboard can be
previewed before real data is flowing.
"""
import json
import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(11)

OUT = Path(__file__).parent / "data"
(OUT / "trades").mkdir(parents=True, exist_ok=True)

SYMBOLS = ["MARA", "PLTR", "SOFI", "AAPL", "TSLA", "AMD", "RIOT", "NIO", "SMCI", "COIN", "AI", "IONQ"]

VERDICTS_WIN = [
    "Clean breakout above VWAP with EMA9 already leading. Entry aligned with momentum, exit caught most of the move before the pullback.",
    "Textbook reclaim of EMA20 after a flush. MACD histogram flipped positive one bar before entry -- good timing.",
    "Gap-and-go continuation. Price held above VWAP the entire hold; exit was early but avoided the late-session chop.",
    "Strong relative volume into the open. Entry came right as MACD crossed signal, exit hit near the session high.",
]
VERDICTS_LOSS = [
    "Entry chased extension well above VWAP -- no real pullback to buy. Reversed hard within minutes.",
    "MACD histogram was already fading going into entry, an early warning that got missed. Stop did its job.",
    "Low relative volume for the move size; the breakout didn't have real participation behind it.",
    "Entry below EMA20 fighting the intraday trend. Exit was disciplined but the setup was against the tape.",
]
SETUPS = ["VWAP reclaim", "EMA9/20 pullback", "Gap and go", "MACD cross continuation", "Opening range break"]


def make_trade(i, base_dt):
    symbol = random.choice(SYMBOLS)
    win = random.random() < 0.58
    shares = random.choice([100, 150, 200, 300, 500])
    entry_price = round(random.uniform(4, 60), 2)
    move_pct = random.uniform(0.4, 3.2) / 100 * (1 if win else -1) * random.uniform(0.5, 1.0)
    exit_price = round(entry_price * (1 + move_pct), 2)
    if not win and exit_price >= entry_price:
        exit_price = round(entry_price * 0.995, 2)
    if win and exit_price <= entry_price:
        exit_price = round(entry_price * 1.006, 2)

    pnl_before = round((exit_price - entry_price) * shares, 2)
    commission = round(shares * random.uniform(0.004, 0.008) * 2, 2)  # entry + exit
    pnl_after = round(pnl_before - commission, 2)
    win = pnl_after >= 0

    hold_minutes = random.randint(6, 45)
    entry_hour = random.choice([9, 9, 10, 10, 11, 13, 14])
    entry_minute = random.randint(0, 59) if entry_hour != 9 else random.randint(31, 59)
    entry_dt = base_dt.replace(hour=entry_hour, minute=entry_minute, second=random.randint(0, 59))
    exit_dt = entry_dt + timedelta(minutes=hold_minutes)

    window_start = entry_dt - timedelta(minutes=90)
    window_end = exit_dt + timedelta(minutes=30)

    bars = []
    price = entry_price * random.uniform(0.985, 1.015)
    vwap_cum_pv, vwap_cum_vol = 0.0, 0.0
    ema9 = ema20 = price
    ema12 = ema26 = price
    macd_signal = 0.0
    prev_close = price

    total_minutes = int((window_end - window_start).total_seconds() // 60) + 1
    entry_idx = int((entry_dt - window_start).total_seconds() // 60)
    exit_idx = int((exit_dt - window_start).total_seconds() // 60)

    for m in range(total_minutes):
        if m < entry_idx:
            target = entry_price
        elif m < exit_idx:
            target = exit_price
        else:
            target = exit_price * (1 + (0.003 if win else -0.003) * random.uniform(-1, 1))

        noise = random.uniform(-0.0035, 0.0035) * price
        price = price + (target - price) * 0.08 + noise
        o = prev_close
        c = price
        h = max(o, c) + abs(random.uniform(0, 0.002)) * price
        l = min(o, c) - abs(random.uniform(0, 0.002)) * price
        vol = max(50, int(random.gauss(2200, 900)))
        if m in (entry_idx, exit_idx):
            vol = int(vol * random.uniform(1.8, 3.2))

        typical = (h + l + c) / 3
        vwap_cum_pv += typical * vol
        vwap_cum_vol += vol
        vwap = vwap_cum_pv / vwap_cum_vol if vwap_cum_vol else c

        ema9 = c * (2 / 10) + ema9 * (1 - 2 / 10)
        ema20 = c * (2 / 21) + ema20 * (1 - 2 / 21)
        ema12 = c * (2 / 13) + ema12 * (1 - 2 / 13)
        ema26 = c * (2 / 27) + ema26 * (1 - 2 / 27)
        macd = ema12 - ema26
        macd_signal = macd * (2 / 10) + macd_signal * (1 - 2 / 10)
        macd_hist = macd - macd_signal

        ts = window_start + timedelta(minutes=m)
        bars.append({
            "t": ts.strftime("%Y-%m-%dT%H:%M:%S"),
            "o": round(o, 4), "h": round(h, 4), "l": round(l, 4), "c": round(c, 4),
            "v": vol,
            "vwap": round(vwap, 4), "ema9": round(ema9, 4), "ema20": round(ema20, 4),
            "macd": round(macd, 4), "macd_signal": round(macd_signal, 4), "macd_hist": round(macd_hist, 4),
        })
        prev_close = c

    at_entry = bars[entry_idx]
    mm = str(hold_minutes).zfill(2)
    trade_id = f"{symbol}-{base_dt.strftime('%Y%m%d')}-{i:02d}"

    detail = {
        "id": trade_id,
        "symbol": symbol,
        "side": "long",
        "trade_date": base_dt.strftime("%Y-%m-%d"),
        "entry_time": entry_dt.strftime("%H:%M:%S"),
        "exit_time": exit_dt.strftime("%H:%M:%S"),
        "entry_price": entry_price,
        "exit_price": exit_price,
        "shares": shares,
        "time_in_trade": f"{mm}:{random.randint(0,59):02d}",
        "pnl_before_comm": pnl_before,
        "commission": commission,
        "pnl_after_comm": pnl_after,
        "win": win,
        "verdict": random.choice(VERDICTS_WIN if win else VERDICTS_LOSS),
        "setup_type": random.choice(SETUPS),
        "indicators": {
            "vwap_at_entry": at_entry["vwap"],
            "ema9_at_entry": at_entry["ema9"],
            "ema20_at_entry": at_entry["ema20"],
            "macd_at_entry": at_entry["macd"],
            "macd_signal_at_entry": at_entry["macd_signal"],
            "macd_hist_at_entry": at_entry["macd_hist"],
            "entry_vs_vwap": "above" if entry_price > at_entry["vwap"] else "below",
            "entry_vs_ema9": "above" if entry_price > at_entry["ema9"] else "below",
            "entry_vs_ema20": "above" if entry_price > at_entry["ema20"] else "below",
        },
        "bars": bars,
    }
    return detail


def main():
    trades = []
    day = datetime(2026, 7, 20)
    i = 0
    for d in range(14):
        this_day = day + timedelta(days=d)
        if this_day.weekday() >= 5:
            continue
        n_trades = random.choice([0, 1, 1, 2, 2, 3, 3])
        for _ in range(n_trades):
            i += 1
            detail = make_trade(i, this_day)
            trades.append(detail)

    trades.sort(key=lambda t: (t["trade_date"], t["entry_time"]))

    index = []
    equity = 0.0
    for t in trades:
        equity += t["pnl_after_comm"]
        index.append({
            "id": t["id"], "symbol": t["symbol"], "side": t["side"],
            "trade_date": t["trade_date"], "entry_time": t["entry_time"], "exit_time": t["exit_time"],
            "entry_price": t["entry_price"], "exit_price": t["exit_price"], "shares": t["shares"],
            "pnl_before_comm": t["pnl_before_comm"], "commission": t["commission"], "pnl_after_comm": t["pnl_after_comm"],
            "win": t["win"], "equity_after": round(equity, 2),
        })
        with open(OUT / "trades" / f"{t['id']}.json", "w") as f:
            json.dump(t, f)

    with open(OUT / "trades.json", "w") as f:
        json.dump(index, f, indent=2)

    print(f"Generated {len(index)} trades")


if __name__ == "__main__":
    main()
