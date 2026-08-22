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

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioHeatmap/0.1)' };

// ---- Yahoo Finance chart (no API key) ----
async function fetchQuote(symbol) {
  const cached = cacheGet('quote:' + symbol, 60_000);
  if (cached) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=2mo`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`yahoo chart ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no result');

  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];

  const price = meta.regularMarketPrice;
  const previousClose = meta.previousClose ?? meta.chartPreviousClose;
  const dayChangePct =
    price != null && previousClose ? ((price - previousClose) / previousClose) * 100 : null;

  // find a close ~30 days before the latest timestamp for month change
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

  const results = await Promise.all(
    symbols.map(async (s) => {
      try {
        return await fetchQuote(s);
      } catch (e) {
        return { symbol: s, error: true };
      }
    })
  );
  res.json(results);
});

// ---- CoinGecko (no API key) ----
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
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=${encodeURIComponent(
      ids.join(',')
    )}&price_change_percentage=24h,30d`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const json = await r.json();
    const out = json.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      price: c.current_price,
      currency: 'JPY',
      dayChangePct: c.price_change_percentage_24h_in_currency ?? null,
      monthChangePct: c.price_change_percentage_30d_in_currency ?? null,
    }));
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e) });
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
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol
    )}?modules=assetProfile,price`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`yahoo profile ${r.status}`);
    const json = await r.json();
    const result = json?.quoteSummary?.result?.[0];
    const profile = result?.assetProfile;
    const priceInfo = result?.price;
    if (!profile && !priceInfo) throw new Error('no profile');
    const out = {
      symbol,
      longName: priceInfo?.longName ?? priceInfo?.shortName ?? null,
      sector: profile?.sector ?? null,
      industry: profile?.industry ?? null,
      summary: profile?.longBusinessSummary ?? null,
      website: profile?.website ?? null,
      country: profile?.country ?? null,
    };
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.json({ symbol, unavailable: true });
  }
});

// ---- price history for chart (stocks) ----
app.get('/api/history', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const cacheKey = 'history:' + symbol;
  const cached = cacheGet(cacheKey, 5 * 60_000);
  if (cached) return res.json(cached);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=3mo`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`yahoo chart ${r.status}`);
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const points = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] }))
      .filter((p) => p.c != null);
    const out = { symbol, points };
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ---- price history for chart (crypto) ----
app.get('/api/crypto-history', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });

  const cacheKey = 'crypto-history:' + id;
  const cached = cacheGet(cacheKey, 5 * 60_000);
  if (cached) return res.json(cached);

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
      id
    )}/market_chart?vs_currency=jpy&days=90&interval=daily`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`coingecko history ${r.status}`);
    const json = await r.json();
    const points = (json.prices || []).map(([t, c]) => ({ t, c }));
    const out = { id, points };
    cacheSet(cacheKey, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.get('/api/holdings', (req, res) => {
  res.json(holdings);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`portfolio-heatmap server listening on http://localhost:${PORT}`);
});
