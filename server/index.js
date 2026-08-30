const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const holdings = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'holdings.json'), 'utf-8')
);

// ---- simple in-memory cache ----
const cache = new Map();
function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  return null;
}
function cacheSet(key, v) {
  cache.set(key, { v, t: Date.now() });
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'ja,en;q=0.8',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// retry a few times with backoff; useful because Yahoo/CoinGecko
// occasionally answer a burst of requests with a transient 429/403
async function withRetry(fn, retries = 2, baseDelayMs = 350) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// run async jobs with a concurrency cap so we don't fire dozens of
// simultaneous requests at once (which tends to get rate-limited)
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return results;
}

// ---- Yahoo Finance chart (no API key) ----
const RANGE_PRESETS = {
  hour: { range: '5d', interval: '60m' },
  day: { range: '3mo', interval: '1d' },
  week: { range: '2y', interval: '1wk' },
  month: { range: '10y', interval: '1mo' },
  year: { range: 'max', interval: '3mo' },
};

function toYearEndPoints(points) {
  const byYear = new Map();
  const sorted = points
    .filter((p) => Number.isFinite(p.t) && p.c != null)
    .sort((a, b) => a.t - b.t);

  for (const point of sorted) {
    const year = new Date(point.t).getUTCFullYear();
    byYear.set(year, point);
  }
  return [...byYear.values()];
}

function pointsForTimeframe(points, timeframe) {
  return timeframe === 'year' ? toYearEndPoints(points) : points;
}

async function fetchYahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`yahoo chart ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no result');
  return result;
}

async function fetchQuote(symbol) {
  const cached = cacheGet('quote:' + symbol, 60_000);
  if (cached) return cached;

  const result = await withRetry(() => fetchYahooChart(symbol, '2mo', '1d'));
  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];

  const price = meta.regularMarketPrice;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose;
  const dayChangePct =
    price != null && previousClose ? ((price - previousClose) / previousClose) * 100 : null;

  let monthChangePct = null;
  const validPairs = timestamps
    .map((t, i) => ({ t, c: closes[i] }))
    .filter((p) => p.c != null);
  if (validPairs.length > 1) {
    const lastT = validPairs[validPairs.length - 1].t;
    const targetT = lastT - 30 * 24 * 3600;
    let best = validPairs[0];
    for (const p of validPairs) {
      if (p.t <= targetT) best = p;
    }
    const monthAgoClose = best.c;
    if (monthAgoClose) {
      monthChangePct = ((price - monthAgoClose) / monthAgoClose) * 100;
    }
  }

  const out = {
    symbol,
    price: price ?? null,
    currency: meta.currency ?? null,
    previousClose: previousClose ?? null,
    dayChangePct,
    monthChangePct,
    marketState: meta.marketState ?? null,
    asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
  };
  cacheSet('quote:' + symbol, out);
  return out;
}

app.get('/api/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) return res.json([]);

  const results = await mapWithConcurrency(symbols, 4, async (s) => {
    try {
      return await fetchQuote(s);
    } catch (e) {
      return { symbol: s, error: true };
    }
  });
  res.json(results);
});

// ---- crypto price: try several free/no-key sources in order ----
// CoinGecko's public API occasionally blocks requests from cloud-hosted
// IPs (Render, AWS, etc.), so we keep two backups: Binance.US and CoinCap.
const BINANCE_US_SYMBOL = {
  bitcoin: 'BTCUSD',
  ethereum: 'ETHUSD',
  'bitcoin-cash': 'BCHUSD',
  litecoin: 'LTCUSD',
  ripple: 'XRPUSD',
  stellar: 'XLMUSD',
  polkadot: 'DOTUSD',
  cosmos: 'ATOMUSD',
  cardano: 'ADAUSD',
  chainlink: 'LINKUSD',
  dogecoin: 'DOGEUSD',
  'shiba-inu': 'SHIBUSD',
  'matic-network': 'MATICUSD',
  binancecoin: 'BNBUSD',
  weth: 'ETHUSD',
  'pancakeswap-token': 'CAKEUSD',
};

const COINCAP_ID = {
  'matic-network': 'polygon',
  binancecoin: 'binance-coin',
  weth: 'wrapped-ether',
  'pancakeswap-token': 'pancakeswap',
};

async function getUsdJpyRate() {
  const cached = cacheGet('usdjpy', 3600_000);
  if (cached) return cached;
  try {
    const result = await fetchYahooChart('JPY=X', '5d', '1d');
    const rate = result.meta.regularMarketPrice;
    if (rate) cacheSet('usdjpy', rate);
    return rate ?? null;
  } catch (e) {
    return null;
  }
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

async function fetchCryptoMonthChangeFromBinanceUS(id) {
  const symbol = BINANCE_US_SYMBOL[id];
  if (!symbol) throw new Error('no binance.us symbol');
  const url = `https://api.binance.us/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=1d&limit=32`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`binance.us klines ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length < 31) throw new Error('binance.us month data missing');
  const current = Number(rows[rows.length - 1]?.[4]);
  const monthAgo = Number(rows[rows.length - 31]?.[4]);
  const change = pctChange(current, monthAgo);
  if (change == null) throw new Error('binance.us month change unavailable');
  return change;
}

async function fetchCryptoMonthChangeFromCoinCap(id) {
  const sourceId = COINCAP_ID[id] || id;
  const end = Date.now();
  const start = end - 35 * 86400_000;
  const url = `https://api.coincap.io/v2/assets/${encodeURIComponent(
    sourceId
  )}/history?interval=d1&start=${start}&end=${end}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coincap history ${r.status}`);
  const json = await r.json();
  const points = (json.data || [])
    .map((p) => ({ t: Number(p.time), c: Number(p.priceUsd) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) throw new Error('coincap month data missing');

  const latest = points[points.length - 1];
  const target = latest.t - 30 * 86400_000;
  let monthAgo = null;
  for (const point of points) {
    if (point.t <= target) monthAgo = point;
    else break;
  }
  if (!monthAgo) throw new Error('coincap month baseline missing');
  const change = pctChange(latest.c, monthAgo.c);
  if (change == null) throw new Error('coincap month change unavailable');
  return change;
}

async function fetchCryptoMonthChange(id) {
  try {
    return await fetchCryptoMonthChangeFromBinanceUS(id);
  } catch (e) {
    try {
      return await fetchCryptoMonthChangeFromCoinCap(id);
    } catch (e2) {
      return null;
    }
  }
}

async function fetchCryptoFromCoinGecko(ids) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=${encodeURIComponent(
    ids.join(',')
  )}&price_change_percentage=24h,30d`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const json = await r.json();
  const out = json.map((c) => ({
    id: c.id,
    symbol: c.symbol,
    price: c.current_price,
    currency: 'JPY',
    dayChangePct: c.price_change_percentage_24h_in_currency ?? null,
    monthChangePct: c.price_change_percentage_30d_in_currency ?? null,
    marketCap: c.market_cap ?? null,
    asOf: c.last_updated ? new Date(c.last_updated).getTime() : Date.now(),
  }));
  if (out.length === 0) throw new Error('coingecko empty');
  return out;
}

async function fetchCryptoOneFromBinanceUS(id) {
  const symbol = BINANCE_US_SYMBOL[id];
  if (!symbol) throw new Error('no binance.us symbol');
  const url = `https://api.binance.us/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`binance.us ${r.status}`);
  const c = await r.json();
  if (!c.lastPrice) throw new Error('binance.us empty');
  const usdJpy = await getUsdJpyRate();
  const priceUsd = Number(c.lastPrice);
  return {
    id,
    symbol: symbol.replace('USD', ''),
    price: usdJpy ? priceUsd * usdJpy : priceUsd,
    currency: usdJpy ? 'JPY' : 'USD',
    dayChangePct: c.priceChangePercent != null ? Number(c.priceChangePercent) : null,
    monthChangePct: null,
    marketCap: null,
    asOf: c.closeTime ? Number(c.closeTime) : Date.now(),
  };
}

async function fetchCryptoOneFromCoinCap(id) {
  const url = `https://api.coincap.io/v2/assets/${encodeURIComponent(id)}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coincap ${r.status}`);
  const json = await r.json();
  const c = json.data;
  if (!c || c.priceUsd == null) throw new Error('coincap empty');
  const usdJpy = await getUsdJpyRate();
  const priceUsd = Number(c.priceUsd);
  const capUsd = c.marketCapUsd != null ? Number(c.marketCapUsd) : null;
  return {
    id,
    symbol: c.symbol,
    price: usdJpy ? priceUsd * usdJpy : priceUsd,
    currency: usdJpy ? 'JPY' : 'USD',
    dayChangePct: c.changePercent24Hr != null ? Number(c.changePercent24Hr) : null,
    monthChangePct: null,
    marketCap: capUsd != null && usdJpy ? capUsd * usdJpy : capUsd,
    asOf: Date.now(),
  };
}

async function fetchCryptoOne(id) {
  const cached = cacheGet('crypto1:' + id, 60_000);
  if (cached) return cached;
  let out;
  try {
    out = (await fetchCryptoFromCoinGecko([id]))[0];
  } catch (e) {
    try {
      out = await fetchCryptoOneFromBinanceUS(id);
    } catch (e2) {
      try {
        out = await fetchCryptoOneFromCoinCap(id);
      } catch (e3) {
        out = { id, error: true };
      }
    }
  }
  if (out && !out.error && out.monthChangePct == null) {
    out.monthChangePct = await fetchCryptoMonthChange(id);
  }
  cacheSet('crypto1:' + id, out);
  return out;
}

app.get('/api/crypto', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return res.json([]);

  const cacheKey = 'crypto:' + ids.join(',');
  const cached = cacheGet(cacheKey, 60_000);
  if (cached) return res.json(cached);

  // fast path: one batched CoinGecko call covers everything
  try {
    const out = await withRetry(() => fetchCryptoFromCoinGecko(ids), 1, 500);
    if (out.length === ids.length) {
      cacheSet(cacheKey, out);
      return res.json(out);
    }
  } catch (e) {
    /* fall through to per-id resolution below */
  }

  // slow path: resolve each id independently so one bad/unlisted coin
  // doesn't take the rest down with it
  const out = await mapWithConcurrency(ids, 4, (id) => fetchCryptoOne(id));
  cacheSet(cacheKey, out);
  res.json(out);
});

// ---- price history for chart (stocks) ----
// timeframe: hour | day | week | month | year  (see RANGE_PRESETS)
app.get('/api/history', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const timeframe = RANGE_PRESETS[req.query.timeframe] ? req.query.timeframe : 'day';
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const cacheKey = `history:${symbol}:${timeframe}`;
  const cached = cacheGet(cacheKey, 5 * 60_000);
  if (cached) return res.json(cached);

  try {
    const { range, interval } = RANGE_PRESETS[timeframe];
    const result = await withRetry(() => fetchYahooChart(symbol, range, interval));
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    let points = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] }))
      .filter((p) => p.c != null);
    points = pointsForTimeframe(points, timeframe);
    const out = { symbol, timeframe, points };
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ---- price history for chart (crypto) ----
// timeframe: hour | day | week | month | year
const CRYPTO_DAYS = { hour: 1, day: 90, week: 365, month: 1825, year: 'max' };

async function fetchCryptoHistoryCoinGecko(id, days) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    id
  )}/market_chart?vs_currency=jpy&days=${days}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coingecko history ${r.status}`);
  const json = await r.json();
  return (json.prices || []).map(([t, c]) => ({ t, c }));
}

const BINANCE_US_KLINE_PRESET = {
  hour: { interval: '5m', limit: 288 },
  day: { interval: '1d', limit: 90 },
  week: { interval: '1d', limit: 365 },
  month: { interval: '1w', limit: 260 },
  year: { interval: '1M', limit: 1000 },
};

async function fetchCryptoHistoryBinanceUS(id, timeframe) {
  const symbol = BINANCE_US_SYMBOL[id];
  if (!symbol) throw new Error('no binance.us symbol');
  const { interval, limit } = BINANCE_US_KLINE_PRESET[timeframe];
  const url = `https://api.binance.us/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`binance.us klines ${r.status}`);
  const rows = await r.json();
  const usdJpy = await getUsdJpyRate();
  return rows.map((row) => ({
    t: row[6],
    c: usdJpy ? Number(row[4]) * usdJpy : Number(row[4]),
  }));
}

async function fetchCryptoHistoryCoinCap(id, days) {
  const end = Date.now();
  const start = days === 'max' ? Date.UTC(2009, 0, 1) : end - days * 86400_000;
  const interval = days <= 2 ? 'h1' : days <= 400 ? 'd1' : 'd1';
  const url = `https://api.coincap.io/v2/assets/${encodeURIComponent(
    id
  )}/history?interval=${interval}&start=${start}&end=${end}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coincap history ${r.status}`);
  const json = await r.json();
  const usdJpy = await getUsdJpyRate();
  return (json.data || []).map((p) => ({
    t: p.time,
    c: usdJpy ? Number(p.priceUsd) * usdJpy : Number(p.priceUsd),
  }));
}

app.get('/api/crypto-history', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const timeframe = CRYPTO_DAYS[req.query.timeframe] ? req.query.timeframe : 'day';
  if (!id) return res.status(400).json({ error: 'id required' });

  const cacheKey = `crypto-history:${id}:${timeframe}`;
  const cached = cacheGet(cacheKey, 5 * 60_000);
  if (cached) return res.json(cached);

  const days = CRYPTO_DAYS[timeframe];
  try {
    const rawPoints = await withRetry(() => fetchCryptoHistoryCoinGecko(id, days), 1, 500);
    const points = pointsForTimeframe(rawPoints, timeframe);
    const out = { id, timeframe, points };
    cacheSet(cacheKey, out);
    return res.json(out);
  } catch (e) {
    try {
      const rawPoints = await fetchCryptoHistoryBinanceUS(id, timeframe);
      const points = pointsForTimeframe(rawPoints, timeframe);
      const out = { id, timeframe, points };
      cacheSet(cacheKey, out);
      return res.json(out);
    } catch (e2) {
      try {
        const rawPoints = await fetchCryptoHistoryCoinCap(id, days);
        const points = pointsForTimeframe(rawPoints, timeframe);
        const out = { id, timeframe, points };
        cacheSet(cacheKey, out);
        return res.json(out);
      } catch (e3) {
        res.status(502).json({ error: String(e3) });
      }
    }
  }
});

app.get('/api/holdings', (req, res) => {
  res.json(holdings);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`portfolio-heatmap server listening on http://localhost:${PORT}`);
});

