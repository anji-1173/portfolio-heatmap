let holdings = [];
let currentType = 'jp_stock';
let currentMetric = 'day';
let quoteData = new Map(); // key(symbol or id) -> quote info
let detailChart = null;

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
  const items = holdings.filter((h) => h.type === type && h.ticker);
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

function render() {
  detailPanel.classList.add('hidden');
  if (currentType === 'fund') {
    renderFundTable();
    return;
  }
  const items = holdings.filter((h) => h.type === currentType);
  heatmapEl.innerHTML = '';
  for (const h of items) {
    const tile = document.createElement('div');
    tile.className = 'tile loading';
    tile.dataset.key = h.ticker || h.name;
    tile.innerHTML = `
      <div class="symbol">${h.symbol || h.name}</div>
      <div class="name">${h.name}</div>
      <div class="pct">--</div>
    `;
    tile.addEventListener('click', () => openDetail(h));
    heatmapEl.appendChild(tile);
  }
  loadQuotesFor(currentType).then(paintTiles);
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
    const nameEl = tile.querySelector('.name');
    const pctEl = tile.querySelector('.pct');
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
  const items = holdings.filter((h) => h.type === 'fund');
  const rows = items
    .map(
      (h) => `<tr><td>${h.name}</td><td>${h.accounts.join(' / ')}</td></tr>`
    )
    .join('');
  heatmapEl.innerHTML = `
    <table class="fund-table">
      <tbody>${rows}</tbody>
    </table>
  `;
  statusEl.textContent = 'ファンドはリアルタイム価格の対象外です(一覧表示のみ)。';
}

async function openDetail(h) {
  detailPanel.classList.remove('hidden');
  const key = h.ticker || h.name;
  const q = quoteData.get(key);

  const priceText =
    q && q.price != null
      ? `${q.price.toLocaleString()} ${q.currency || ''}`
      : '価格取得不可';
  const dayPct = q?.dayChangePct;
  const monthPct = q?.monthChangePct;

  detailContent.innerHTML = `
    <h2>${h.name}</h2>
    <div class="sub">${h.symbol || ''} ・ ${h.accounts.join(' / ')}</div>
    <div class="price-row">${priceText}</div>
    <div class="change">
      前日比: ${dayPct != null ? (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%' : 'N/A'}
      ／ 月間比: ${monthPct != null ? (monthPct >= 0 ? '+' : '') + monthPct.toFixed(2) + '%' : 'N/A'}
    </div>
    <div class="section-title">値動き(直近)</div>
    <canvas id="detailChart"></canvas>
    <div class="section-title">企業概要</div>
    <div class="summary" id="profileText">${h.note || '読み込み中...'}</div>
  `;

  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }

  if (h.ticker) {
    loadChart(h);
    if (h.type !== 'crypto') loadProfile(h);
    else document.getElementById('profileText').textContent = '暗号資産のため企業概要はありません。';
  }
}

async function loadChart(h) {
  try {
    let points = [];
    if (h.type === 'crypto') {
      const r = await fetch(`/api/crypto-history?id=${encodeURIComponent(h.ticker)}`);
      const data = await r.json();
      points = data.points || [];
    } else {
      const r = await fetch(`/api/history?symbol=${encodeURIComponent(h.ticker)}`);
      const data = await r.json();
      points = data.points || [];
    }
    const ctx = document.getElementById('detailChart');
    if (!ctx || points.length === 0) return;
    detailChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map((p) => new Date(p.t).toLocaleDateString('ja-JP')),
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
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { ticks: { color: '#8a8f98' }, grid: { color: '#2a2e37' } },
        },
      },
    });
  } catch (e) {
    /* ignore */
  }
}

async function loadProfile(h) {
  const el = document.getElementById('profileText');
  try {
    const r = await fetch(`/api/profile?symbol=${encodeURIComponent(h.ticker)}`);
    const data = await r.json();
    if (data.unavailable || (!data.summary && !data.sector)) {
      el.textContent = '企業概要は取得できませんでした。';
      return;
    }
    const parts = [];
    if (data.sector) parts.push(`業種: ${data.sector}`);
    if (data.industry) parts.push(`分野: ${data.industry}`);
    if (data.summary) parts.push(data.summary);
    el.textContent = parts.join('\n\n');
  } catch (e) {
    el.textContent = '企業概要は取得できませんでした。';
  }
}

init();
