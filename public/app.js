let holdings = [];
let currentType = 'jp_stock';
let currentMetric = 'day';
let quoteData = new Map(); // key(symbol or id) -> quote info
let detailChart = null;
let currentDetailHolding = null;
let currentTimeframe = 'day';

const heatmapEl = document.getElementById('heatmap');
const statusEl = document.getElementById('status');
const detailPanel = document.getElementById('detailPanel');
const detailContent = document.getElementById('detailContent');

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  currentType = btn.dataset.type;
  render();
});

document.getElementById('metricToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.metric');
  if (!btn) return;
  document.querySelectorAll('.metric').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  currentMetric = btn.dataset.metric;
  paintTiles();
});

document.getElementById('closeDetail').addEventListener('click', () => {
  detailPanel.classList.add('hidden');
});

async function init() {
  const res = await fetch('/api/holdings');
  holdings = await res.json();
  render();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadQuotesFor(type) {
  const items = holdings.filter(
    (h) => h.type === type && h.ticker && effectiveStatus(h) !== 'delisted'
  );
  if (items.length === 0) return;

  if (type === 'crypto') {
    const ids = [...new Set(items.map((h) => h.ticker))];
    statusEl.textContent = `価格取得中... (${ids.length}件)`;
    try {
      const r = await fetch(`/api/crypto?ids=${encodeURIComponent(ids.join(','))}`);
      const data = await r.json();
      for (const d of data) quoteData.set(d.id, d);
    } catch (e) {
      /* ignore */
    }
  } else {
    const symbols = [...new Set(items.map((h) => h.ticker))];
    statusEl.textContent = `価格取得中... (${symbols.length}件)`;
    const batches = chunk(symbols, 15);
    for (const batch of batches) {
      try {
        const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(batch.join(','))}`);
        const data = await r.json();
        for (const d of data) quoteData.set(d.symbol, d);
        paintTiles();
      } catch (e) {
        /* ignore */
      }
    }
  }
  statusEl.textContent = '';
}

// bigger companies/coins get a bigger box, like a classic market heatmap.
// Uses an approximate static market cap (USD) shipped with the holdings
// data rather than a live lookup, since every free live source for this
// turned out to be unreliable from a hosted server. Sized by rank within
// whichever group of tiles it's rendered alongside (see applySizeForTiles),
// on a log scale so a ~$2T name and a ~$300B name don't look the same.
// A holding marked 'merging' (e.g. a share-transfer integration) becomes
// 'delisted' on its delistDate, so the tile flips on its own that day.
function effectiveStatus(h) {
  if (!h.status) return null;
  if (h.status === 'merging' && h.delistDate) {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    if (today >= h.delistDate) return 'delisted';
  }
  return h.status;
}

const STATUS_LABEL = { merging: '統合予定', delisted: '上場廃止', sold: '売却済み' };

function createTile(h) {
  const tile = document.createElement('div');
  const status = effectiveStatus(h);
  tile.className = 'tile loading';
  tile.dataset.key = h.ticker || h.name;
  if (h.capUsdB) tile.dataset.cap = h.capUsdB;
  if (status) {
    tile.classList.add(`status-${status}`);
    tile.dataset.status = status;
  }
  tile.innerHTML = `
    <div class="tile-head">
      <span class="symbol">${h.symbol || h.name}</span>
      ${status ? `<span class="status-badge">${STATUS_LABEL[status]}</span>` : ''}
    </div>
    <div class="name">${h.name}</div>
    <div class="pct">${status === 'delisted' ? '取引終了' : '--'}</div>
  `;
  tile.addEventListener('click', () => openDetail(h));
  return tile;
}

// tile side length, in px, at the smallest/largest end of the scale
const MIN_TILE_W = 110;
const MIN_TILE_H = 74;
const MAX_TILE_W = 300;
const MAX_TILE_H = 200;

function applySizeForTiles(tiles) {
  const withCap = tiles
    .map((tile) => ({ tile, cap: parseFloat(tile.dataset.cap) }))
    .filter((t) => !Number.isNaN(t.cap) && t.cap > 0);
  tiles.forEach((tile) => {
    tile.style.width = '';
    tile.style.height = '';
    tile.classList.remove('size-boosted');
  });
  if (withCap.length < 2) return;

  // side length proportional to sqrt(cap) -> box AREA proportional to cap,
  // relative to the largest holding in this group. This is what a
  // conventional finance heatmap does: a company 10x the size of another
  // gets a visibly (not just marginally) bigger box, at the cost of most
  // small-caps rendering near the minimum size -- that's expected.
  const maxCap = Math.max(...withCap.map((t) => t.cap));

  withCap.forEach(({ tile, cap }) => {
    const scale = Math.sqrt(cap / maxCap); // 0..1
    const w = MIN_TILE_W + (MAX_TILE_W - MIN_TILE_W) * scale;
    const h = MIN_TILE_H + (MAX_TILE_H - MIN_TILE_H) * scale;
    tile.style.width = `${Math.round(w)}px`;
    tile.style.height = `${Math.round(h)}px`;
    if (scale >= 0.5) tile.classList.add('size-boosted');
  });
}

function render() {
  detailPanel.classList.add('hidden');
  if (currentType === 'fund') {
    renderFundTable();
    return;
  }
  if (currentType === 'sector') {
    renderBySector();
    return;
  }
  heatmapEl.classList.remove('stacked');
  const items = holdings.filter((h) => h.type === currentType);
  heatmapEl.innerHTML = '';
  const tiles = items.map((h) => {
    const tile = createTile(h);
    heatmapEl.appendChild(tile);
    return tile;
  });
  applySizeForTiles(tiles);
  loadQuotesFor(currentType).then(paintTiles);
}

function renderBySector() {
  const items = holdings.filter((h) => (h.type === 'jp_stock' || h.type === 'us_stock') && h.sector);
  const bySector = new Map();
  for (const h of items) {
    if (!bySector.has(h.sector)) bySector.set(h.sector, []);
    bySector.get(h.sector).push(h);
  }

  heatmapEl.classList.add('stacked');
  heatmapEl.innerHTML = '';
  for (const [sector, list] of [...bySector.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const section = document.createElement('div');
    section.className = 'sector-section';
    const title = document.createElement('div');
    title.className = 'sector-title';
    title.textContent = `${sector} (${list.length})`;
    const grid = document.createElement('div');
    grid.className = 'sector-heatmap';
    const tiles = list.map((h) => {
      const tile = createTile(h);
      grid.appendChild(tile);
      return tile;
    });
    applySizeForTiles(tiles);
    section.appendChild(title);
    section.appendChild(grid);
    heatmapEl.appendChild(section);
  }

  Promise.all([loadQuotesFor('jp_stock'), loadQuotesFor('us_stock')]).then(paintTiles);
}

function colorForPct(pct) {
  if (pct == null || Number.isNaN(pct)) return 'var(--flat)';
  const clamped = Math.max(-8, Math.min(8, pct));
  const t = Math.abs(clamped) / 8; // 0..1
  const lightness = 22 + (1 - t) * 10; // stronger change -> deeper color
  if (pct > 0) return `hsl(142, 60%, ${lightness}%)`;
  if (pct < 0) return `hsl(4, 65%, ${lightness}%)`;
  return 'var(--flat)';
}

function paintTiles() {
  const tiles = document.querySelectorAll('.tile');
  tiles.forEach((tile) => {
    const key = tile.dataset.key;
    const q = quoteData.get(key);
    const pctEl = tile.querySelector('.pct');
    if (tile.dataset.status === 'delisted') {
      tile.classList.remove('loading', 'nodata');
      tile.style.background = '';
      pctEl.textContent = '取引終了';
      return;
    }
    // sold: kept as history in its own color, never green/red, but the
    // price/change is still shown for reference
    if (tile.dataset.status === 'sold') {
      tile.classList.remove('loading', 'nodata');
      tile.style.background = '';
      const soldPct = q && !q.error ? (currentMetric === 'day' ? q.dayChangePct : q.monthChangePct) : null;
      pctEl.textContent = soldPct == null ? '' : `${soldPct >= 0 ? '+' : ''}${soldPct.toFixed(1)}%`;
      return;
    }
    if (!q || q.error) {
      tile.classList.add('nodata');
      tile.classList.remove('loading');
      pctEl.textContent = '取得不可';
      tile.style.background = '';
      return;
    }
    tile.classList.remove('loading', 'nodata');
    const pct = currentMetric === 'day' ? q.dayChangePct : q.monthChangePct;
    tile.style.background = colorForPct(pct);
    pctEl.textContent = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  });
}

function renderFundTable() {
  const items = holdings.filter((h) => h.type === 'fund' || h.type === 'bond');

  // group by the account (broker) that holds each fund
  const byAccount = new Map();
  for (const h of items) {
    for (const account of h.accounts) {
      if (!byAccount.has(account)) byAccount.set(account, []);
      byAccount.get(account).push(h);
    }
  }

  const rows = [...byAccount.entries()]
    .map(([account, funds]) => {
      const nameRows = funds
        .map((h) => {
          if (h.type === 'bond') {
            return `<tr>
            <td class="fund-name">${h.name}</td>
            <td class="fund-account">${account}</td>
            <td class="fund-account">債券(満期まで保有)</td>
          </tr>`;
          }
          const link = h.fundCode
            ? `https://finance.yahoo.co.jp/quote/${encodeURIComponent(h.fundCode)}/chart`
            : `https://www.google.com/search?q=${encodeURIComponent(`${h.name} 基準価額`)}`;
          const label = h.fundCode ? 'チャートを見る ↗' : '検索する ↗';
          return `<tr>
            <td class="fund-name">${h.name}</td>
            <td class="fund-account">${account}</td>
            <td class="fund-link"><a href="${link}" target="_blank" rel="noopener noreferrer">${label}</a></td>
          </tr>`;
        })
        .join('');
      return nameRows;
    })
    .join('');

  heatmapEl.innerHTML = `
    <p class="fund-intro">
      投資信託(ファンド)と債券は、株や暗号資産のようなリアルタイム価格を毎日は公表していないため、
      ここでは「何を」「どの口座で」保有しているかの一覧と、ファンドの基準価額のチャートへのリンクを表示しています。
    </p>
    <table class="fund-table">
      <thead>
        <tr><th>銘柄名</th><th>保有口座</th><th>詳細</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  statusEl.textContent = '';
}

async function openDetail(h) {
  detailPanel.classList.remove('hidden');
  currentDetailHolding = h;
  currentTimeframe = 'day';
  const key = h.ticker || h.name;
  const q = quoteData.get(key);

  const priceText =
    effectiveStatus(h) === 'delisted'
      ? '取引終了'
      : q && q.price != null
        ? `${q.price.toLocaleString()} ${q.currency || ''}`
        : '価格取得不可';
  const dayPct = q?.dayChangePct;
  const monthPct = q?.monthChangePct;
  const asOfText = q?.asOf
    ? new Date(q.asOf).toLocaleString('ja-JP', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  detailContent.innerHTML = `
    <h2>${h.name}</h2>
    <div class="sub">${h.symbol || ''} ・ ${h.accounts.join(' / ')}</div>
    ${
      effectiveStatus(h)
        ? `<div class="status-note status-${effectiveStatus(h)}">【${STATUS_LABEL[effectiveStatus(h)]}】${h.statusNote || ''}</div>`
        : ''
    }
    <div class="price-row">${priceText}</div>
    ${asOfText ? `<div class="as-of">${asOfText} 時点</div>` : ''}
    <div class="change">
      前日比: ${dayPct != null ? (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%' : 'N/A'}
      ／ 月間比: ${monthPct != null ? (monthPct >= 0 ? '+' : '') + monthPct.toFixed(2) + '%' : 'N/A'}
    </div>
    <div class="section-title">値動き</div>
    <div class="timeframe-toggle" id="timeframeToggle">
      <button class="timeframe" data-timeframe="hour">時間足</button>
      <button class="timeframe active" data-timeframe="day">日足</button>
      <button class="timeframe" data-timeframe="week">週足</button>
      <button class="timeframe" data-timeframe="month">月足</button>
      <button class="timeframe" data-timeframe="year">年足</button>
    </div>
    <canvas id="detailChart"></canvas>
    <div class="section-title">${h.type === 'crypto' ? 'この暗号資産について' : '企業概要'}</div>
    <div class="summary" id="profileText">${companyOverviewText(h)}</div>
    ${historyHtml(h)}
  `;

  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }

  if (h.ticker) {
    loadChart(h, currentTimeframe);
  }
}

// Purchase / dividend log from broker notices. Only dates and per-share
// figures (public info) are kept -- never share counts or amounts, since
// this repository is public.
function historyHtml(h) {
  const jp = (d) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  const rows = [];
  if (h.boughtOn) rows.push(`<li>${jp(h.boughtOn)} 購入</li>`);
  (h.dividends || []).forEach((d) => {
    const unit = d.currency === 'USD' ? '米ドル' : d.currency === 'JPY' ? '円' : d.currency;
    rows.push(
      `<li>${jp(d.payDate)} 配当 1株あたり ${d.perShare} ${unit}` +
        `${d.recordDate ? `(基準日 ${jp(d.recordDate)})` : ''}</li>`
    );
  });
  if (rows.length === 0) return '';
  return `<div class="section-title">取引・配当の記録</div><ul class="history-list">${rows.join('')}</ul>`;
}

// company overviews are shipped as static text in holdings.json rather
// than fetched live: Yahoo's endpoint for this needs a session
// cookie/crumb we don't have and was failing silently for every stock
function companyOverviewText(h) {
  const parts = [];
  if (h.type !== 'crypto' && h.sector) parts.push(`業種: ${h.sector}`);
  if (h.summary) parts.push(h.summary);
  else if (h.note) parts.push(h.note);
  return parts.length ? parts.join('\n\n') : '概要は未登録です。';
}

detailContent.addEventListener('click', (e) => {
  const btn = e.target.closest('.timeframe');
  if (!btn || !currentDetailHolding) return;
  document.querySelectorAll('.timeframe').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  currentTimeframe = btn.dataset.timeframe;
  loadChart(currentDetailHolding, currentTimeframe);
});

// Events to mark on a holding's price chart:
// - sale: the asset sheet is a monthly snapshot, so a sale is only known
//   to fall between soldAfter (last snapshot still holding it) and soldBy
//   (first snapshot without it); both are the same day when the exact
//   date is known (e.g. a buyout notice from the broker)
// - purchase: boughtOn, from a trade report
const MARKER_STYLE = {
  sell: { band: 'rgba(127,163,184,0.22)', line: '#7fa3b8', text: '#cfe0ec', edge: 'end' },
  buy: { band: 'rgba(79,209,197,0.18)', line: '#4fd1c5', text: '#bff3ee', edge: 'start' },
};

function windowMarker(points, timeframe, fromDate, toDate, kind, verb) {
  if (points.length === 0) return null;
  const startMs = Date.parse(`${fromDate}T00:00:00+09:00`);
  const endMs = Date.parse(`${toDate}T23:59:59+09:00`);
  const fmt = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const label = fromDate === toDate ? `${verb} ${fmt(fromDate)}` : `${verb} ${fmt(fromDate)}〜${fmt(toDate)}`;
  let from = -1;
  let to = -1;
  if (timeframe === 'year') {
    const y0 = new Date(startMs).getUTCFullYear();
    const y1 = new Date(endMs).getUTCFullYear();
    points.forEach((p, i) => {
      const y = new Date(p.t).getUTCFullYear();
      if (y >= y0 && y <= y1) {
        if (from < 0) from = i;
        to = i;
      }
    });
  } else {
    if (endMs < points[0].t) return { before: true, label, kind };
    points.forEach((p, i) => {
      if (p.t >= startMs && p.t <= endMs) {
        if (from < 0) from = i;
        to = i;
      }
    });
    if (from < 0) {
      // coarse bars (e.g. monthly) with none inside the window: mark the
      // bar that the window falls into, i.e. the first one after it starts
      const i = points.findIndex((p) => p.t >= startMs);
      if (i >= 0) from = to = i;
    }
  }
  return from < 0 ? null : { from, to, label, kind };
}

function chartMarkersFor(h, points, timeframe) {
  const out = [];
  if (h.status === 'sold' && h.soldAfter && h.soldBy) {
    out.push(windowMarker(points, timeframe, h.soldAfter, h.soldBy, 'sell', '売却'));
  }
  if (h.boughtOn) {
    out.push(windowMarker(points, timeframe, h.boughtOn, h.boughtOn, 'buy', '購入'));
  }
  return out.filter(Boolean);
}

const saleMarkerPlugin = {
  id: 'saleMarker',
  afterDatasetsDraw(chart, _args, opts) {
    const markers = (opts && opts.markers) || [];
    if (markers.length === 0) return;
    const { ctx, chartArea, scales } = chart;
    const { top, bottom, left, right } = chartArea;
    const x = scales.x;
    const n = chart.data.labels.length;
    const step = n > 1 ? Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0)) : 12;
    const half = Math.max(step / 2, 3);
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'top';
    markers.forEach((m, k) => {
      const st = MARKER_STYLE[m.kind];
      const ty = top + 4 + k * 15;
      if (m.before) {
        ctx.fillStyle = st.text;
        ctx.fillText(`◀ ${m.label}(この期間より前)`, left + 4, ty);
        return;
      }
      const x0 = Math.max(left, x.getPixelForValue(m.from) - half);
      const x1 = Math.min(right, x.getPixelForValue(m.to) + half);
      ctx.fillStyle = st.band;
      ctx.fillRect(x0, top, x1 - x0, bottom - top);
      const lx = st.edge === 'end' ? x1 : x0;
      ctx.strokeStyle = st.line;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx, top);
      ctx.lineTo(lx, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = st.text;
      const tw = ctx.measureText(m.label).width;
      const tx = x1 + 4 + tw > right ? x0 - 4 - tw : x1 + 4;
      ctx.fillText(m.label, Math.max(left, tx), ty);
    });
    ctx.restore();
  },
};

async function loadChart(h, timeframe) {
  try {
    let points = [];
    if (h.type === 'crypto') {
      const r = await fetch(
        `/api/crypto-history?id=${encodeURIComponent(h.ticker)}&timeframe=${timeframe}`
      );
      const data = await r.json();
      points = data.points || [];
    } else {
      const r = await fetch(
        `/api/history?symbol=${encodeURIComponent(h.ticker)}&timeframe=${timeframe}`
      );
      const data = await r.json();
      points = data.points || [];
    }
    const ctx = document.getElementById('detailChart');
    if (!ctx) return;
    if (detailChart) {
      detailChart.destroy();
      detailChart = null;
    }
    if (points.length === 0) return;
    const markers = chartMarkersFor(h, points, timeframe);

    // 年足 (yearly): one open/high/low/close candle per year, like a
    // brokerage's yearly chart -- not a line, since a line drawn through
    // one sparse point per year looks broken/misleading
    if (timeframe === 'year' && points.every((p) => p.o != null)) {
      const labels = points.map((p) => String(new Date(p.t).getUTCFullYear()));
      const up = (p) => p.c >= p.o;
      detailChart = new Chart(ctx, {
        type: 'bar',
        plugins: [saleMarkerPlugin],
        data: {
          labels,
          datasets: [
            {
              label: '値幅(高値-安値)',
              data: points.map((p) => [p.l, p.h]),
              backgroundColor: points.map((p) => (up(p) ? 'rgba(31,157,85,0.45)' : 'rgba(214,69,69,0.45)')),
              barThickness: 2,
              borderWidth: 0,
            },
            {
              label: '始値-終値',
              data: points.map((p) => [Math.min(p.o, p.c), Math.max(p.o, p.c)]),
              backgroundColor: points.map((p) => (up(p) ? 'rgba(31,157,85,0.9)' : 'rgba(214,69,69,0.9)')),
              barThickness: 14,
              borderWidth: 0,
            },
          ],
        },
        options: {
          plugins: { legend: { display: false }, saleMarker: { markers } },
          scales: {
            x: {
              grouped: false,
              ticks: { color: '#8a8f98', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
              grid: { display: false },
            },
            y: { ticks: { color: '#8a8f98' }, grid: { color: '#2a2e37' } },
          },
        },
      });
      return;
    }

    detailChart = new Chart(ctx, {
      type: 'line',
      plugins: [saleMarkerPlugin],
      data: {
        labels: points.map((p) => {
          const date = new Date(p.t);
          if (timeframe === 'hour') {
            return date.toLocaleString('ja-JP', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
            });
          }
          return date.toLocaleDateString('ja-JP');
        }),
        datasets: [
          {
            data: points.map((p) => p.c),
            borderColor: '#5b8def',
            backgroundColor: 'rgba(91,141,239,0.1)',
            pointRadius: 0,
            tension: 0.15,
            fill: true,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false }, saleMarker: { markers } },
        scales: {
          x: {
            display: true,
            ticks: { color: '#8a8f98', maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
            grid: { display: false },
          },
          y: { ticks: { color: '#8a8f98' }, grid: { color: '#2a2e37' } },
        },
      },
    });
  } catch (e) {
    /* ignore */
  }
}

init();
