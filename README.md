# SynthTrade Pro — headless EURUSD server bot

This package implements the requested MEASURE/TRADE workflow for **EURUSD** (`frxEURUSD`). It keeps the martingale available in TRADE mode, hard-capped at **2 levels**, while making MEASURE a clean flat-stake experiment.

## Exact operating plan

- **Market:** EURUSD (`frxEURUSD`), not R75.
- **MEASURE (default):** flat **$1** stakes, **martingale disabled**, 08:00–17:00 UTC session gate, EUR/USD Medium+ news gate with a **30-minute pre/post blackout**, indicator confluence enabled, and measurement stops after **500 settled trades**.
- **500-trade report:** `measure_report.json` records win rate, actual average payout, breakeven %, EDGE, net profit, skip-reason counts, and per-hour UTC results.
- **EDGE:** `win rate − breakeven`. Breakeven is derived from the **actual average winning payout** observed in the 500-trade sample, rather than an assumed payout.
- **TRADE lock:** `BOT_MODE=TRADE` refuses to place trades unless a completed 500-trade EURUSD report exists with **EDGE >= +1.5%**.
- **TRADE martingale:** enabled if `MARTINGALE_ENABLED=true`, with a hard cap of **2 levels** (base stake, then one 2x recovery level by default). MEASURE never uses martingale.
- **Daily risk:** stops at **-3%** or **+1.5%** of the bot's reconstructed UTC day-start balance. A 3-loss circuit breaker remains in place.
- **Restart resilience:** on boot, measurement progress is reconstructed from `trades.log.jsonl` when a completed report is not already present. A completed 500-trade sample automatically writes `measure_report.json`.
- **News feed:** public ForexFactory/FairEconomy weekly JSON calendar; EUR/USD Medium+ events; 30 minutes before through 30 minutes after; refreshed hourly; fails closed when the calendar is unavailable/stale.
- **Indicator confluence:** enabled by default and uses EMA + ADX + ATR + RSI plus the configured Bollinger/VWAP filters.

## Important safety note

Start on a **demo** Deriv account. This is an automated trading program and the measurement gate is a statistical test, not a guarantee of future profitability. Do not switch to a real account merely because EDGE clears the threshold.

## Setup

1. Install Node.js 18+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `DERIV_APP_ID`, `DERIV_API_TOKEN`, and a strong `DASHBOARD_TOKEN`.
5. Keep `DERIV_ACCOUNT_TYPE=demo` while measuring.
6. Run `npm start`.

## Measurement report

The report contains fields including:

- `completed_trades`
- `win_rate_pct`
- `average_payout_pct`
- `breakeven_pct`
- `edge_pct`
- `net_profit`
- `total_stake`
- `skip_reasons`
- `hourly_session_split_utc`

For example, if the measured average winning payout is 180% of stake, breakeven is approximately 55.56%. If the sample win rate is 58%, EDGE is approximately +2.44 percentage points. The bot does the calculation from the actual sample rather than assuming 80%, 90%, or another payout.

## Files generated at runtime

- `trades.log.jsonl` — append-only settled-trade history used for restart reconstruction.
- `measure_report.json` — generated after 500 settled MEASURE trades.

## Dashboard

The status page shows mode, measurement progress, EDGE, breakeven, average payout, session/news gates, martingale status, daily realized P/L, skip-reason counts, and recent trades.

## Deployment

For a VPS/Render deployment, use the included `DEPLOY_NO_CODE.md` as appropriate. Never paste an API token into source code or commit `.env` to a public repository.
