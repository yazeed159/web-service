"""
engine.py
Orchestrates the backtest: for each trading day in range, find the top-N
gappers, simulate the strategy on each, and aggregate results + stats.

Swappable strategy: pass any callable with the signature
    (bars_df, trade_date, params) -> trade_dict | None
Defaults to orb_strategy.simulate_orb_trade.
"""

import logging
from dataclasses import dataclass, field
from datetime import date

import pandas as pd

import polygon_client as pc
from orb_strategy import simulate_orb_trade, DEFAULT_PARAMS

log = logging.getLogger("backtest.engine")


@dataclass
class BacktestConfig:
    start_date: date
    end_date: date
    top_n: int = 5
    min_price: float = 1.0
    max_price: float = 50.0
    min_dollar_volume: float = 5_000_000
    min_gap_pct: float = 5.0
    position_size_dollars: float = 2000.0  # notional per trade, for $ P&L (not just per-share/R stats)
    strategy_params: dict = field(default_factory=lambda: dict(DEFAULT_PARAMS))
    strategy_fn: callable = simulate_orb_trade


def run_backtest(cfg: BacktestConfig, progress_cb=None) -> list[dict]:
    """
    Returns a list of trade dicts (one per symbol/day that produced a
    trade), each with: date, symbol, gap_pct, entry_time, entry_price,
    exit_time, exit_price, exit_reason, shares, risk_per_share,
    pnl_per_share, pnl_dollars, r_multiple, win.
    """
    trades = []
    days = list(pc.trading_days_between(cfg.start_date, cfg.end_date))

    for i, d in enumerate(days):
        if progress_cb:
            progress_cb(i, len(days), d)
        try:
            gainers = pc.find_top_gainers(
                d, top_n=cfg.top_n, min_price=cfg.min_price, max_price=cfg.max_price,
                min_dollar_volume=cfg.min_dollar_volume, min_gap_pct=cfg.min_gap_pct,
            )
        except Exception as e:
            log.warning("Skipping %s -- gainer scan failed: %s", d, e)
            continue

        if gainers.empty:
            continue

        for symbol, row in gainers.iterrows():
            try:
                bars = pc.fetch_minute_bars(symbol, d)
            except Exception as e:
                log.warning("Skipping %s %s -- bar fetch failed: %s", symbol, d, e)
                continue

            try:
                result = cfg.strategy_fn(bars, d, cfg.strategy_params)
            except Exception as e:
                log.warning("Skipping %s %s -- strategy error: %s", symbol, d, e)
                continue

            if result is None:
                continue

            shares = int(cfg.position_size_dollars / result["entry_price"]) if result["entry_price"] else 0
            pnl_dollars = shares * result["pnl_per_share"]

            trades.append({
                "date": d.isoformat(),
                "symbol": symbol,
                "gap_pct": round(float(row["gap_pct"]), 2),
                "entry_time": result["entry_time"].strftime("%H:%M:%S"),
                "entry_price": result["entry_price"],
                "exit_time": result["exit_time"].strftime("%H:%M:%S"),
                "exit_price": result["exit_price"],
                "exit_reason": result["exit_reason"],
                "stop_price": result["stop_price"],
                "target_price": result["target_price"],
                "shares": shares,
                "risk_per_share": result["risk_per_share"],
                "pnl_per_share": result["pnl_per_share"],
                "pnl_dollars": round(pnl_dollars, 2),
                "r_multiple": result["r_multiple"],
                "win": result["win"],
            })

    trades.sort(key=lambda t: (t["date"], t["entry_time"]))
    return trades


def compute_stats(trades: list[dict]) -> dict:
    """Summary stats + equity curve from a list of trade dicts (as produced
    by run_backtest). Safe to call with an empty list."""
    if not trades:
        return {
            "num_trades": 0, "win_rate": 0.0, "profit_factor": None,
            "avg_win_dollars": 0.0, "avg_loss_dollars": 0.0, "avg_r": 0.0,
            "expectancy_r": 0.0, "net_pnl_dollars": 0.0, "max_drawdown_dollars": 0.0,
            "longest_win_streak": 0, "longest_loss_streak": 0, "equity_curve": [],
        }

    wins = [t for t in trades if t["win"]]
    losses = [t for t in trades if not t["win"]]

    gross_profit = sum(t["pnl_dollars"] for t in wins)
    gross_loss = -sum(t["pnl_dollars"] for t in losses)  # positive number

    equity = 0.0
    equity_curve = []
    peak = 0.0
    max_dd = 0.0
    cur_win_streak = cur_loss_streak = 0
    longest_win_streak = longest_loss_streak = 0

    for t in trades:
        equity += t["pnl_dollars"]
        equity_curve.append({"date": t["date"], "symbol": t["symbol"], "equity": round(equity, 2)})
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
        if t["win"]:
            cur_win_streak += 1
            cur_loss_streak = 0
        else:
            cur_loss_streak += 1
            cur_win_streak = 0
        longest_win_streak = max(longest_win_streak, cur_win_streak)
        longest_loss_streak = max(longest_loss_streak, cur_loss_streak)

    avg_r = sum(t["r_multiple"] for t in trades) / len(trades)

    return {
        "num_trades": len(trades),
        "win_rate": round(100.0 * len(wins) / len(trades), 1),
        "profit_factor": round(gross_profit / gross_loss, 2) if gross_loss > 0 else None,
        "avg_win_dollars": round(gross_profit / len(wins), 2) if wins else 0.0,
        "avg_loss_dollars": round(-gross_loss / len(losses), 2) if losses else 0.0,
        "avg_r": round(avg_r, 3),
        "expectancy_r": round(avg_r, 3),
        "net_pnl_dollars": round(equity, 2),
        "max_drawdown_dollars": round(max_dd, 2),
        "longest_win_streak": longest_win_streak,
        "longest_loss_streak": longest_loss_streak,
        "equity_curve": equity_curve,
    }
