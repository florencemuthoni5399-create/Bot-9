'use strict';

/**
 * SynthTrade Pro — headless server bot
 * ------------------------------------
 * Same connection flow, strategy, martingale, and risk logic as the browser
 * dashboard, but running as a plain Node.js process. No browser tab needed,
 * so nothing gets throttled or backgrounded.
 *
 * Run with: node bot.js
 * (See README.md for a plain VPS + pm2 setup, or DEPLOY_NO_CODE.md for a
 * zero-command-line deploy via GitHub + Render.)
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  appId: process.env.DERIV_APP_ID || '',
  apiToken: process.env.DERIV_API_TOKEN || '',
  accountType: (process.env.DERIV_ACCOUNT_TYPE || 'demo').toLowerCase(), // 'demo' | 'real'
  asset: process.env.ASSET || 'frxEURUSD',
  // MEASURE builds a 500-settled-trade evidence report; TRADE is locked
  // until that report shows EDGE >= the configured threshold.
  mode: (process.env.BOT_MODE || 'MEASURE').toUpperCase(),
  stake: Number(process.env.STAKE) || 1, // MEASURE uses flat $1 stakes; TRADE uses this as the martingale base stake
  // Contract duration. Supports Deriv's duration_unit values: t (ticks),
  // s (seconds), m (minutes), h (hours), d (days). Default changed from
  // 5 ticks (a few seconds) to 5 minutes — a much bigger expected price move
  // per contract, which makes execution lag/slippage comparatively tiny
  // rather than a large fraction of the outcome. DURATION_TICKS is still
  // read as a fallback for old configs that only set that.
  durationValue: Number(process.env.DURATION_VALUE) || Number(process.env.DURATION_TICKS) || 5,
  durationUnit: (process.env.DURATION_UNIT || 'm').toLowerCase(), // t | s | m | h | d
  // Currently the only contract type this bot places is Rise/Fall — Deriv's
  // API calls this CALL/PUT internally, they're the same product. This
  // variable exists so it's explicit and confirmable on Render rather than
  // buried in code, and so a typo or an attempt to switch to an unimplemented
  // type (e.g. Reset Call/Put) fails loudly at startup instead of silently
  // trading something other than what was intended.
  contractType: (process.env.CONTRACT_TYPE || 'RISEFALL').toUpperCase(),

  martingale: {
    enabled: String(process.env.MARTINGALE_ENABLED || 'true') === 'true',
    maxLevels: Math.min(2, Number(process.env.MARTINGALE_MAX_LEVELS) || 2),
    multiplier: Number(process.env.MARTINGALE_MULTIPLIER) || 2,
  },
  risk: {
    enabled: String(process.env.RISK_ENABLED || 'true') === 'true',
    maxDailyLossPct: Number(process.env.MAX_DAILY_LOSS_PCT) || 3,
    dailyWinTargetPct: Number(process.env.DAILY_WIN_TARGET_PCT) || 1.5,
    maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES) || 3,
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS) || 60,
  },

  session: {
    enabled: String(process.env.SESSION_GATE_ENABLED || 'true') === 'true',
    startUtc: Number(process.env.SESSION_START_UTC) || 8,
    endUtc: Number(process.env.SESSION_END_UTC) || 17,
  },

  news: {
    enabled: String(process.env.NEWS_GATE_ENABLED || 'true') === 'true',
    // Primary keeps compatibility with the original ForexFactory-compatible
    // feed. The fallback is a separate public calendar source so a temporary
    // 429/5xx from the primary cannot unnecessarily stop measurement.
    url: process.env.NEWS_FEED_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    fallbackUrl: process.env.NEWS_FALLBACK_FEED_URL || 'https://www.financecalendar.com/wp-json/fc/v1/calendar',
    currencies: (process.env.NEWS_CURRENCIES || 'EUR,USD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    impact: (process.env.NEWS_MIN_IMPACT || 'Medium').toLowerCase(),
    beforeMinutes: Number(process.env.NEWS_BLACKOUT_BEFORE_MIN) || 30,
    afterMinutes: Number(process.env.NEWS_BLACKOUT_AFTER_MIN) || 30,
    refreshMinutes: Math.max(5, Number(process.env.NEWS_REFRESH_MIN) || 60),
    failClosed: String(process.env.NEWS_FAIL_CLOSED || 'true') === 'true',
    retryCount: Math.max(0, Number(process.env.NEWS_RETRY_COUNT) || 2),
    retryBaseMs: Math.max(250, Number(process.env.NEWS_RETRY_BASE_MS) || 1000),
    requestTimeoutMs: Math.max(3000, Number(process.env.NEWS_REQUEST_TIMEOUT_MS) || 15000),
  },

  measurement: {
    targetTrades: 500,
    reportFile: path.join(__dirname, process.env.MEASURE_REPORT_FILE || 'measure_report.json'),
    edgeLockPct: Number(process.env.TRADE_EDGE_MIN_PCT) || 1.5,
  },

  // Indicator Confluence — opt-in alternative signal source. Off by default:
  // the original "last tick direction" signal keeps running until you
  // explicitly turn this on, so you can compare the two rather than losing
  // the old behavior outright.
  confluence: {
    enabled: String(process.env.INDICATOR_CONFLUENCE_ENABLED || 'true') === 'true',
    // Ticks are bucketed into candles of this many minutes; every indicator
    // below is computed from closed candles, not raw ticks. This is both
    // more standard (ADX/ATR are properly bar-based indicators) and far less
    // noisy than the previous tick-delta approximation.
    // True wall-clock candles are the default. CANDLE_TICKS is intentionally
    // opt-in only; leave it blank for a genuine 5-minute EURUSD bar.
    candleMinutes: Number(process.env.CANDLE_MINUTES) || 5,
    candleTicks: process.env.CANDLE_TICKS ? Number(process.env.CANDLE_TICKS) : null,
    emaShort: Number(process.env.EMA_SHORT) || 5,
    emaLong: Number(process.env.EMA_LONG) || 13,
    adxPeriod: Number(process.env.ADX_PERIOD) || 14,
    adxMin: Number(process.env.ADX_MIN) || 33,
    // Optional upper cap — off (null) unless explicitly set. When set, skips
    // trading if ADX is above this, on the theory that a very strong trend
    // may be overextended. This is a hypothesis, not a guarantee — see the
    // discussion before you enable it.
    adxMax: process.env.ADX_MAX ? Number(process.env.ADX_MAX) : null,
    atrPeriod: Number(process.env.ATR_PERIOD) || 14,
    atrAvgPeriod: Number(process.env.ATR_AVG_PERIOD) || 25,
    rsiPeriod: Number(process.env.RSI_PERIOD) || 9,
    rsiOverbought: Number(process.env.RSI_OVERBOUGHT) || 70,
    rsiOversold: Number(process.env.RSI_OVERSOLD) || 30,
    bollingerEnabled: String(process.env.BOLLINGER_ENABLED || 'true') === 'true',
    bbPeriod: Number(process.env.BB_PERIOD) || 20,
    bbDeviation: Number(process.env.BB_DEVIATION) || 2.5,
    vwapEnabled: String(process.env.VWAP_ENABLED || 'true') === 'true',
    vwapLookback: Number(process.env.VWAP_LOOKBACK) || 1,
  },

  // Render (and most PaaS hosts) inject their own PORT env var — always
  // respect that first so "no PORT set in dashboard" just works.
  port: Number(process.env.PORT) || 8787,
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
  // Execution floor: skip a trade attempt if the last measured round-trip
  // ping is worse than this, rather than trading blind on a degraded
  // connection. Set to 0 to disable. Uses the same ping already measured
  // every 20s for the dashboard — not a new probe, just a new gate on it.
  maxPingMs: process.env.MAX_PING_MS !== undefined ? Number(process.env.MAX_PING_MS) : 350,
};

if (!CONFIG.appId || !CONFIG.apiToken) {
  console.error('[FATAL] DERIV_APP_ID and DERIV_API_TOKEN must be set (see .env.example). Exiting.');
  process.exit(1);
}
if (CONFIG.contractType !== 'RISEFALL') {
  console.error(`[FATAL] CONTRACT_TYPE="${CONFIG.contractType}" is not implemented — only RISEFALL (Rise/Fall, i.e. Deriv's CALL/PUT) is currently supported. Set CONTRACT_TYPE=RISEFALL or remove the variable to use the default. Exiting rather than silently trading something unintended.`);
  process.exit(1);
}
if (!['t', 's', 'm', 'h', 'd'].includes(CONFIG.durationUnit)) {
  console.error(`[FATAL] DURATION_UNIT="${CONFIG.durationUnit}" is invalid — must be one of t, s, m, h, d. Exiting.`);
  process.exit(1);
}
if (!['MEASURE', 'TRADE'].includes(CONFIG.mode)) {
  console.error(`[FATAL] BOT_MODE="${CONFIG.mode}" is invalid — use MEASURE or TRADE.`);
  process.exit(1);
}
if (CONFIG.asset.toLowerCase() === 'r_75' || CONFIG.asset.toLowerCase() === 'r75') {
  console.error('[FATAL] R_75 is no longer the configured market. Use ASSET=frxEURUSD for EURUSD.');
  process.exit(1);
}
if (CONFIG.martingale.maxLevels > 2) CONFIG.martingale.maxLevels = 2;
if (CONFIG.measurement.edgeLockPct <= 0) {
  console.error('[FATAL] TRADE_EDGE_MIN_PCT must be greater than 0.');
  process.exit(1);
}
if (!CONFIG.dashboardToken) {
  console.warn('[WARN] DASHBOARD_TOKEN is not set — the status page will be unprotected. Set one in .env / dashboard env vars.');
}

const REST_BASE = 'https://api.derivws.com';
const LOG_FILE = path.join(__dirname, 'trades.log.jsonl');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  connectionState: 'disconnected', // disconnected | connecting | connected | authenticated | error
  account: null,                    // { accountId, balance, currency, accountType, status }
  currentPrice: 0,
  ticks: [],                        // recent prices, bounded
  trades: [],                       // recent trades, bounded (also appended to LOG_FILE)
  stats: { totalTrades: 0, wins: 0, losses: 0, netProfit: 0, winRate: 0 },
  pingMs: null,
  error: null,
  lastSkipReason: null,
  startedAt: Date.now(),
  mode: CONFIG.mode,
  measurement: {
    targetTrades: CONFIG.measurement.targetTrades,
    completedTrades: 0,
    wins: 0,
    losses: 0,
    netProfit: 0,
    totalStake: 0,
    edgePct: null,
    avgPayoutPct: null,
    breakevenPct: null,
    winningPayout: 0,
    winningStake: 0,
    reportReady: false,
    reportPath: CONFIG.measurement.reportFile,
    skipReasons: {},
    hourly: {},
  },
  news: {
    lastFetchAt: null,
    lastSuccessAt: null,
    error: null,
    source: null,
    events: [],
  },
};

let ws = null;
let reqIdCounter = 1;
const nextReqId = () => reqIdCounter++;

let lastTradeTime = 0;
let consecutiveLosses = 0;
let dailyNetProfit = 0;
let dayStartBalance = null;
let currentDayKey = new Date().toISOString().slice(0, 10);
let currentDayStartTs = Date.parse(`${currentDayKey}T00:00:00.000Z`);
let martingaleLevel = 0;
let cooldownUntil = 0;
let lastCooldownReason = '';
let openContractCount = 0;

const pendingByReqId = new Map();
const pendingByContractId = new Map();

let pingInterval = null;
let newsInterval = null;
let lastPingAt = 0;

function getUtcHour() {
  return new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
}

function sessionGateReason() {
  if (!CONFIG.session.enabled) return null;
  const hour = getUtcHour();
  if (CONFIG.session.startUtc <= CONFIG.session.endUtc) {
    if (hour < CONFIG.session.startUtc || hour >= CONFIG.session.endUtc) {
      return `Outside UTC session ${String(CONFIG.session.startUtc).padStart(2, '0')}:00–${String(CONFIG.session.endUtc).padStart(2, '0')}:00`;
    }
  } else if (hour < CONFIG.session.startUtc && hour >= CONFIG.session.endUtc) {
    return `Outside UTC session ${String(CONFIG.session.startUtc).padStart(2, '0')}:00–${String(CONFIG.session.endUtc).padStart(2, '0')}:00`;
  }
  return null;
}

function normalizeNewsImpact(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'high' || v.startsWith('high ')) return 'high';
  if (v === 'medium' || v.startsWith('medium ')) return 'medium';
  if (v === 'low' || v.startsWith('low ')) return 'low';
  return 'low';
}

function parseNewsTimestamp(event) {
  const raw = event?.time_utc ?? event?.date ?? event?.datetime ?? event?.timestamp ?? event?.time;
  if (typeof raw === 'number') {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return Number.isFinite(ms) ? ms : NaN;
  }
  const ms = Date.parse(String(raw || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function inferNewsCurrency(event) {
  const raw = String(
    event?.currency ?? event?.country ?? event?.country_code ?? event?.region ?? event?.market ?? ''
  ).trim().toUpperCase();
  if (raw === 'USD' || raw === 'US' || raw === 'USA' || raw === 'UNITED STATES' || raw === 'UNITED STATES OF AMERICA') return 'USD';
  if (raw === 'EUR' || raw === 'EU' || raw === 'EUROZONE' || raw === 'EURO AREA' || raw === 'EUROPE') return 'EUR';

  // Finance Calendar documents event names/titles but does not require a
  // currency field, so use conservative title inference for the two pair
  // currencies when the source omits one.
  const title = String(event?.title || event?.event || event?.name || '').toLowerCase();
  if (/\b(eurozone|euro area|european central bank|\becb\b|germany|france|italy|spain|eurostat)\b/.test(title)) return 'EUR';
  if (/\b(us|u\.s\.|united states|federal reserve|\bfed\b|american)\b/.test(title)) return 'USD';
  return '';
}

function normalizeNewsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.calendar)) return payload.calendar;
  if (payload?.next && typeof payload.next === 'object') return [payload.next];
  return [];
}

function buildFallbackNewsUrl() {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const impact = ['low', 'medium', 'high'].includes(CONFIG.news.impact) ? CONFIG.news.impact : 'high';
  return `${CONFIG.news.fallbackUrl}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&impact=${encodeURIComponent(impact)}&limit=500`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchNewsSource(url, label) {
  let lastError = null;
  for (let attempt = 0; attempt <= CONFIG.news.retryCount; attempt++) {
    let controller = null;
    let timeout = null;
    try {
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), CONFIG.news.requestTimeoutMs);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'SynthTrade-NewsGate/2.2.1',
          'Accept': 'application/json',
        },
      });
      if (!res.ok) {
        let waitMs = CONFIG.news.retryBaseMs * Math.pow(2, attempt);
        const retryAfterRaw = res.headers.get('retry-after');
        const retryAfter = Number(retryAfterRaw);
        if (Number.isFinite(retryAfter) && retryAfter >= 0) {
          waitMs = Math.min(15000, retryAfter * 1000);
        }
        throw new Error(`${label} HTTP ${res.status}${res.status === 429 ? `; retry in ${Math.ceil(waitMs / 1000)}s` : ''}`);
      }
      const payload = await res.json();
      return { payload, label };
    } catch (err) {
      lastError = err?.name === 'AbortError'
        ? new Error(`${label} request timed out after ${CONFIG.news.requestTimeoutMs}ms`)
        : err;
      if (attempt < CONFIG.news.retryCount) {
        const retryAfterMatch = String(lastError?.message || '').match(/retry in (\d+)s/i);
        const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1000 : null;
        const waitMs = retryAfterMs != null
          ? Math.min(15000, retryAfterMs)
          : Math.min(15000, CONFIG.news.retryBaseMs * Math.pow(2, attempt));
        log(`[NEWS] ${label} attempt ${attempt + 1} failed: ${lastError.message}; retrying in ${waitMs}ms`);
        await sleep(waitMs);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function refreshNews() {
  if (!CONFIG.news.enabled) return;
  if (refreshNews.inFlight) return;
  refreshNews.inFlight = true;
  state.news.lastFetchAt = new Date().toISOString();
  try {
    let source = null;
    const sources = [
      { url: CONFIG.news.url, label: 'primary calendar' },
      { url: buildFallbackNewsUrl(), label: 'Finance Calendar fallback' },
    ];
    const errors = [];
    for (const candidate of sources) {
      if (!candidate.url) continue;
      try {
        source = await fetchNewsSource(candidate.url, candidate.label);
        break;
      } catch (err) {
        errors.push(err.message);
        log(`[WARN] News source failed: ${err.message}`);
      }
    }
    if (!source) throw new Error(errors.join(' | ') || 'all news sources failed');

    const list = normalizeNewsList(source.payload);
    // A successful, parseable calendar response is a successful refresh even
    // when there are zero EUR/USD events in the requested window. Do not let
    // an empty filtered result make a healthy source look stale forever.
    if (!Array.isArray(list)) throw new Error(`${source.label} returned an invalid event list`);

    const minImpact = ['low', 'medium', 'high'].includes(CONFIG.news.impact) ? CONFIG.news.impact : 'high';
    const rank = { low: 1, medium: 2, high: 3 };
    const now = Date.now();
    const horizon = now + 8 * 24 * 60 * 60 * 1000;
    const events = list.map(event => ({
      timestamp: parseNewsTimestamp(event),
      currency: inferNewsCurrency(event),
      impact: normalizeNewsImpact(event?.impact),
      title: String(event?.title || event?.event || event?.name || 'Economic event'),
    })).filter(e => Number.isFinite(e.timestamp)
      && e.timestamp >= now - CONFIG.news.afterMinutes * 60000
      && e.timestamp <= horizon
      && CONFIG.news.currencies.includes(e.currency)
      && rank[e.impact] >= rank[minImpact])
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!events.length && list.length > 0) {
      log(`[NEWS] ${source.label} returned ${list.length} records but none matched EUR/USD ${minImpact}+ filters; treating the calendar response as fresh with zero matched events.`);
    }

    state.news.events = events;
    state.news.lastSuccessAt = new Date().toISOString();
    state.news.error = null;
    state.news.source = source.label;
    log(`[NEWS] ${source.label} refreshed ${state.news.events.length} EUR/USD ${minImpact}+ events from ${list.length} calendar records`);
  } catch (err) {
    state.news.error = err.message;
    log(`[WARN] News gate refresh failed; previous good calendar retained: ${err.message}`);
  } finally {
    refreshNews.inFlight = false;
  }
}

function newsGateReason() {
  if (!CONFIG.news.enabled) return null;
  if (!state.news.lastSuccessAt) {
    return CONFIG.news.failClosed ? 'News gate waiting for first successful calendar refresh' : null;
  }
  const now = Date.now();
  const staleMs = Math.max(CONFIG.news.refreshMinutes * 2, 15) * 60000;
  if (now - Date.parse(state.news.lastSuccessAt) > staleMs) {
    return CONFIG.news.failClosed ? 'News calendar is stale — trading locked' : null;
  }
  const active = state.news.events.find(e => now >= e.timestamp - CONFIG.news.beforeMinutes * 60000 && now <= e.timestamp + CONFIG.news.afterMinutes * 60000);
  return active ? `News blackout: ${active.currency} ${active.impact.toUpperCase()} — ${active.title}` : null;
}

function measurementMetrics() {
  const m = state.measurement;
  const winRatePct = m.completedTrades ? (m.wins / m.completedTrades) * 100 : 0;
  const avgPayoutRatio = m.winningStake > 0 ? m.winningPayout / m.winningStake : null;
  const breakevenPct = avgPayoutRatio && avgPayoutRatio > 1 ? (1 / avgPayoutRatio) * 100 : null;
  const edgePct = breakevenPct != null ? winRatePct - breakevenPct : null;
  return {
    winRatePct: Math.round(winRatePct * 100) / 100,
    avgPayoutPct: avgPayoutRatio != null ? Math.round(avgPayoutRatio * 10000) / 100 : null,
    breakevenPct: breakevenPct != null ? Math.round(breakevenPct * 100) / 100 : null,
    edgePct: edgePct != null ? Math.round(edgePct * 100) / 100 : null,
  };
}

function measurementEdgePct() {
  return measurementMetrics().edgePct;
}

function incrementSkipReason(reason) {
  if (!reason) return;
  let key = 'OTHER';
  const r = String(reason).toLowerCase();
  if (r.includes('outside utc session')) key = 'SESSION';
  else if (r.includes('news ' ) || r.includes('news gate') || r.includes('calendar')) key = 'NEWS';
  else if (r.includes('adx')) key = 'ADX';
  else if (r.includes('atr')) key = 'ATR';
  else if (r.includes('rsi')) key = 'RSI';
  else if (r.includes('bollinger')) key = 'BOLLINGER';
  else if (r.includes('vwap')) key = 'VWAP';
  else if (r.includes('ping')) key = 'PING';
  else if (r.includes('cooling')) key = 'COOLDOWN';
  else if (r.includes('daily loss')) key = 'DAILY_LOSS';
  else if (r.includes('daily profit')) key = 'DAILY_TARGET';
  else if (r.includes('consecutive losses')) key = 'CIRCUIT_BREAKER';
  else if (r.includes('warming')) key = 'WARMUP';
  else if (r.includes('trade locked')) key = 'TRADE_LOCK';
  state.measurement.skipReasons[key] = (state.measurement.skipReasons[key] || 0) + 1;
}

function recordHourlyTrade(trade, won, profit) {
  const hour = new Date(trade.time).getUTCHours();
  const key = String(hour).padStart(2, '0');
  if (!state.measurement.hourly[key]) state.measurement.hourly[key] = { trades: 0, wins: 0, losses: 0, netProfit: 0 };
  const h = state.measurement.hourly[key];
  h.trades++;
  if (won) h.wins++; else h.losses++;
  h.netProfit = Math.round((h.netProfit + profit) * 100) / 100;
}

function writeMeasureReport() {
  const m = state.measurement;
  const metrics = measurementMetrics();
  m.avgPayoutPct = metrics.avgPayoutPct;
  m.breakevenPct = metrics.breakevenPct;
  m.edgePct = metrics.edgePct;
  const report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    market: CONFIG.asset,
    mode: 'MEASURE',
    target_trades: m.targetTrades,
    completed_trades: m.completedTrades,
    wins: m.wins,
    losses: m.losses,
    win_rate_pct: metrics.winRatePct,
    average_payout_pct: metrics.avgPayoutPct,
    breakeven_pct: metrics.breakevenPct,
    edge_pct: metrics.edgePct,
    edge_method: 'win_rate_minus_breakeven_actual_average_payout',
    net_profit: Math.round(m.netProfit * 100) / 100,
    total_stake: Math.round(m.totalStake * 100) / 100,
    trade_lock_threshold_pct: CONFIG.measurement.edgeLockPct,
    trade_lock_passed: metrics.edgePct != null && metrics.edgePct >= CONFIG.measurement.edgeLockPct,
    measurement_stakes: 'flat $1 (martingale disabled)',
    martingale: { enabled_in_trade_mode: CONFIG.martingale.enabled, max_levels: 2, multiplier: CONFIG.martingale.multiplier },
    session_utc: `${String(CONFIG.session.startUtc).padStart(2, '0')}:00-${String(CONFIG.session.endUtc).padStart(2, '0')}:00`,
    news_gate: { enabled: CONFIG.news.enabled, currencies: CONFIG.news.currencies, minimum_impact: CONFIG.news.impact, blackout_before_min: CONFIG.news.beforeMinutes, blackout_after_min: CONFIG.news.afterMinutes },
    skip_reasons: m.skipReasons,
    hourly_session_split_utc: m.hourly,
  };
  fs.writeFileSync(CONFIG.measurement.reportFile, JSON.stringify(report, null, 2));
  m.reportReady = true;
  log(`[MEASURE] 500-trade report written: ${CONFIG.measurement.reportFile} | win-rate=${metrics.winRatePct}% breakeven=${metrics.breakevenPct ?? '—'}% EDGE=${metrics.edgePct ?? '—'}%`);
}

function loadMeasurementFromTradeLog() {
  if (!fs.existsSync(LOG_FILE)) return;
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const settled = [];
    for (const line of lines) {
      try {
        const t = JSON.parse(line);
        if (t && t.asset === CONFIG.asset && (t.result === 'win' || t.result === 'loss')) settled.push(t);
      } catch (_) {}
    }
    const sample = settled.slice(0, CONFIG.measurement.targetTrades);
    if (!sample.length) return;
    const m = state.measurement;
    m.completedTrades = sample.length;
    m.wins = sample.filter(t => t.result === 'win').length;
    m.losses = sample.length - m.wins;
    m.netProfit = sample.reduce((sum, t) => sum + Number(t.profit || 0), 0);
    m.totalStake = sample.reduce((sum, t) => sum + Number(t.stake || 0), 0);
    m.winningPayout = sample.filter(t => t.result === 'win').reduce((sum, t) => sum + Number(t.stake || 0) + Number(t.profit || 0), 0);
    m.winningStake = sample.filter(t => t.result === 'win').reduce((sum, t) => sum + Number(t.stake || 0), 0);
    m.hourly = {};
    for (const t of sample) recordHourlyTrade(t, t.result === 'win', Number(t.profit || 0));
    const metrics = measurementMetrics();
    m.avgPayoutPct = metrics.avgPayoutPct;
    m.breakevenPct = metrics.breakevenPct;
    m.edgePct = metrics.edgePct;
    if (m.completedTrades >= m.targetTrades) {
      writeMeasureReport();
    }
    log(`[MEASURE] reconstructed ${m.completedTrades}/${m.targetTrades} settled EURUSD trades from trades.log.jsonl`);
  } catch (e) {
    log(`[WARN] Could not reconstruct measurement from trades.log.jsonl: ${e.message}`);
  }
}

function loadMeasureReport() {
  let reportLoaded = false;
  try {
    const report = JSON.parse(fs.readFileSync(CONFIG.measurement.reportFile, 'utf8'));
    if (report.market === CONFIG.asset && report.schema_version >= 2 && report.edge_method === 'win_rate_minus_breakeven_actual_average_payout' && Number(report.completed_trades) >= CONFIG.measurement.targetTrades) {
      state.measurement.completedTrades = Number(report.completed_trades);
      state.measurement.wins = Number(report.wins) || 0;
      state.measurement.losses = Number(report.losses) || 0;
      state.measurement.netProfit = Number(report.net_profit) || 0;
      state.measurement.totalStake = Number(report.total_stake) || 0;
      state.measurement.avgPayoutPct = Number.isFinite(Number(report.average_payout_pct)) ? Number(report.average_payout_pct) : null;
      state.measurement.breakevenPct = Number.isFinite(Number(report.breakeven_pct)) ? Number(report.breakeven_pct) : null;
      state.measurement.edgePct = Number.isFinite(Number(report.edge_pct)) ? Number(report.edge_pct) : null;
      state.measurement.reportReady = true;
      state.measurement.skipReasons = report.skip_reasons || {};
      state.measurement.hourly = report.hourly_session_split_utc || {};
      reportLoaded = true;
    }
  } catch (_) {}
  if (!reportLoaded) loadMeasurementFromTradeLog();
}

// --- Candle aggregation (used only when confluence mode is on) ---
let currentCandle = null; // { start, open, high, low, close } (time mode) or { count, open, high, low, close } (tick mode)
const closedCandles = []; // bounded, oldest first
const MAX_CANDLES = 300;

function candleBucketStart(epochMs, minutes) {
  const bucketMs = minutes * 60 * 1000;
  return Math.floor(epochMs / bucketMs) * bucketMs;
}

// Feeds one tick into the candle aggregator. Returns the just-closed candle
// if this tick completed a bar, otherwise null. Supports two modes:
//   - Time-based: a new bar starts every `minutes` of wall-clock time.
//   - Tick-count-based (when tickBarSize is set): a new bar starts every
//     `tickBarSize` ticks, regardless of how long that takes.
function updateCandles(price, epochMs, minutes, tickBarSize) {
  if (tickBarSize) {
    if (!currentCandle) {
      currentCandle = { count: 1, open: price, high: price, low: price, close: price };
      return null;
    }
    currentCandle.count++;
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
    currentCandle.close = price;
    if (currentCandle.count >= tickBarSize) {
      const justClosed = currentCandle;
      closedCandles.push(justClosed);
      if (closedCandles.length > MAX_CANDLES) closedCandles.shift();
      currentCandle = null;
      return justClosed;
    }
    return null;
  }

  const bucketStart = candleBucketStart(epochMs, minutes);
  if (!currentCandle) {
    currentCandle = { start: bucketStart, open: price, high: price, low: price, close: price };
    return null;
  }
  if (bucketStart === currentCandle.start) {
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
    currentCandle.close = price;
    return null;
  }
  // New bucket — the previous candle is now final.
  const justClosed = currentCandle;
  closedCandles.push(justClosed);
  if (closedCandles.length > MAX_CANDLES) closedCandles.shift();
  currentCandle = { start: bucketStart, open: price, high: price, low: price, close: price };
  return justClosed;
}
let reconnectAttempt = 0;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function appendTradeLog(trade) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(trade) + '\n');
  } catch (e) {
    log('[WARN] Could not write trades.log.jsonl:', e.message);
  }
}

function resetDailyCountersIfNewDay() {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (todayKey !== currentDayKey) {
    log(`New day (${todayKey}) — resetting daily risk counters (was net=${dailyNetProfit.toFixed(2)})`);
    currentDayKey = todayKey;
    currentDayStartTs = Date.parse(`${todayKey}T00:00:00.000Z`);
    dailyNetProfit = 0;
    dayStartBalance = state.account?.balance ?? dayStartBalance;
  }
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getStake() {
  // MEASURE must be a clean flat-stake experiment. Martingale is reserved
  // for TRADE mode, while the configured maximum remains hard-capped at 2 levels.
  if (CONFIG.mode === 'MEASURE' || !CONFIG.martingale.enabled) return CONFIG.stake;
  return CONFIG.stake * Math.pow(CONFIG.martingale.multiplier, martingaleLevel);
}

// Returns null if trading is OK right now, or a plain-English reason why not
// (shown on the dashboard, same as the confluence engine's skip reasons).
function shouldTrade() {
  if (state.connectionState !== 'authenticated') return 'Not connected';
  if (openContractCount > 0) return 'Waiting for previous contract to settle';
  if (CONFIG.mode === 'MEASURE' && state.measurement.reportReady) return `MEASURE complete — 500-trade report ready (EDGE ${state.measurement.edgePct}%). Switch BOT_MODE=TRADE after review.`;
  if (CONFIG.mode === 'TRADE') {
    if (!state.measurement.reportReady) return `TRADE locked — 500-trade measure report not ready for ${CONFIG.asset}`;
    if (state.measurement.edgePct == null || state.measurement.edgePct < CONFIG.measurement.edgeLockPct) return `TRADE locked — EDGE ${state.measurement.edgePct ?? '—'}% < +${CONFIG.measurement.edgeLockPct}%`;
  }
  const sessionReason = sessionGateReason();
  if (sessionReason) return sessionReason;
  const newsReason = newsGateReason();
  if (newsReason) return newsReason;
  const now = Date.now();
  if (now < cooldownUntil) return `Cooling down${lastCooldownReason ? ` (${lastCooldownReason})` : ''}: ${Math.ceil((cooldownUntil - now) / 1000)}s left`;
  if (CONFIG.maxPingMs > 0 && state.pingMs != null && state.pingMs > CONFIG.maxPingMs) {
    return `Ping ${state.pingMs}ms exceeds execution floor of ${CONFIG.maxPingMs}ms — skipping until connection improves`;
  }
  if (!CONFIG.risk.enabled) return null;
  resetDailyCountersIfNewDay();
  const base = dayStartBalance ?? state.account?.balance ?? 0;
  const lossLimit = base * (CONFIG.risk.maxDailyLossPct / 100);
  const winTarget = base * (CONFIG.risk.dailyWinTargetPct / 100);
  if (lossLimit > 0 && dailyNetProfit <= -lossLimit) return `Daily loss stop reached (${dailyNetProfit.toFixed(2)} <= -${lossLimit.toFixed(2)}, ${CONFIG.risk.maxDailyLossPct}% of day-start balance)`;
  if (winTarget > 0 && dailyNetProfit >= winTarget) return `Daily profit target reached (${dailyNetProfit.toFixed(2)} >= ${winTarget.toFixed(2)}, ${CONFIG.risk.dailyWinTargetPct}% of day-start balance)`;
  return null;
}

function settleContract(pending, won, profit) {
  state.trades = state.trades.map(t =>
    t.id === pending.tradeId ? { ...t, result: won ? 'win' : 'loss', profit } : t
  );
  const settled = state.trades.find(t => t.id === pending.tradeId);
  if (settled) appendTradeLog(settled);

  if (won) {
    consecutiveLosses = 0;
    martingaleLevel = 0;
    dailyNetProfit += profit;
  } else {
    consecutiveLosses++;
    dailyNetProfit += profit;
    if (CONFIG.mode === 'TRADE' && CONFIG.martingale.enabled && martingaleLevel < CONFIG.martingale.maxLevels - 1) {
      martingaleLevel++;
    } else if (CONFIG.mode === 'TRADE') {
      martingaleLevel = 0;
      if (CONFIG.risk.enabled && CONFIG.risk.cooldownSeconds > 0) {
        cooldownUntil = Date.now() + CONFIG.risk.cooldownSeconds * 1000;
        lastCooldownReason = 'martingale sequence exhausted';
      }
    } else {
      // MEASURE is always flat-stake; no martingale progression or sequence cooldown.
      martingaleLevel = 0;
    }
    if (CONFIG.risk.enabled && consecutiveLosses >= CONFIG.risk.maxConsecutiveLosses) {
      const pauseSec = CONFIG.risk.cooldownSeconds > 0 ? CONFIG.risk.cooldownSeconds : 60;
      cooldownUntil = Date.now() + pauseSec * 1000;
      lastCooldownReason = `${CONFIG.risk.maxConsecutiveLosses} consecutive losses`;
      consecutiveLosses = 0; // reset now so trading resumes automatically once the cooldown timer passes
      log(`⚠️  MAX CONSECUTIVE LOSSES REACHED (${CONFIG.risk.maxConsecutiveLosses}). Pausing for ${pauseSec}s, then resuming automatically — this is no longer a permanent stop.`);
    }
  }

  if (CONFIG.mode === 'MEASURE' && !state.measurement.reportReady) {
    state.measurement.completedTrades++;
    state.measurement.totalStake += pending.stake;
    state.measurement.netProfit += profit;
    if (won) {
      state.measurement.wins++;
      state.measurement.winningPayout += pending.stake + profit;
      state.measurement.winningStake += pending.stake;
    } else {
      state.measurement.losses++;
    }
    state.measurement.edgePct = measurementEdgePct();
    recordHourlyTrade(settled || { time: new Date().toISOString() }, won, profit);
    if (state.measurement.completedTrades === CONFIG.measurement.targetTrades) writeMeasureReport();
  }

  state.stats.totalTrades++;
  if (won) state.stats.wins++;
  else state.stats.losses++;
  state.stats.netProfit = Math.round((state.stats.netProfit + profit) * 100) / 100;
  state.stats.winRate = state.stats.totalTrades > 0
    ? Math.round((state.stats.wins / state.stats.totalTrades) * 1000) / 10
    : 0;

  openContractCount = Math.max(0, openContractCount - 1);
  pendingByContractId.delete(pending.contractId);

  log(`Settled ${won ? 'WIN ' : 'LOSS'} | stake=$${pending.stake.toFixed(2)} profit=${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | net=$${state.stats.netProfit.toFixed(2)} | level=${martingaleLevel}`);
}

async function parseJsonSafe(res, step) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Deriv returned an unexpected response during ${step} (HTTP ${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// Indicator Confluence engine
// ---------------------------------------------------------------------------
// Ported from a separate build the user showed via screenshot, which used
// EMA + ADX + ATR + RSI (+ optional Bollinger Bands / VWAP) all agreeing
// before taking a trade. Now computed from real OHLC candles (ticks bucketed
// into CANDLE_MINUTES-minute bars) rather than raw tick deltas — this makes
// ADX/ATR proper bar-based calculations instead of an approximation, and
// filters out a lot of tick-level noise. Two honest caveats remain:
//
//   - "VWAP" needs real traded volume, which a synthetic index's tick feed
//     doesn't carry. This uses a rolling average of each candle's typical
//     price (H+L+C)/3 as a stand-in, not a true volume-weighted price.
//   - Bollinger Bands' role here (confirm trend direction vs price above/
//     below the middle band) is an interpretation, since the source screenshot
//     didn't specify its exact decision rule.
//
// This whole system is off by default (INDICATOR_CONFLUENCE_ENABLED=false).
// When off, none of this runs (and no candles are needed) — the original
// simple signal trades on raw ticks, unchanged.

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function stddev(values, period, meanVal) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const variance = slice.reduce((sum, v) => sum + (v - meanVal) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(closes.length - period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

const wilderSmooth = (arr, p) => {
  let smoothed = arr.slice(0, p).reduce((a, b) => a + b, 0);
  const out = [smoothed];
  for (let i = p; i < arr.length; i++) {
    smoothed = smoothed - smoothed / p + arr[i];
    out.push(smoothed);
  }
  return out;
};

// Real Wilder ADX from OHLC candles (standard formula — no more tick-delta
// approximation now that we have genuine bars).
function adx(candles, period) {
  const need = period * 2 + 2;
  if (candles.length < need) return null;

  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ) || 1e-9);
  }

  const smTR = wilderSmooth(tr, period);
  const smPlusDM = wilderSmooth(plusDM, period);
  const smMinusDM = wilderSmooth(minusDM, period);

  const dx = [];
  for (let i = 0; i < smTR.length; i++) {
    const plusDI = (smPlusDM[i] / smTR[i]) * 100;
    const minusDI = (smMinusDM[i] / smTR[i]) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }

  if (dx.length < period) return null;
  return dx.slice(dx.length - period).reduce((a, b) => a + b, 0) / period;
}

// Real ATR series from OHLC candles (true range using high/low/prev close).
function atrSeries(candles, period, count) {
  const out = [];
  for (let end = candles.length; end > candles.length - count && end > period; end--) {
    const window = candles.slice(end - period - 1, end);
    let sum = 0;
    for (let i = 1; i < window.length; i++) {
      const cur = window[i], prev = window[i - 1];
      sum += Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
    }
    out.unshift(sum / period);
  }
  return out;
}

function computeIndicators(candles, cfg) {
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  const emaShortVal = ema(closes, cfg.emaShort);
  const emaLongVal = ema(closes, cfg.emaLong);

  const adxVal = adx(candles, cfg.adxPeriod);

  const atrSeriesVals = atrSeries(candles, cfg.atrPeriod, cfg.atrAvgPeriod + 1);
  const atrLatest = atrSeriesVals.length ? atrSeriesVals[atrSeriesVals.length - 1] : null;
  const atrAvg = atrSeriesVals.length >= cfg.atrAvgPeriod
    ? atrSeriesVals.slice(atrSeriesVals.length - cfg.atrAvgPeriod).reduce((a, b) => a + b, 0) / cfg.atrAvgPeriod
    : null;

  const rsiVal = rsi(closes, cfg.rsiPeriod);

  const bbMid = cfg.bollingerEnabled ? sma(closes, cfg.bbPeriod) : null;
  const bbStd = bbMid != null ? stddev(closes, cfg.bbPeriod, bbMid) : null;

  // VWAP proxy — see caveat in the header comment above. Uses typical price
  // (H+L+C)/3 per candle, averaged over vwapLookback candles.
  let vwapProxy = null;
  if (cfg.vwapEnabled) {
    const lookback = Math.max(cfg.vwapLookback, 1);
    if (candles.length >= lookback) {
      const window = candles.slice(candles.length - lookback);
      const typicalSum = window.reduce((sum, c) => sum + (c.high + c.low + c.close) / 3, 0);
      vwapProxy = typicalSum / lookback;
    }
  }

  return { price, emaShortVal, emaLongVal, adxVal, atrLatest, atrAvg, rsiVal, bbMid, bbStd, vwapProxy };
}

// Returns { trade: bool, isCall: bool, reason: string, readings: {...} } —
// `reason` explains a pass/skip in plain terms, shown on the dashboard so
// "why isn't it trading" is never a mystery. Takes CLOSED candles only —
// the currently-forming candle is deliberately excluded so indicators never
// repaint mid-bar.
function evaluateConfluence(candles, cfg) {
  const ind = computeIndicators(candles, cfg);
  const readings = {
    ema: ind.emaShortVal != null ? `${ind.emaShortVal.toFixed(3)} / ${ind.emaLongVal?.toFixed(3) ?? '—'}` : '—',
    adx: ind.adxVal != null ? ind.adxVal.toFixed(1) : '—',
    atr: (ind.atrLatest != null && ind.atrAvg != null) ? `${ind.atrLatest.toFixed(4)} vs avg ${ind.atrAvg.toFixed(4)}` : '—',
    rsi: ind.rsiVal != null ? ind.rsiVal.toFixed(1) : '—',
    bb: ind.bbMid != null ? `mid ${ind.bbMid.toFixed(3)}` : 'off',
    vwap: ind.vwapProxy != null ? ind.vwapProxy.toFixed(3) : 'off',
  };

  if (ind.emaShortVal == null || ind.emaLongVal == null) {
    return { trade: false, isCall: null, reason: 'Warming up (collecting candles)', readings };
  }

  const isCall = ind.emaShortVal > ind.emaLongVal;

  if (ind.adxVal == null) return { trade: false, isCall: null, reason: 'Warming up (ADX)', readings };
  if (ind.adxVal < cfg.adxMin) return { trade: false, isCall, reason: `ADX ${ind.adxVal.toFixed(1)} < min ${cfg.adxMin} (no trend)`, readings };
  if (cfg.adxMax != null && ind.adxVal > cfg.adxMax) return { trade: false, isCall, reason: `ADX ${ind.adxVal.toFixed(1)} > max ${cfg.adxMax} (trend may be overextended)`, readings };

  if (ind.atrLatest == null || ind.atrAvg == null) return { trade: false, isCall: null, reason: 'Warming up (ATR)', readings };
  if (ind.atrLatest <= ind.atrAvg) return { trade: false, isCall, reason: 'ATR below average (too quiet)', readings };

  if (ind.rsiVal == null) return { trade: false, isCall: null, reason: 'Warming up (RSI)', readings };
  if (isCall && ind.rsiVal > cfg.rsiOverbought) return { trade: false, isCall, reason: `RSI ${ind.rsiVal.toFixed(1)} overbought, skipping RISE`, readings };
  if (!isCall && ind.rsiVal < cfg.rsiOversold) return { trade: false, isCall, reason: `RSI ${ind.rsiVal.toFixed(1)} oversold, skipping FALL`, readings };

  if (cfg.bollingerEnabled) {
    if (ind.bbMid == null) return { trade: false, isCall: null, reason: 'Warming up (Bollinger)', readings };
    if (isCall && ind.price <= ind.bbMid) return { trade: false, isCall, reason: 'Price below Bollinger mid, skipping RISE', readings };
    if (!isCall && ind.price >= ind.bbMid) return { trade: false, isCall, reason: 'Price above Bollinger mid, skipping FALL', readings };
  }

  if (cfg.vwapEnabled) {
    if (ind.vwapProxy == null) return { trade: false, isCall: null, reason: 'Warming up (VWAP)', readings };
    if (isCall && ind.price <= ind.vwapProxy) return { trade: false, isCall, reason: 'Price below VWAP proxy, skipping RISE', readings };
    if (!isCall && ind.price >= ind.vwapProxy) return { trade: false, isCall, reason: 'Price above VWAP proxy, skipping FALL', readings };
  }

  return { trade: true, isCall, reason: 'All enabled filters agree', readings };
}

// How many closed candles are needed before every indicator can produce a
// reading — shown on the dashboard so "why no signal yet" is never a mystery.
function candlesNeeded(cfg) {
  return Math.max(cfg.emaLong, cfg.adxPeriod * 2 + 2, cfg.atrPeriod + cfg.atrAvgPeriod, cfg.bbPeriod, cfg.rsiPeriod + 1);
}

function barUnitLabel(cfg) {
  return cfg.candleTicks ? `${cfg.candleTicks}-tick` : `${cfg.candleMinutes}m`;
}

let lastConfluenceReadings = null;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function connect() {
  if (shuttingDown) return;
  state.connectionState = 'connecting';
  state.error = null;
  log('Connecting to Deriv...');

  try {
    const accRes = await fetch(`${REST_BASE}/trading/v1/options/accounts`, {
      headers: { 'Deriv-App-ID': CONFIG.appId, 'Authorization': `Bearer ${CONFIG.apiToken}` },
    });
    const accJson = await parseJsonSafe(accRes, 'account lookup');
    if (!accRes.ok) {
      throw new Error(accJson?.errors?.[0]?.message || `Failed to fetch Deriv accounts (HTTP ${accRes.status})`);
    }
    const accounts = accJson.data || [];
    const match = accounts.find(a => a.account_type === CONFIG.accountType && a.status === 'active')
      ?? accounts.find(a => a.account_type === CONFIG.accountType);
    if (!match) {
      throw new Error(`No ${CONFIG.accountType} account found for this token/app ID`);
    }

    state.account = {
      accountId: match.account_id,
      balance: Number(match.balance) || 0,
      currency: match.currency,
      accountType: match.account_type,
      status: match.status,
    };
    if (dayStartBalance == null) {
      let todaysRealized = 0;
      try {
        if (fs.existsSync(LOG_FILE)) {
          for (const line of fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)) {
            try { const t = JSON.parse(line); if (t.asset === CONFIG.asset && Date.parse(t.time || '') >= currentDayStartTs && (t.result === 'win' || t.result === 'loss')) todaysRealized += Number(t.profit || 0); } catch (_) {}
          }
        }
      } catch (_) {}
      dailyNetProfit = Math.round(todaysRealized * 100) / 100;
      dayStartBalance = state.account.balance - dailyNetProfit;
    }
    log(`Account found: ${match.account_id} (${match.account_type}) balance=${match.currency} ${state.account.balance.toFixed(2)} | day-start=${dayStartBalance.toFixed(2)} | daily realized=${dailyNetProfit.toFixed(2)}`);

    const otpRes = await fetch(`${REST_BASE}/trading/v1/options/accounts/${match.account_id}/otp`, {
      method: 'POST',
      headers: { 'Deriv-App-ID': CONFIG.appId, 'Authorization': `Bearer ${CONFIG.apiToken}` },
    });
    const otpJson = await parseJsonSafe(otpRes, 'WebSocket session setup');
    if (!otpRes.ok) {
      throw new Error(otpJson?.errors?.[0]?.message || `Failed to obtain WebSocket session (HTTP ${otpRes.status})`);
    }
    const wsUrl = otpJson.data?.url;
    if (!wsUrl) throw new Error('Deriv did not return a WebSocket URL');

    ws = new WebSocket(wsUrl);
    state.connectionState = 'connected';

    pingInterval = setInterval(() => {
      lastPingAt = Date.now();
      send({ ping: 1, req_id: nextReqId() });
    }, 20000);

    ws.on('open', () => {
      reconnectAttempt = 0;
      state.connectionState = 'authenticated';
      log('WebSocket authenticated. Subscribing to balance + ticks...');
      send({ balance: 1, subscribe: 1, req_id: nextReqId() });
      send({ ticks: CONFIG.asset, subscribe: 1, req_id: nextReqId() });
    });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        log('[WARN] Non-JSON message from Deriv, ignoring.');
        return;
      }
      handleMessage(data);
    });

    ws.on('error', (err) => {
      log('[ERROR] WebSocket error:', err.message);
      state.error = err.message;
    });

    ws.on('close', (code, reason) => {
      state.connectionState = 'disconnected';
      if (pingInterval) clearInterval(pingInterval);
  if (newsInterval) clearInterval(newsInterval);
      log(`WebSocket closed (code=${code}${reason ? `, reason=${reason}` : ''}).`);
      scheduleReconnect();
    });
  } catch (e) {
    state.connectionState = 'error';
    state.error = e.message;
    log('[ERROR]', e.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (shuttingDown) return;
  reconnectAttempt++;
  const delayMs = Math.min(30000, 2000 * reconnectAttempt); // backoff up to 30s
  log(`Reconnecting in ${(delayMs / 1000).toFixed(0)}s (attempt ${reconnectAttempt})...`);
  setTimeout(connect, delayMs);
}

function handleMessage(data) {
  if (data.pong) {
    state.pingMs = Date.now() - lastPingAt;
    return;
  }

  if (data.error) {
    log('[Deriv error]', data.error.message);
    state.error = data.error.message;
    return;
  }

  if (data.balance) {
    const newBalance = Number(data.balance.balance) || 0;
    if (state.account) state.account.balance = newBalance;
    return;
  }

  if (data.tick) {
    const price = data.tick.quote;
    const epochMs = data.tick.epoch * 1000;
    state.currentPrice = price;
    state.ticks.push({ price, ts: epochMs });
    if (state.ticks.length > 300) state.ticks.shift();

    let justClosedCandle = null;
    if (CONFIG.confluence.enabled) {
      justClosedCandle = updateCandles(price, epochMs, CONFIG.confluence.candleMinutes, CONFIG.confluence.candleTicks);
    }

    const now = Date.now();
    const gateReason = shouldTrade();
    const evaluationDue = now - lastTradeTime > 3000;
    // A confluence decision only exists at a completed candle. Count gate
    // blocks once per candle rather than once every few seconds while the same
    // gate remains active. This makes the skip breakdown meaningful.
    const decisionPoint = !CONFIG.confluence.enabled || Boolean(justClosedCandle);
    if (gateReason !== null) {
      state.lastSkipReason = gateReason;
      if (evaluationDue && decisionPoint) incrementSkipReason(gateReason);
    }
    if (evaluationDue && gateReason === null && decisionPoint) {
      let isCall = null;
      let skipReason = null;

      if (CONFIG.confluence.enabled) {
        const needed = candlesNeeded(CONFIG.confluence);
        if (closedCandles.length < needed) {
          skipReason = `Warming up (collecting ${barUnitLabel(CONFIG.confluence)} bars: ${closedCandles.length}/${needed})`;
        } else {
          // Only evaluate right when a candle closes, so indicators are
          // computed from a stable, finished bar rather than repainting
          // mid-candle. Between closes there's nothing new to decide on.
          const result = evaluateConfluence(closedCandles, CONFIG.confluence);
          lastConfluenceReadings = result.readings;
          if (!result.trade) {
            skipReason = result.reason;
          } else {
            isCall = result.isCall;
          }
        }
      } else if (state.ticks.length >= 20) {
        const prices = state.ticks.map(t => t.price);
        isCall = prices[prices.length - 1] > prices[prices.length - 2];
      } else {
        skipReason = 'Warming up (not enough ticks yet)';
      }

      if (isCall !== null) {
        state.lastSkipReason = null;
        const stake = getStake();
        const level = martingaleLevel;
        const tradeId = crypto.randomUUID();
        const signalPrice = price;

        const trade = {
          id: tradeId,
          time: new Date().toISOString(),
          type: isCall ? 'RISE' : 'FALL',
          asset: CONFIG.asset,
          stake: Math.round(stake * 100) / 100,
          result: 'pending',
          profit: 0,
          level,
          signalPrice,
        };
        state.trades.unshift(trade);
        if (state.trades.length > 200) state.trades.length = 200;
        openContractCount += 1;

        const buyReqId = nextReqId();
        const buySentAt = Date.now();
        pendingByReqId.set(buyReqId, { tradeId, contractId: -1, stake, level, signalPrice, buySentAt });

        log(`Placing ${trade.type} $${trade.stake.toFixed(2)} (level ${level}) on ${CONFIG.asset} @ ${signalPrice}, duration ${CONFIG.durationValue}${CONFIG.durationUnit}`);

        send({
          buy: '1',
          price: stake,
          parameters: {
            underlying_symbol: CONFIG.asset,
            contract_type: isCall ? 'CALL' : 'PUT',
            duration: CONFIG.durationValue,
            duration_unit: CONFIG.durationUnit,
            currency: state.account?.currency || 'USD',
            basis: 'stake',
            amount: stake,
          },
          req_id: buyReqId,
        });

        lastTradeTime = now;
      }
      if (skipReason) {
        state.lastSkipReason = skipReason;
        incrementSkipReason(skipReason);
      }
    }
    return;
  }

  if (data.buy && data.req_id != null) {
    const pending = pendingByReqId.get(data.req_id);
    if (pending) {
      pendingByReqId.delete(data.req_id);
      const contractId = data.buy.contract_id;
      const latencyMs = Date.now() - pending.buySentAt;
      const entryPrice = Number(data.buy.buy_price_spot ?? data.buy.entry_spot);
      const resolved = { ...pending, contractId };
      pendingByContractId.set(contractId, resolved);

      state.trades = state.trades.map(t => t.id === pending.tradeId ? {
        ...t,
        latencyMs,
        ...(Number.isFinite(entryPrice) ? { entryPrice, slippage: Math.round((entryPrice - pending.signalPrice) * 100000) / 100000 } : {}),
      } : t);

      log(`Buy confirmed: contract=${contractId} latency=${latencyMs}ms`);
      send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1, req_id: nextReqId() });
    }
    return;
  }

  if (data.proposal_open_contract) {
    const poc = data.proposal_open_contract;
    const contractId = poc.contract_id;
    const pending = pendingByContractId.get(contractId);
    if (pending) {
      const entrySpot = Number(poc.entry_spot);
      if (Number.isFinite(entrySpot)) {
        state.trades = state.trades.map(t => (t.id === pending.tradeId && t.entryPrice == null) ? {
          ...t,
          entryPrice: entrySpot,
          slippage: Math.round((entrySpot - pending.signalPrice) * 100000) / 100000,
        } : t);
      }
      if (poc.is_sold) {
        const won = poc.status === 'won';
        const profit = Math.round(Number(poc.profit) * 100) / 100;
        settleContract(pending, won, profit);
        const subId = poc.subscription?.id || data.subscription?.id;
        if (subId) send({ forget: subId, req_id: nextReqId() });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal read-only status dashboard (no build step, single HTTP handler)
// ---------------------------------------------------------------------------
function renderDashboardHtml() {
  const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
  const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
  const rows = state.trades.slice(0, 30).map(t => `
    <tr>
      <td>${new Date(t.time).toLocaleTimeString()}</td>
      <td><span class="pill ${t.type === 'RISE' ? 'call' : 'put'}">${t.type}</span></td>
      <td>${t.asset}</td>
      <td class="num">$${t.stake.toFixed(2)}</td>
      <td class="num">${t.latencyMs != null ? t.latencyMs + 'ms' : '…'}${t.slippage != null ? `<div class="sub">${t.slippage >= 0 ? '+' : ''}${t.slippage.toFixed(3)}</div>` : ''}</td>
      <td class="center">${t.result === 'pending' ? '⏳' : t.result === 'win' ? '✅' : '❌'}</td>
      <td class="num ${t.result === 'pending' ? '' : t.profit >= 0 ? 'pos' : 'neg'}">${t.result === 'pending' ? '…' : (t.profit >= 0 ? '+' : '') + '$' + t.profit.toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SynthTrade Pro — Server Status</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0d1117; color:#e2e8f0; font-family: ui-monospace, monospace; margin:0; padding:16px; }
  h1 { font-size:15px; color:#2563eb; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:8px; margin-bottom:16px; }
  .card { background:#1c2128; border:1px solid #2a2f36; border-radius:8px; padding:10px; }
  .card .label { font-size:10px; color:#475569; }
  .card .value { font-size:16px; font-weight:600; }
  .pos { color:#22c55e; } .neg { color:#ef4444; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { text-align:left; color:#475569; font-weight:500; padding:6px 8px; border-bottom:1px solid #2a2f36; }
  td { padding:6px 8px; border-bottom:1px solid #2a2f36; }
  .num { text-align:right; } .center { text-align:center; }
  .sub { font-size:9px; color:#475569; }
  .pill { font-size:10px; padding:2px 6px; border-radius:4px; }
  .pill.call { background:rgba(37,99,235,0.2); color:#2563eb; }
  .pill.put { background:rgba(245,158,11,0.2); color:#f59e0b; }
  .status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .status-dot.ok { background:#22c55e; } .status-dot.bad { background:#ef4444; } .status-dot.mid { background:#f59e0b; }
</style></head>
<body>
  <h1>⚡ SYNTHTRADE PRO — headless server status (auto-refreshes every 5s)</h1>
  <div class="grid">
    <div class="card"><div class="label">CONNECTION</div><div class="value"><span class="status-dot ${state.connectionState === 'authenticated' ? 'ok' : state.connectionState === 'error' ? 'bad' : 'mid'}"></span>${state.connectionState}</div></div>
    <div class="card"><div class="label">ACCOUNT</div><div class="value">${state.account ? state.account.accountId + ' (' + state.account.accountType + ')' : '—'}</div></div>
    <div class="card"><div class="label">CONTRACT TYPE</div><div class="value">${CONFIG.contractType === 'RISEFALL' ? 'Rise/Fall' : CONFIG.contractType}</div></div>
    <div class="card"><div class="label">MODE</div><div class="value">${CONFIG.mode}</div></div>
    <div class="card"><div class="label">MEASURE EDGE</div><div class="value">${state.measurement.edgePct != null ? state.measurement.edgePct + '%' : '—'} / +${CONFIG.measurement.edgeLockPct}%</div><div class="sub">Breakeven: ${state.measurement.breakevenPct != null ? state.measurement.breakevenPct + '%' : '—'} | Avg payout: ${state.measurement.avgPayoutPct != null ? state.measurement.avgPayoutPct + '%' : '—'}</div></div>
    <div class="card"><div class="label">BALANCE</div><div class="value">${state.account ? state.account.currency + ' ' + state.account.balance.toFixed(2) : '—'}</div></div>
    <div class="card"><div class="label">PING</div><div class="value">${state.pingMs != null ? state.pingMs + 'ms' : '—'}</div></div>
    <div class="card"><div class="label">NET P/L</div><div class="value ${state.stats.netProfit >= 0 ? 'pos' : 'neg'}">${state.stats.netProfit >= 0 ? '+' : ''}$${state.stats.netProfit.toFixed(2)}</div></div>
    <div class="card"><div class="label">WIN RATE</div><div class="value">${state.stats.totalTrades > 0 ? state.stats.winRate + '%' : '—'} (${state.stats.wins}W/${state.stats.losses}L)</div></div>
    <div class="card"><div class="label">UPTIME</div><div class="value">${uptimeStr}</div></div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="label">GATES</div>
    <div class="sub">Session: ${CONFIG.session.enabled ? `${String(CONFIG.session.startUtc).padStart(2,'0')}:00–${String(CONFIG.session.endUtc).padStart(2,'0')}:00 UTC` : 'off'} &nbsp;|&nbsp; News: ${CONFIG.news.enabled ? `${CONFIG.news.impact}+ ±${CONFIG.news.beforeMinutes}/${CONFIG.news.afterMinutes}m` : 'off'} &nbsp;|&nbsp; Martingale: ${CONFIG.martingale.enabled ? `TRADE only, max ${CONFIG.martingale.maxLevels} levels` : 'off'}</div>
    <div class="sub" style="margin-top:4px;">News status: ${state.news.lastSuccessAt ? `updated ${state.news.lastSuccessAt}, ${state.news.events.length} relevant events loaded via ${state.news.source || 'calendar'}` : (state.news.error || 'waiting for refresh')}</div>
    <div class="sub" style="margin-top:4px;">Calendar source: <a href="https://www.financecalendar.com/api/" target="_blank" rel="noopener">Finance Calendar API</a> (fallback) &nbsp;|&nbsp; fail-closed: ${CONFIG.news.failClosed ? 'ON' : 'OFF'}</div>
    <div class="sub" style="margin-top:4px;">MEASURE: ${state.measurement.completedTrades}/${state.measurement.targetTrades} settled, flat $1, martingale off. Daily realized: ${dailyNetProfit.toFixed(2)} | day-start: ${dayStartBalance != null ? dayStartBalance.toFixed(2) : '—'}</div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="label">MEASUREMENT SKIPS</div>
    <div class="sub">${Object.entries(state.measurement.skipReasons).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}: ${v}`).join(' &nbsp;|&nbsp; ') || 'No skips recorded yet.'}</div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="label">STRATEGY MODE</div>
    <div class="value">${CONFIG.confluence.enabled ? `Indicator Confluence (${barUnitLabel(CONFIG.confluence)} bars: EMA+ADX+ATR+RSI` + (CONFIG.confluence.bollingerEnabled ? '+BB' : '') + (CONFIG.confluence.vwapEnabled ? '+VWAP' : '') + ')' : 'Simple (last tick direction)'}</div>
    <div class="sub" style="margin-top:4px;">Contract duration: ${CONFIG.durationValue}${CONFIG.durationUnit}</div>
    ${CONFIG.confluence.enabled ? (() => {
      const needed = candlesNeeded(CONFIG.confluence);
      const remaining = needed - closedCandles.length;
      if (remaining <= 0) return `<div class="sub" style="margin-top:4px;">Bars collected: ${closedCandles.length}/${needed} — ready</div>`;
      let etaStr = '';
      if (CONFIG.confluence.candleTicks && state.ticks.length >= 2) {
        const recent = state.ticks.slice(-50);
        const spanMs = recent[recent.length - 1].ts - recent[0].ts;
        const avgTickMs = spanMs / (recent.length - 1);
        const etaMin = (remaining * CONFIG.confluence.candleTicks * avgTickMs) / 60000;
        etaStr = ` (~${etaMin < 1 ? '<1' : Math.ceil(etaMin)} min more, based on current tick rate)`;
      } else if (!CONFIG.confluence.candleTicks) {
        etaStr = ` (~${Math.ceil(remaining * CONFIG.confluence.candleMinutes)} min more)`;
      }
      return `<div class="sub" style="margin-top:4px;">Bars collected: ${closedCandles.length}/${needed}${etaStr}</div>`;
    })() : ''}
    ${CONFIG.confluence.enabled && lastConfluenceReadings ? `
    <div class="sub" style="margin-top:6px;line-height:1.6;">
      EMA(${CONFIG.confluence.emaShort}/${CONFIG.confluence.emaLong}): ${lastConfluenceReadings.ema} &nbsp;|&nbsp;
      ADX(${CONFIG.confluence.adxPeriod}): ${lastConfluenceReadings.adx} (min ${CONFIG.confluence.adxMin}${CONFIG.confluence.adxMax != null ? `, max ${CONFIG.confluence.adxMax}` : ''}) &nbsp;|&nbsp;
      ATR: ${lastConfluenceReadings.atr} &nbsp;|&nbsp;
      RSI(${CONFIG.confluence.rsiPeriod}): ${lastConfluenceReadings.rsi}${CONFIG.confluence.bollingerEnabled ? ` &nbsp;|&nbsp; BB: ${lastConfluenceReadings.bb}` : ''}${CONFIG.confluence.vwapEnabled ? ` &nbsp;|&nbsp; VWAP≈: ${lastConfluenceReadings.vwap}` : ''}
    </div>` : ''}
    ${state.lastSkipReason && lastCooldownReason === `${CONFIG.risk.maxConsecutiveLosses} consecutive losses` && state.lastSkipReason.startsWith('Cooling down') ? `
    <div class="card" style="border-color:#f59e0b;background:rgba(245,158,11,0.1);margin-top:8px;">
      <div class="label" style="color:#f59e0b;">⚠️ CIRCUIT BREAKER: ${lastCooldownReason}</div>
      <div style="font-size:12px;margin-top:4px;">${state.lastSkipReason}</div>
      <div class="sub" style="margin-top:4px;">Resumes automatically once the timer runs out — no action needed.</div>
    </div>` : state.lastSkipReason ? `<div class="sub" style="margin-top:4px;color:#f59e0b;">Last skip: ${state.lastSkipReason}</div>` : ''}
  </div>
  ${state.error ? `<div class="card" style="border-color:#ef4444;margin-bottom:16px;"><div class="label neg">LAST ERROR</div><div>${state.error}</div></div>` : ''}
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Asset</th><th>Stake</th><th>Lag</th><th>Result</th><th>Profit</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#475569;padding:20px;">Waiting for trades...</td></tr>'}</tbody>
  </table>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/status.json') {
    const token = url.searchParams.get('token');
    if (CONFIG.dashboardToken && token !== CONFIG.dashboardToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state, dailyRisk: { netProfit: dailyNetProfit, dayStartBalance, maxDailyLossPct: CONFIG.risk.maxDailyLossPct, dailyWinTargetPct: CONFIG.risk.dailyWinTargetPct }, config: { asset: CONFIG.asset, mode: CONFIG.mode, sessionUtc: [CONFIG.session.startUtc, CONFIG.session.endUtc], newsGate: CONFIG.news.enabled, newsImpact: CONFIG.news.impact, newsBlackoutMinutes: [CONFIG.news.beforeMinutes, CONFIG.news.afterMinutes], martingaleMaxLevels: CONFIG.martingale.maxLevels, martingaleTradeOnly: true, tradeEdgeMinPct: CONFIG.measurement.edgeLockPct } }));
    return;
  }

  const token = url.searchParams.get('token');
  if (CONFIG.dashboardToken && token !== CONFIG.dashboardToken) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized. Append ?token=YOUR_DASHBOARD_TOKEN to the URL.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(renderDashboardHtml());
});

server.listen(CONFIG.port, () => {
  log(`Status dashboard listening on port ${CONFIG.port}${CONFIG.dashboardToken ? ' (token protected)' : ''}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown() {
  shuttingDown = true;
  log('Shutting down...');
  if (pingInterval) clearInterval(pingInterval);
  if (newsInterval) clearInterval(newsInterval);
  if (ws) ws.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
loadMeasureReport();
if (CONFIG.news.enabled) {
  // Run the refresh loop sequentially so a slow/hung HTTP request cannot
  // permanently block later refreshes. fetchNewsSource has its own timeout.
  const runNewsRefreshLoop = async () => {
    await refreshNews();
    if (!shuttingDown) {
      newsInterval = setTimeout(runNewsRefreshLoop, CONFIG.news.refreshMinutes * 60 * 1000);
    }
  };
  runNewsRefreshLoop();
}
log(`Starting SynthTrade Pro server bot — ${CONFIG.asset}, ${CONFIG.contractType === 'RISEFALL' ? 'Rise/Fall' : CONFIG.contractType}, mode=${CONFIG.mode}, stake $${CONFIG.stake}, martingale=${CONFIG.martingale.enabled ? `on/${CONFIG.martingale.maxLevels} levels` : 'off'}, account type: ${CONFIG.accountType}`);
connect();
