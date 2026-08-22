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
};

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

// ---- crypto price: CoinGecko primary, CoinCap fallback (no API key) ----
async function fetchCryptoFromCoinGecko(ids) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=${encodeURIComponent(
    ids.join(',')
  )}&price_change_percentage=24h,30d`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const json = await r.json();
  return json.map((c) => ({
    id: c.id,
    symbol: c.symbol,
    price: c.current_price,
    currency: 'JPY',
    dayChangePct: c.price_change_percentage_24h_in_currency ?? null,
    monthChangePct: c.price_change_percentage_30d_in_currency ?? null,
  }));
}

async function fetchCryptoFromCoinCap(ids) {
  const url = `https://api.coincap.io/v2/assets?ids=${encodeURIComponent(ids.join(','))}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coincap ${r.status}`);
  const json = await r.json();
  const usdJpy = await getUsdJpyRate();
  return (json.data || []).map((c) => ({
    id: c.id,
    symbol: c.symbol,
    price: usdJpy ? Number(c.priceUsd) * usdJpy : Number(c.priceUsd),
    currency: usdJpy ? 'JPY' : 'USD',
    dayChangePct: c.changePercent24Hr != null ? Number(c.changePercent24Hr) : null,
    monthChangePct: null,
  }));
}

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

app.get('/api/crypto', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return res.json([]);

  const cacheKey = 'crypto:' + ids.join(',');
  const cached = cacheGet(cacheKey, 60_000);
  if (cached) return res.json(cached);

  try {
    const out = await withRetry(() => fetchCryptoFromCoinGecko(ids), 1, 500);
    cacheSet(cacheKey, out);
    return res.json(out);
  } catch (e) {
    // CoinGecko sometimes blocks cloud-hosted IPs; fall back to CoinCap
    try {
      const out = await fetchCryptoFromCoinCap(ids);
      cacheSet(cacheKey, out);
      return res.json(out);
    } catch (e2) {
      // degrade gracefully: mark each requested id as unavailable rather
      // than failing the whole request
      const out = ids.map((id) => ({ id, error: true }));
      return res.json(out);
    }
  }
});

// ---- Yahoo profile (sector / industry / business summary) ----
app.get('/api/profile', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const cacheKey = 'profile:' + symbol;
  const cached = cacheGet(cacheKey, 6 * 3600_000);
  if (cached) return res.json(cached);

  try {
    const out = await withRetry(async () => {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        symbol
      )}?modules=assetProfile,price`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error(`yahoo profile ${r.status}`);
      const json = await r.json();
      const result = json?.quoteSummary?.result?.[0];
      const profile = result?.assetProfile;
      const priceInfo = result?.price;
      if (!profile && !priceInfo) throw new Error('no profile');
      return {
        symbol,
        longName: priceInfo?.longName ?? priceInfo?.shortName ?? null,
        sector: profile?.sector ?? null,
        industry: profile?.industry ?? null,
        summary: profile?.longBusinessSummary ?? null,
        website: profile?.website ?? null,
        country: profile?.country ?? null,
      };
    });
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.json({ symbol, unavailable: true });
  }
});

// ---- price history for chart (stocks) ----
// timeframe: hour | day | week | month  (see RANGE_PRESETS)
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
    const points = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] }))
      .filter((p) => p.c != null);
    const out = { symbol, timeframe, points };
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ---- price history for chart (crypto) ----
// timeframe: hour | day | week | month
const CRYPTO_DAYS = { hour: 1, day: 90, week: 365, month: 1825 };

async function fetchCryptoHistoryCoinGecko(id, days) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    id
  )}/market_chart?vs_currency=jpy&days=${days}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`coingecko history ${r.status}`);
  const json = await r.json();
  return (json.prices || []).map(([t, c]) => ({ t, c }));
}

async function fetchCryptoHistoryCoinCap(id, days) {
  const end = Date.now();
  const start = end - days * 86400_000;
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
    const points = await withRetry(() => fetchCryptoHistoryCoinGecko(id, days), 1, 500);
    const out = { id, timeframe, points };
    cacheSet(cacheKey, out);
    return res.json(out);
  } catch (e) {
    try {
      const points = await fetchCryptoHistoryCoinCap(id, days);
      const out = { id, timeframe, points };
      cacheSet(cacheKey, out);
      return res.json(out);
    } catch (e2) {
      res.status(502).json({ error: String(e2) });
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
