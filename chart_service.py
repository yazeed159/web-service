"""
chart_service.py
Flask microservice for the trade-review pipeline.

POST /generate-chart
{
  "symbol": "AAPL",
  "trade_date": "2026-08-12",     # from the new 'Trade Date' field
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
    "macd_at_entry": 0.14,
    "macd_signal_at_entry": 0.09,
    "macd_hist_at_entry": 0.05,
    "trend_direction": "up"
  }
}

Env vars:
  ALPACA_API_KEY_ID     - your Alpaca key (free paper-trading signup is enough)
  ALPACA_API_SECRET_KEY - your Alpaca secret
  CHART_WINDOW_BEFORE_MIN - minutes of context before entry (default 90)
  CHART_WINDOW_AFTER_MIN  - minutes of context after exit (default 30)
"""

import os
import io
import base64
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests
import pandas as pd
import mplfinance as mpf
import matplotlib.pyplot as plt
from flask import Flask, request, jsonify

app = Flask(__name__)

ALPACA_API_KEY_ID = os.environ["ALPACA_API_KEY_ID"]
ALPACA_API_SECRET_KEY = os.environ["ALPACA_API_SECRET_KEY"]
WINDOW_BEFORE = int(os.environ.get("CHART_WINDOW_BEFORE_MIN", 90))
WINDOW_AFTER = int(os.environ.get("CHART_WINDOW_AFTER_MIN", 30))

ALPACA_HEADERS = {
    "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
    "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
}


def fetch_bars(symbol: str, trade_date: str, entry_dt: datetime, exit_dt: datetime) -> pd.DataFrame:
    """Pull 1-minute bars from Alpaca's free IEX feed covering entry-WINDOW_BEFORE to exit+WINDOW_AFTER."""
    et = ZoneInfo("America/New_York")
    window_start = (entry_dt.replace(tzinfo=et) - timedelta(minutes=WINDOW_BEFORE)).astimezone(ZoneInfo("UTC"))
    window_end = (exit_dt.replace(tzinfo=et) + timedelta(minutes=WINDOW_AFTER)).astimezone(ZoneInfo("UTC"))

    url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars"
    params = {
        "timeframe": "1Min",
        "start": window_start.isoformat(),
        "end": window_end.isoformat(),
        "feed": "iex",          # free tier
        "limit": 10000,
        "adjustment": "raw",
    }

    all_bars = []
    while True:
        resp = requests.get(url, headers=ALPACA_HEADERS, params=params, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
        all_bars.extend(payload.get("bars") or [])
        token = payload.get("next_page_token")
        if not token:
            break
        params["page_token"] = token

    if not all_bars:
        raise ValueError(f"No bars returned for {symbol} in window {window_start}–{window_end} (IEX free feed has partial volume — try a more liquid symbol/time if this keeps happening)")

    df = pd.DataFrame(all_bars)
    df["t"] = pd.to_datetime(df["t"], utc=True).dt.tz_convert("America/New_York")
    df = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume", "vw": "vwap_bar"})
    df = df.set_index("t")[["Open", "High", "Low", "Close", "Volume", "vwap_bar"]]
    return df


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Adds session VWAP (cumulative from first bar of window), EMA9, MACD(12,26,9)."""
    df = df.copy()

    # Cumulative session VWAP: sum(price*vol)/sum(vol), not the per-bar vw field
    typical_price = (df["High"] + df["Low"] + df["Close"]) / 3
    df["cum_vol"] = df["Volume"].cumsum()
    df["cum_pv"] = (typical_price * df["Volume"]).cumsum()
    df["VWAP"] = df["cum_pv"] / df["cum_vol"]

    df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()

    ema12 = df["Close"].ewm(span=12, adjust=False).mean()
    ema26 = df["Close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_signal"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_hist"] = df["MACD"] - df["MACD_signal"]

    return df


def nearest_row(df: pd.DataFrame, ts: datetime) -> pd.Series:
    idx = df.index.get_indexer([ts], method="nearest")[0]
    return df.iloc[idx]


def render_chart(df: pd.DataFrame, symbol: str, entry_dt, exit_dt, entry_price, exit_price) -> bytes:
    macd_panel = [
        mpf.make_addplot(df["MACD"], panel=1, color="blue", ylabel="MACD"),
        mpf.make_addplot(df["MACD_signal"], panel=1, color="orange"),
        mpf.make_addplot(df["MACD_hist"], panel=1, type="bar", color="gray", alpha=0.5),
    ]
    overlays = [
        mpf.make_addplot(df["VWAP"], color="purple", width=1.2),
        mpf.make_addplot(df["EMA9"], color="teal", width=1.0),
    ]

    fig, axes = mpf.plot(
        df,
        type="candle",
        style="yahoo",
        addplot=overlays + macd_panel,
        volume=True,
        panel_ratios=(3, 1),
        returnfig=True,
        figsize=(11, 7),
        title=f"{symbol} — trade review",
    )

    price_ax = axes[0]
    entry_x = df.index.get_indexer([entry_dt], method="nearest")[0]
    exit_x = df.index.get_indexer([exit_dt], method="nearest")[0]
    price_ax.annotate("ENTRY", xy=(entry_x, entry_price), xytext=(entry_x, entry_price * 1.01),
                       arrowprops=dict(facecolor="green", shrink=0.05), color="green", fontweight="bold")
    price_ax.annotate("EXIT", xy=(exit_x, exit_price), xytext=(exit_x, exit_price * 1.01),
                       arrowprops=dict(facecolor="red", shrink=0.05), color="red", fontweight="bold")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


@app.route("/generate-chart", methods=["POST"])
def generate_chart():
    body = request.get_json(force=True)
    symbol = body["symbol"]
    trade_date = body["trade_date"]
    entry_dt = datetime.fromisoformat(f"{trade_date}T{body['entry_time']}")
    exit_dt = datetime.fromisoformat(f"{trade_date}T{body['exit_time']}")
    entry_price = float(body["entry_price"])
    exit_price = float(body["exit_price"])

    try:
        bars = fetch_bars(symbol, trade_date, entry_dt, exit_dt)
        bars = compute_indicators(bars)
        png_bytes = render_chart(bars, symbol, entry_dt, exit_dt, entry_price, exit_price)
    except ValueError as e:
        return jsonify({"error": str(e)}), 422

    at_entry = nearest_row(bars, entry_dt)
    prior_macd_hist = bars["MACD_hist"].loc[:at_entry.name].iloc[-2] if len(bars.loc[:at_entry.name]) > 1 else None

    indicators = {
        "vwap_at_entry": round(float(at_entry["VWAP"]), 4),
        "ema9_at_entry": round(float(at_entry["EMA9"]), 4),
        "macd_at_entry": round(float(at_entry["MACD"]), 4),
        "macd_signal_at_entry": round(float(at_entry["MACD_signal"]), 4),
        "macd_hist_at_entry": round(float(at_entry["MACD_hist"]), 4),
        "macd_hist_prior_bar": round(float(prior_macd_hist), 4) if prior_macd_hist is not None else None,
        "entry_vs_vwap": "above" if entry_price > at_entry["VWAP"] else "below",
        "entry_vs_ema9": "above" if entry_price > at_entry["EMA9"] else "below",
    }

    return jsonify({
        "image_base64": base64.b64encode(png_bytes).decode("utf-8"),
        "indicators": indicators,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
