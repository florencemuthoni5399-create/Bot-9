# v2.2 patch notes — EURUSD measurement stability

## Fixed in this build

- Added a resilient economic-news gate with:
  - the existing ForexFactory-compatible feed as primary;
  - Finance Calendar as an automatic fallback;
  - retries with backoff;
  - `Retry-After` support for HTTP 429 responses;
  - retention of the last successful calendar during temporary fetch failures;
  - fail-closed behavior when there has never been a successful calendar load or the cached calendar becomes stale.
- Kept `NEWS_FAIL_CLOSED=true` by default. A failed calendar must not silently permit trading.
- Added support for multiple common calendar response shapes and UTC timestamp fields.
- Added conservative EUR/USD currency inference for fallback calendar records when a source omits a direct currency field.
- Skip-reason counting now occurs at actual decision points instead of repeatedly every few seconds while the same gate is active.
- Confluence evaluation now occurs only on completed candles. Mid-candle ticks no longer inflate `WARMUP` or gate skip counters.
- Removed `CANDLE_TICKS=60` from the example configuration so the intended 5-minute time-based candles are used by default.
- Martingale remains disabled in MEASURE and hard-capped at 2 levels in TRADE.

## Important

The fallback calendar is provided by Finance Calendar. Its API documentation requests visible attribution when its data appears in an app; the dashboard therefore includes a small source link. See https://www.financecalendar.com/api/.

This build is for demo measurement. It does not guarantee profitability and should not be moved to a real account merely because the measurement report reaches its threshold.


## v2.2.1 — news refresh reliability fix

- Added a 15-second timeout to each news HTTP request so a hung primary/fallback request cannot block future refreshes.
- Changed news refresh scheduling from a fixed interval to a sequential refresh loop, preventing an in-flight request from permanently blocking the next scheduled refresh.
- A valid calendar response with zero matching EUR/USD events now counts as a successful refresh; the bot no longer becomes stale solely because the filtered result is empty.
- Failed refreshes still retain the previous good calendar and fail closed when that calendar becomes stale.
- Added `NEWS_REQUEST_TIMEOUT_MS` to `.env.example`.
- Kept 5-minute candles, MEASURE flat-$1 testing, fail-closed news protection, and the 2-level martingale cap unchanged.
