// strategy-presets.js
// Single source of truth for the built-in "named strategy" presets --
// the ones that used to only live inside backtester-ai.js's
// POPULAR_PRESETS. Loaded as a plain global (window.STRATEGY_PRESETS) by
// BOTH backtester.html (backtester-ai.js's "Configure with AI" chips) and
// live-trading.html (live-trading.js's Strategy dropdown), so editing
// this file and deploying is the only step needed to add/change/remove a
// preset everywhere it appears -- no button, no per-account save step,
// no Supabase row. See live-trading.js's loadStrategies() for how these
// get merged in alongside anything actually saved via the Backtester's
// "Save as Strategy" flow.
//
// Each entry's `config` is exactly what used to go straight into
// backtester.js's form (entry_mode + every backtest/live param the
// engine reads for that entry_mode). `blurb` is only used by the
// Backtester's chip UI; live-trading.js ignores it.
window.STRATEGY_PRESETS = [
  {
    // Ross Cameron / Warrior Trading's core "gap and go": scan for
    // small, cheap, thin-float-proxy stocks gapping big on volume, buy
    // the break of the first 5-minute candle's high, stop at that same
    // candle's low (the real chart level -- stop_mode "pattern", not a
    // guessed fixed price), move to breakeven fast, ride for 2R, bail
    // on the first stall bar.
    name: "Ross Cameron style gap-and-go breakout",
    blurb: "His bread-and-butter momentum play: scan for small, low-priced stocks gapping big on huge relative volume, buy the break of the first 5-minute candle's high at half size, stop at that candle's low, move to breakeven fast (15c). Adds the other half as it makes a new high, holds it for a couple bars, then breaks again -- never adds to a trade that isn't already working. No fixed target: a tightening trail-protect stop locks in more of the move the further it runs (30% of peak gain by half a risk-unit, 50% by 1R, 65% by 2R, 80% by 3R+), so even a trade that never quite reaches 1R before turning has already banked something rather than being able to round-trip all the way to a loss. Cut outright the instant it stalls. Position sized to risk exactly 1% of the account per trade -- his stated max-loss rule.",
    config: {
      entry_mode: "orb_breakout",
      top_n: 5, min_price: 1, max_price: 10, min_dollar_volume: 2000000, min_gap_pct: 10,
      starting_capital: 25000, position_sizing_mode: "risk_pct_of_capital", risk_pct_of_capital: 1,
      session_start: "09:30", flatten_time: "15:55", include_commissions: true, slippage_bps: 8,
      orb_minutes: 5, entry_after_orb: true,
      stop_mode: "pattern", breakeven_after_cents: 15,
      stall_exit: true,
      scale_in_enabled: true, scale_in_initial_size_pct: 50, scale_in_add_size_pct: 50,
      scale_in_max_adds: 1, scale_in_hold_bars: 2, scale_in_min_gain_cents: 10,
      trail_protect_enabled: true, trail_protect_ladder: [[0.5, 0.3], [1, 0.5], [2, 0.65], [3, 0.8]],
      allow_reentry: true, max_trades_per_day: 3, reentry_cooldown_minutes: 3,
    },
  },
  {
    // Ross Cameron's continuation/add-on entry on a stock that's already
    // moving: buy the reclaim of a pullback ("dip") to the 9 EMA.
    name: "Ross Cameron style 9 EMA dip & reclaim",
    blurb: "His continuation entry once a runner's already moving: after the initial pop, wait for a pullback to the 9 EMA, then buy the break back above that dip candle's high at half size. Stop sits exactly at the dip candle's low -- the real chart level, not a guessed fixed price. Adds the rest as it makes a new high and holds it before breaking again, then trails a tightening trail-protect stop instead of a fixed target (protecting some of the move from as early as half a risk-unit in profit, not just past 1R) -- same 1%-of-account risk cap and stall-exit rule as the breakout preset.",
    config: {
      entry_mode: "ema_dip_reclaim",
      top_n: 5, min_price: 1, max_price: 10, min_dollar_volume: 2000000, min_gap_pct: 10,
      starting_capital: 25000, position_sizing_mode: "risk_pct_of_capital", risk_pct_of_capital: 1,
      session_start: "09:30", flatten_time: "15:55", include_commissions: true, slippage_bps: 8,
      ema_period: 9, orb_minutes: 5, entry_after_orb: true,
      stop_mode: "pattern", breakeven_after_cents: 15,
      stall_exit: true,
      scale_in_enabled: true, scale_in_initial_size_pct: 50, scale_in_add_size_pct: 50,
      scale_in_max_adds: 1, scale_in_hold_bars: 2, scale_in_min_gain_cents: 10,
      trail_protect_enabled: true, trail_protect_ladder: [[0.5, 0.3], [1, 0.5], [2, 0.65], [3, 0.8]],
      allow_reentry: true, max_trades_per_day: 4, reentry_cooldown_minutes: 2,
    },
  },
  {
    name: "VWAP reclaim, ATR stop",
    blurb: "Buys the reclaim of session VWAP after a flush below it, with a volatility-adjusted ATR stop instead of a fixed one.",
    config: {
      entry_mode: "vwap_reclaim",
      top_n: 5, min_price: 2, max_price: 30, min_dollar_volume: 5000000, min_gap_pct: 8,
      starting_capital: 25000, position_sizing_mode: "pct_of_capital", position_size_pct: 10,
      session_start: "09:30", flatten_time: "15:55", include_commissions: true, slippage_bps: 5,
      orb_minutes: 5, entry_after_orb: true,
      stop_mode: "atr_multiple", atr_period: 14, atr_mult: 1.5,
      target_r: 3, giveback_pct: 30, giveback_arm_cents: 20,
      allow_reentry: true, max_trades_per_day: 3, reentry_cooldown_minutes: 5,
    },
  },
  {
    name: "Donchian breakout (20-bar)",
    blurb: "A rolling breakout instead of a fixed opening range -- buys the break of the highest high in the last 20 minutes, with a time stop to cut dead trades early.",
    config: {
      entry_mode: "donchian_break",
      top_n: 8, min_price: 3, max_price: 40, min_dollar_volume: 8000000, min_gap_pct: 5,
      starting_capital: 25000, position_sizing_mode: "fixed_dollars", position_size: 2500,
      session_start: "09:30", flatten_time: "15:55", include_commissions: true, slippage_bps: 5,
      donchian_lookback: 20, orb_minutes: 5, entry_after_orb: true,
      stop_mode: "pattern",
      target_r: 1.5, time_stop_minutes: 30, time_stop_min_gain_cents: 10,
      allow_reentry: true, max_trades_per_day: 3, reentry_cooldown_minutes: 5,
    },
  },
  {
    name: "RSI oversold bounce",
    blurb: "A mean-reversion play rather than a breakout -- buys the bounce once RSI climbs back above 30, with a wider percentage-based stop to give it room.",
    config: {
      entry_mode: "rsi_oversold_bounce",
      top_n: 5, min_price: 2, max_price: 30, min_dollar_volume: 5000000, min_gap_pct: 5,
      starting_capital: 25000, position_sizing_mode: "fixed_dollars", position_size: 2000,
      session_start: "09:30", flatten_time: "15:55", include_commissions: true, slippage_bps: 5,
      rsi_period: 14, rsi_oversold: 30, orb_minutes: 5, entry_after_orb: true,
      stop_mode: "fixed_pct", fixed_stop_pct: 2,
      target_r: 1, allow_reentry: true, max_trades_per_day: 3, reentry_cooldown_minutes: 5,
    },
  },
];
