/**
 * EPSRI ETF Options Quant Terminal
 * Research-grade browser implementation: BSM, IV solver, Greeks, volatility estimators,
 * strategy payoff, stress testing, VaR proxy and data-adapter hooks for live JSON endpoints.
 */
(function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const CONTRACT_MULTIPLIER = 10000;
  const state = {
    symbol: '588000',
    expiry: '',
    strategy: 'straddle',
    chainFilter: 'all',
    charts: {},
    data: null
  };

  const ETF_DATA = {
    '588000': {
      name: '科创50ETF',
      spot: 0.982,
      changePct: 1.18,
      ivBase: 0.285,
      ivRank: 63,
      sector: ['半导体', 'AI算力', '高端制造', '硬科技'],
      keywords: ['科创50 ETF 期权', '588000 期权', '半导体 政策 科创50', 'AI 算力 ETF 资金流'],
      expiries: [28, 56, 91, 182],
      historySeed: 0.92
    },
    '159915': {
      name: '创业板ETF',
      spot: 1.842,
      changePct: -0.46,
      ivBase: 0.246,
      ivRank: 48,
      sector: ['新能源', '医药', '成长股', '风险偏好'],
      keywords: ['创业板 ETF 期权', '159915 期权', '新能源 创业板 波动率', '医药 成长股 ETF 资金流'],
      expiries: [32, 60, 95, 186],
      historySeed: 1.78
    }
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 3) => Number.isFinite(n) ? n.toFixed(d) : '--';
  const pct = (n, d = 1) => Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '--';
  const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function seededRandom(seedText) {
    let seed = 2166136261;
    for (let i = 0; i < seedText.length; i += 1) seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619);
    return function next() {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function erf(x) {
    const sign = x >= 0 ? 1 : -1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const z = Math.abs(x);
    const t = 1 / (1 + p * z);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return sign * y;
  }

  function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  function bsm(type, s, k, t, r, q, vol) {
    const sigma = Math.max(vol, 1e-5);
    const tau = Math.max(t, 1e-6);
    const sqrtT = Math.sqrt(tau);
    const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * tau) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const dfR = Math.exp(-r * tau);
    const dfQ = Math.exp(-q * tau);
    const call = s * dfQ * normCdf(d1) - k * dfR * normCdf(d2);
    const put = k * dfR * normCdf(-d2) - s * dfQ * normCdf(-d1);
    const price = type === 'call' ? call : put;
    const delta = type === 'call' ? dfQ * normCdf(d1) : dfQ * (normCdf(d1) - 1);
    const gamma = dfQ * normPdf(d1) / (s * sigma * sqrtT);
    const vega = s * dfQ * normPdf(d1) * sqrtT / 100;
    const thetaCall = (-s * dfQ * normPdf(d1) * sigma / (2 * sqrtT) - r * k * dfR * normCdf(d2) + q * s * dfQ * normCdf(d1)) / 365;
    const thetaPut = (-s * dfQ * normPdf(d1) * sigma / (2 * sqrtT) + r * k * dfR * normCdf(-d2) - q * s * dfQ * normCdf(-d1)) / 365;
    const rho = (type === 'call' ? k * tau * dfR * normCdf(d2) : -k * tau * dfR * normCdf(-d2)) / 100;
    const vanna = -dfQ * normPdf(d1) * d2 / sigma;
    const volga = s * dfQ * normPdf(d1) * sqrtT * d1 * d2 / sigma / 100;
    return { price, delta, gamma, vega, theta: type === 'call' ? thetaCall : thetaPut, rho, d1, d2, vanna, volga };
  }

  function impliedVol(type, target, s, k, t, r, q) {
    let lo = 0.01, hi = 2.5;
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      const px = bsm(type, s, k, t, r, q, mid).price;
      if (px > target) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  function expiryDate(days) {
    const d = new Date(Date.now() + days * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  function makeHistory(seed, symbol) {
    const rows = [];
    let close = seed;
    for (let i = 180; i >= 0; i -= 1) {
      const wave = Math.sin(i / 8 + symbol.charCodeAt(0)) * 0.006 + Math.cos(i / 17) * 0.004;
      const drift = symbol === '588000' ? 0.00045 : 0.00022;
      close = Math.max(0.2, close * (1 + drift + wave));
      const range = close * (0.012 + Math.abs(Math.sin(i / 11)) * 0.01);
      rows.push({
        date: new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10),
        open: close * (1 - wave / 2),
        high: close + range,
        low: Math.max(0.1, close - range * 0.86),
        close
      });
    }
    return rows;
  }

  function generateChain(base, r, q) {
    const strikes = [-0.18, -0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12, 0.18].map(x => Number((base.spot * (1 + x)).toFixed(3)));
    const rows = [];
    base.expiries.forEach((days, expiryIndex) => {
      const t = days / 365;
      strikes.forEach((strike, strikeIndex) => {
        ['call', 'put'].forEach(type => {
          const moneyness = Math.log(strike / base.spot);
          const skew = type === 'put' ? -0.055 * moneyness : -0.025 * moneyness;
          const smile = 0.95 * moneyness * moneyness;
          const term = 0.018 * Math.log1p(days / 30);
          const vol = clamp(base.ivBase + skew + smile + term, 0.08, 0.88);
          const theoretical = bsm(type, base.spot, strike, t, r, q, vol).price;
          const noise = 1 + Math.sin((strikeIndex + 1) * (expiryIndex + 2) * (type === 'call' ? 1.7 : 2.1)) * 0.045;
          const mid = Math.max(0.001, theoretical * noise);
          const spread = Math.max(0.001, mid * (0.03 + Math.abs(moneyness) * 0.16));
          const volume = Math.round((3200 / (1 + Math.abs(moneyness) * 18)) * (1 + expiryIndex * 0.12) * (type === 'put' ? 0.92 : 1.08));
          const openInterest = Math.round((9000 / (1 + Math.abs(moneyness) * 11)) * (1 + expiryIndex * 0.28) * (type === 'put' ? 1.18 : 1));
          const iv = impliedVol(type, mid, base.spot, strike, t, r, q);
          const greeks = bsm(type, base.spot, strike, t, r, q, iv);
          const parityGap = type === 'call'
            ? Math.abs(mid - (theoretical + Math.sin(strikeIndex + expiryIndex) * 0.0015))
            : Math.abs(mid - theoretical);
          rows.push({
            code: `${base.code || ''}${expiryDate(days).replaceAll('-', '').slice(2)}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(4, '0')}`,
            type, expiry: expiryDate(days), days, strike, bid: mid - spread / 2, ask: mid + spread / 2, mid,
            theoretical, volume, openInterest, iv, ...greeks,
            liquidity: volume / 3000 + openInterest / 10000 - spread / Math.max(mid, 0.001),
            deviation: (mid - theoretical) / Math.max(theoretical, 0.001),
            parityGap
          });
        });
      });
    });
    return rows;
  }

  function getRates() {
    return { r: Number($('riskFreeRate').value || 0) / 100, q: Number($('dividendYield').value || 0) / 100 };
  }

  function buildSample(symbol) {
    const { r, q } = getRates();
    const base = { ...ETF_DATA[symbol], code: symbol };
    return { ...base, history: makeHistory(base.historySeed, symbol), options: generateChain(base, r, q), timestamp: new Date().toLocaleString('zh-CN') };
  }

  function snapshotUrl() {
    return window.location.pathname.includes('/pages/') ? '../data/options-market.json' : 'data/options-market.json';
  }

  async function loadSnapshot(symbol) {
    try {
      const res = await fetch(`${snapshotUrl()}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bundle = await res.json();
      const payload = bundle.symbols && bundle.symbols[symbol];
      if (!payload) throw new Error('snapshot symbol missing');
      const sample = buildSample(symbol);
      const hasOptions = Array.isArray(payload.options) && payload.options.length;
      const hasHistory = Array.isArray(payload.history) && payload.history.length;
      return {
        ...sample,
        ...payload,
        spot: Number(payload.spot || sample.spot),
        changePct: Number(payload.changePct || 0),
        history: hasHistory ? payload.history : sample.history,
        options: hasOptions ? normalizeExternalOptions(payload, sample) : sample.options,
        timestamp: payload.timestamp || bundle.generatedAt || new Date().toLocaleString('zh-CN'),
        snapshotGeneratedAt: bundle.generatedAt,
        mode: hasOptions ? 'CRAWLED_SNAPSHOT' : 'SNAPSHOT_PARTIAL'
      };
    } catch (error) {
      console.info('[EPSRI options] static snapshot unavailable:', error.message);
      return null;
    }
  }

  async function loadData(symbol) {
    const endpoint = localStorage.getItem('epsriOptionsEndpoint');
    if (endpoint) {
      try {
        const url = endpoint.replace('{symbol}', encodeURIComponent(symbol));
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const sample = buildSample(symbol);
        return {
          ...sample,
          ...json,
          spot: Number(json.spot || sample.spot),
          changePct: Number(json.changePct || 0),
          history: Array.isArray(json.history) && json.history.length ? json.history : sample.history,
          options: Array.isArray(json.options) && json.options.length ? normalizeExternalOptions(json, sample) : sample.options,
          timestamp: json.timestamp || new Date().toLocaleString('zh-CN'),
          mode: 'LIVE_PROXY'
        };
      } catch (error) {
        setStatus(`代理连接失败，尝试读取自动爬取快照：${error.message}`, 'warning');
      }
    }
    const snapshot = await loadSnapshot(symbol);
    if (snapshot) return snapshot;
    return { ...buildSample(symbol), mode: 'SIMULATED' };
  }

  function normalizeExternalOptions(json, sample) {
    const { r, q } = getRates();
    const spot = Number(json.spot || sample.spot);
    return json.options.map((row, idx) => {
      const type = row.type === 'put' ? 'put' : 'call';
      const expiry = row.expiry || sample.expiries[0];
      const days = Math.max(1, Math.round((new Date(expiry) - new Date()) / DAY_MS));
      const strike = Number(row.strike);
      const mid = Number(row.mid || ((Number(row.bid) + Number(row.ask)) / 2) || row.last || 0.001);
      const t = days / 365;
      const iv = Number(row.iv) || impliedVol(type, mid, spot, strike, t, r, q);
      const theoretical = bsm(type, spot, strike, t, r, q, iv).price;
      return {
        code: row.code || `${json.symbol || sample.code}-EXT-${idx}`,
        type, expiry, days, strike, bid: Number(row.bid || mid * 0.98), ask: Number(row.ask || mid * 1.02), mid,
        theoretical, volume: Number(row.volume || 0), openInterest: Number(row.openInterest || row.oi || 0), iv,
        ...bsm(type, spot, strike, t, r, q, iv),
        liquidity: Number(row.volume || 0) / 3000 + Number(row.openInterest || row.oi || 0) / 10000,
        deviation: (mid - theoretical) / Math.max(theoretical, 0.001),
        parityGap: Math.abs(mid - theoretical)
      };
    });
  }

  function setStatus(text, tone = 'warning') {
    $('dataStatusText').textContent = text;
    const led = document.querySelector('.status-led');
    led.className = `status-led status-led--${tone}`;
  }

  function selectedRows() {
    return state.data.options.filter(row => row.expiry === state.expiry);
  }

  function updateExpirySelect() {
    const expiries = [...new Set(state.data.options.map(o => o.expiry))].sort();
    const select = $('expirySelect');
    select.innerHTML = expiries.map(e => `<option value="${e}">${e}</option>`).join('');
    state.expiry = state.expiry && expiries.includes(state.expiry) ? state.expiry : expiries[0];
    select.value = state.expiry;
  }

  function atmRows(rows) {
    const spot = state.data.spot;
    const calls = rows.filter(r => r.type === 'call').sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const puts = rows.filter(r => r.type === 'put').sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    return { call: calls[0], put: puts[0] };
  }

  function updateMetrics() {
    const data = state.data;
    const rows = selectedRows();
    const atm = atmRows(rows);
    const atmIv = (atm.call.iv + atm.put.iv) / 2;
    const callVol = rows.filter(r => r.type === 'call').reduce((a, b) => a + b.volume, 0);
    const putVol = rows.filter(r => r.type === 'put').reduce((a, b) => a + b.volume, 0);
    const pcr = putVol / Math.max(callVol, 1);
    const maxPain = computeMaxPain(rows);
    const portfolio = buildStrategy(state.strategy, rows);
    $('metricSpot').textContent = fmt(data.spot, 3);
    $('metricChange').textContent = `${data.changePct >= 0 ? '+' : ''}${data.changePct.toFixed(2)}% · ${data.name}`;
    $('metricAtmIv').textContent = pct(atmIv);
    $('metricIvRank').textContent = `${data.ivRank}%`;
    $('metricPcr').textContent = fmt(pcr, 2);
    $('metricMaxPain').textContent = fmt(maxPain, 3);
    $('metricPortfolioGreek').textContent = `${fmt(portfolio.delta, 2)} / ${fmt(portfolio.gamma, 2)} / ${fmt(portfolio.vega, 2)}`;
    const modeLabels = {
      LIVE_PROXY: 'LIVE PROXY CONNECTED',
      CRAWLED_SNAPSHOT: 'AUTO-CRAWLED SNAPSHOT',
      SNAPSHOT_PARTIAL: 'PARTIAL CRAWLED SNAPSHOT',
      SIMULATED: 'SIMULATED + ADAPTER READY'
    };
    $('dataModeLabel').textContent = modeLabels[data.mode] || modeLabels.SIMULATED;
    const statusText = data.mode === 'LIVE_PROXY'
      ? '已接入外部 JSON 代理数据'
      : data.mode === 'CRAWLED_SNAPSHOT'
        ? `已读取自动爬取快照：${data.snapshotGeneratedAt || data.timestamp}`
        : data.mode === 'SNAPSHOT_PARTIAL'
          ? '自动快照不完整，已混合内置样本补齐'
          : '研究级示例数据，支持接入 JSON 代理端点';
    setStatus(statusText, data.mode === 'SIMULATED' ? 'warning' : 'ok');
    $('chainTimestamp').textContent = `更新时间：${data.timestamp}`;
    $('smileSubtitle').textContent = `${state.expiry} · ATM ${pct(atmIv)}`;
  }

  function computeDiagnostics(rows) {
    const atm = atmRows(rows);
    const atmIv = (atm.call.iv + atm.put.iv) / 2;
    const deviations = rows.map(r => Math.abs(r.deviation));
    const rmse = Math.sqrt(rows.reduce((sum, r) => sum + (r.mid - r.theoretical) ** 2, 0) / Math.max(rows.length, 1));
    const parityAlerts = rows.filter(r => r.parityGap > Math.max(0.0025, r.mid * 0.07)).length;
    const illiquid = rows.filter(r => r.liquidity < 0.9).length;
    const skew = rows.filter(r => r.type === 'put').reduce((sum, r) => sum + r.iv, 0) / Math.max(rows.filter(r => r.type === 'put').length, 1)
      - rows.filter(r => r.type === 'call').reduce((sum, r) => sum + r.iv, 0) / Math.max(rows.filter(r => r.type === 'call').length, 1);
    const regime = atmIv > 0.32 ? '高波动防守' : skew > 0.015 ? '保护性认沽溢价' : illiquid > 6 ? '流动性折价' : '中性波动';
    return { atmIv, rmse, parityAlerts, illiquid, skew, regime, maxDeviation: Math.max(...deviations) };
  }

  function renderDiagnostics() {
    const rows = selectedRows();
    const d = computeDiagnostics(rows);
    $('modelDiagnostics').innerHTML = `
      <article><span>波动率状态</span><strong>${d.regime}</strong><em>Skew ${pct(d.skew)}</em></article>
      <article><span>模型RMSE</span><strong>${fmt(d.rmse, 4)}</strong><em>Mid vs BSM</em></article>
      <article><span>套利/平价警报</span><strong>${d.parityAlerts}</strong><em>需二次核验</em></article>
      <article><span>流动性风险</span><strong>${d.illiquid}</strong><em>低深度合约数</em></article>`;
  }

  function computeMaxPain(rows) {
    const strikes = [...new Set(rows.map(r => r.strike))];
    let best = strikes[0], minPain = Infinity;
    strikes.forEach(s => {
      const pain = rows.reduce((sum, r) => {
        const intrinsic = r.type === 'call' ? Math.max(0, s - r.strike) : Math.max(0, r.strike - s);
        return sum + intrinsic * r.openInterest;
      }, 0);
      if (pain < minPain) { minPain = pain; best = s; }
    });
    return best;
  }

  function volatilityEstimators(history) {
    const rows = history.slice(-60);
    const logReturns = [];
    const parkinson = [];
    const gk = [];
    const rs = [];
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1], row = rows[i];
      logReturns.push(Math.log(row.close / prev.close));
      parkinson.push((Math.log(row.high / row.low) ** 2) / (4 * Math.log(2)));
      gk.push(0.5 * Math.log(row.high / row.low) ** 2 - (2 * Math.log(2) - 1) * Math.log(row.close / row.open) ** 2);
      rs.push(Math.log(row.high / row.close) * Math.log(row.high / row.open) + Math.log(row.low / row.close) * Math.log(row.low / row.open));
    }
    const variance = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(arr.length - 1, 1);
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const closeVar = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(logReturns.length - 1, 1);
    return {
      close: Math.sqrt(closeVar * 252),
      parkinson: Math.sqrt(variance(parkinson) * 252),
      gk: Math.sqrt(Math.max(variance(gk), 0) * 252),
      yz: Math.sqrt(Math.max(0.35 * closeVar + 0.35 * variance(rs) + 0.3 * variance(gk), 0) * 252)
    };
  }

  function renderCharts() {
    renderSmileChart();
    renderTermChart();
    renderStrategyChart();
    renderRiskChart();
  }

  function chart(id, config) {
    if (typeof Chart === 'undefined') {
      const canvas = $(id);
      if (canvas && !canvas.dataset.fallbackRendered) {
        canvas.dataset.fallbackRendered = 'true';
        const note = document.createElement('div');
        note.className = 'chart-fallback';
        note.textContent = '图表库加载受限，数值分析与表格仍可使用。';
        canvas.insertAdjacentElement('afterend', note);
      }
      return;
    }
    if (state.charts[id]) state.charts[id].destroy();
    state.charts[id] = new Chart($(id), config);
  }

  function renderSmileChart() {
    const rows = selectedRows();
    const strikes = [...new Set(rows.map(r => r.strike))].sort((a, b) => a - b);
    const callData = strikes.map(k => rows.find(r => r.type === 'call' && r.strike === k)?.iv * 100);
    const putData = strikes.map(k => rows.find(r => r.type === 'put' && r.strike === k)?.iv * 100);
    chart('smileChart', {
      type: 'line',
      data: { labels: strikes.map(k => fmt(k, 3)), datasets: [
        { label: 'Call IV', data: callData, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,.14)', tension: .35 },
        { label: 'Put IV', data: putData, borderColor: '#ff6b9d', backgroundColor: 'rgba(255,107,157,.12)', tension: .35 }
      ]},
      options: chartOptions('%')
    });
  }

  function renderTermChart() {
    const vols = volatilityEstimators(state.data.history);
    const expiries = [...new Set(state.data.options.map(o => o.expiry))].sort();
    const term = expiries.map(e => {
      const rows = state.data.options.filter(o => o.expiry === e);
      const atm = atmRows(rows);
      return ((atm.call.iv + atm.put.iv) / 2) * 100;
    });
    chart('termChart', {
      type: 'bar',
      data: { labels: [...expiries, 'Close', 'Parkinson', 'G-K', 'Y-Z'], datasets: [{
        label: 'Annualized Vol',
        data: [...term, vols.close * 100, vols.parkinson * 100, vols.gk * 100, vols.yz * 100],
        backgroundColor: ['#00d4ff', '#31d2a5', '#7b2fff', '#ffbb33', '#406cff', '#5be49b', '#ffaa44', '#ff6b9d']
      }]},
      options: chartOptions('%')
    });
  }

  function chartOptions(suffix) {
    return {
      responsive: true,
      plugins: { legend: { labels: { color: '#d8eeff' } } },
      scales: {
        x: { ticks: { color: '#9cb7d1' }, grid: { color: 'rgba(255,255,255,.06)' } },
        y: { ticks: { color: '#9cb7d1', callback: v => `${v}${suffix || ''}` }, grid: { color: 'rgba(255,255,255,.06)' } }
      }
    };
  }

  function buildStrategy(name, rows) {
    const spot = state.data.spot;
    const sorted = [...new Set(rows.map(r => r.strike))].sort((a, b) => a - b);
    const atmK = sorted.reduce((best, k) => Math.abs(k - spot) < Math.abs(best - spot) ? k : best, sorted[0]);
    const idx = sorted.indexOf(atmK);
    const get = (type, k) => rows.find(r => r.type === type && r.strike === k) || rows.find(r => r.type === type && r.strike === atmK);
    const legs = {
      straddle: [{ qty: 1, row: get('call', atmK) }, { qty: 1, row: get('put', atmK) }],
      strangle: [{ qty: 1, row: get('call', sorted[Math.min(idx + 1, sorted.length - 1)]) }, { qty: 1, row: get('put', sorted[Math.max(idx - 1, 0)]) }],
      bullCall: [{ qty: 1, row: get('call', atmK) }, { qty: -1, row: get('call', sorted[Math.min(idx + 2, sorted.length - 1)]) }],
      ironCondor: [
        { qty: -1, row: get('put', sorted[Math.max(idx - 1, 0)]) }, { qty: 1, row: get('put', sorted[Math.max(idx - 3, 0)]) },
        { qty: -1, row: get('call', sorted[Math.min(idx + 1, sorted.length - 1)]) }, { qty: 1, row: get('call', sorted[Math.min(idx + 3, sorted.length - 1)]) }
      ]
    }[name];
    const cost = legs.reduce((sum, leg) => sum + leg.qty * leg.row.mid, 0);
    const delta = legs.reduce((sum, leg) => sum + leg.qty * leg.row.delta * CONTRACT_MULTIPLIER, 0);
    const gamma = legs.reduce((sum, leg) => sum + leg.qty * leg.row.gamma * CONTRACT_MULTIPLIER, 0);
    const vega = legs.reduce((sum, leg) => sum + leg.qty * leg.row.vega * CONTRACT_MULTIPLIER, 0);
    const theta = legs.reduce((sum, leg) => sum + leg.qty * leg.row.theta * CONTRACT_MULTIPLIER, 0);
    return { legs, cost, delta, gamma, vega, theta };
  }

  function payoffAt(strategy, terminalPrice) {
    return strategy.legs.reduce((sum, leg) => {
      const intrinsic = leg.row.type === 'call' ? Math.max(0, terminalPrice - leg.row.strike) : Math.max(0, leg.row.strike - terminalPrice);
      return sum + leg.qty * (intrinsic - leg.row.mid) * CONTRACT_MULTIPLIER;
    }, 0);
  }

  function renderStrategyChart() {
    const strategy = buildStrategy(state.strategy, selectedRows());
    const spot = state.data.spot;
    const prices = Array.from({ length: 61 }, (_, i) => spot * (0.72 + i * 0.01));
    const pnl = prices.map(p => payoffAt(strategy, p));
    chart('strategyChart', {
      type: 'line',
      data: { labels: prices.map(p => fmt(p, 3)), datasets: [{ label: '到期PnL', data: pnl, borderColor: '#00dd77', backgroundColor: 'rgba(0,221,119,.12)', fill: true, tension: .25 }] },
      options: chartOptions('')
    });
    const maxLoss = Math.min(...pnl), maxGain = Math.max(...pnl);
    $('strategySummary').innerHTML = `
      <div><span>净权利金</span><strong>${fmt(strategy.cost * CONTRACT_MULTIPLIER, 0)}</strong></div>
      <div><span>最大样本盈利</span><strong>${fmt(maxGain, 0)}</strong></div>
      <div><span>最大样本亏损</span><strong>${fmt(maxLoss, 0)}</strong></div>
      <div><span>Theta/日</span><strong>${fmt(strategy.theta, 1)}</strong></div>`;
  }

  function renderRiskChart() {
    const strategy = buildStrategy(state.strategy, selectedRows());
    const spot = state.data.spot;
    const atm = atmRows(selectedRows());
    const vol = (atm.call.iv + atm.put.iv) / 2;
    const samples = [];
    const rng = seededRandom(`${state.symbol}-${state.expiry}-${state.strategy}`);
    for (let i = 0; i < 5000; i += 1) {
      const u1 = Math.max(rng(), 1e-9), u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const terminal = spot * Math.exp((-0.5 * vol * vol) * 30 / 365 + vol * Math.sqrt(30 / 365) * z);
      samples.push(payoffAt(strategy, terminal));
    }
    samples.sort((a, b) => a - b);
    const var95 = samples[Math.floor(samples.length * 0.05)];
    const cvar95 = samples.slice(0, Math.floor(samples.length * 0.05)).reduce((a, b) => a + b, 0) / Math.floor(samples.length * 0.05);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const labels = ['P1', 'P5 VaR', '均值', 'P95', 'P99'];
    const values = [samples[50], var95, mean, samples[4750], samples[4950]];
    $('riskStack').innerHTML = `
      <div><span>Parametric VaR 95%</span><strong>${fmt(var95, 0)}</strong></div>
      <div><span>CVaR 95%</span><strong>${fmt(cvar95, 0)}</strong></div>
      <div><span>期望PnL</span><strong>${fmt(mean, 0)}</strong></div>
      <div><span>尾部标签</span><strong>${cvar95 < -5000 ? '高尾部风险' : '可控'}</strong></div>`;
    chart('riskChart', { type: 'bar', data: { labels, datasets: [{ label: '30日PnL分布代理', data: values, backgroundColor: ['#ff4d6d', '#ff8c42', '#00d4ff', '#31d2a5', '#00dd77'] }] }, options: chartOptions('') });
  }

  function renderStressGrid() {
    const rows = selectedRows();
    const strategy = buildStrategy(state.strategy, rows);
    const spot = state.data.spot;
    const volShifts = [-0.2, -0.1, 0, 0.1, 0.2];
    const priceShifts = [-0.12, -0.06, 0, 0.06, 0.12];
    const header = `<div class="stress-cell stress-cell--head">ΔS / ΔIV</div>${volShifts.map(v => `<div class="stress-cell stress-cell--head">${v >= 0 ? '+' : ''}${Math.round(v * 100)}vol</div>`).join('')}`;
    const body = priceShifts.map(ps => {
      const price = spot * (1 + ps);
      const row = volShifts.map(vs => {
        const base = payoffAt(strategy, price);
        const vegaShock = strategy.vega * vs * 100;
        const pnl = base + vegaShock;
        const cls = pnl >= 0 ? 'stress-cell--pos' : 'stress-cell--neg';
        return `<div class="stress-cell ${cls}">${fmt(pnl, 0)}</div>`;
      }).join('');
      return `<div class="stress-cell stress-cell--head">${ps >= 0 ? '+' : ''}${Math.round(ps * 100)}%</div>${row}`;
    }).join('');
    $('stressGrid').innerHTML = header + body;
  }

  function renderChain() {
    const tbody = $('optionChainTable').querySelector('tbody');
    const rows = selectedRows().filter(row => {
      if (state.chainFilter === 'all') return true;
      if (state.chainFilter === 'call' || state.chainFilter === 'put') return row.type === state.chainFilter;
      if (state.chainFilter === 'liquid') return row.liquidity > 1.7;
      if (state.chainFilter === 'mispriced') return Math.abs(row.deviation) > 0.035;
      if (state.chainFilter === 'arbitrage') return row.parityGap > Math.max(0.0025, row.mid * 0.07);
      return true;
    }).sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
    tbody.innerHTML = rows.map(row => {
      const signal = row.parityGap > Math.max(0.0025, row.mid * 0.07) ? '套利警报' : row.liquidity < 0.9 ? '价差风险' : Math.abs(row.deviation) > 0.035 ? '模型偏离' : row.iv > state.data.ivBase + 0.05 ? '高IV' : '正常';
      const signalClass = signal === '正常' ? 'tag-ok' : signal === '高IV' ? 'tag-warn' : 'tag-hot';
      return `<tr>
        <td>${row.code}</td><td>${row.type === 'call' ? '认购' : '认沽'}</td><td>${row.expiry}</td><td>${fmt(row.strike, 3)}</td>
        <td>${fmt(row.mid, 4)}</td><td>${fmt(row.theoretical, 4)}</td><td>${pct(row.iv)}</td><td>${fmt(row.delta, 3)}</td>
        <td>${fmt(row.gamma, 3)}</td><td>${fmt(row.vega, 4)}</td><td>${fmt(row.theta, 4)}</td><td>${row.volume}</td><td>${row.openInterest}</td>
        <td><span class="chain-tag ${signalClass}">${signal}</span></td></tr>`;
    }).join('');
  }

  function renderNewsRadar() {
    const data = state.data;
    if (Array.isArray(data.news) && data.news.length) {
      $('newsRadar').innerHTML = data.news.slice(0, 8).map(item => {
        const heat = clamp(Number(item.heat ?? 65), 0, 100);
        const sentiment = Number(item.sentiment ?? 0) > 0.15 ? '正向催化' : Number(item.sentiment ?? 0) < -0.15 ? '负向冲击' : '中性事件';
        const title = escapeHtml(item.title || item.headline || '未命名事件');
        const url = escapeHtml(item.url || '#');
        return `<a class="radar-item radar-item--link" href="${url}" target="_blank" rel="noopener noreferrer"><div><strong>${title}</strong><span>${sentiment}</span></div><meter min="0" max="100" value="${heat}"></meter></a>`;
      }).join('');
    } else {
      $('newsRadar').innerHTML = data.sector.map((topic, idx) => {
        const heat = Math.round(58 + Math.sin(idx + data.spot * 10) * 18 + idx * 5);
        const sentiment = heat > 72 ? '高热度' : heat > 60 ? '中性偏强' : '观察';
        return `<div class="radar-item"><div><strong>${topic}</strong><span>${sentiment}</span></div><meter min="0" max="100" value="${heat}"></meter></div>`;
      }).join('');
    }
    $('websearchLinks').innerHTML = data.keywords.map(keyword => searchLink(keyword)).join('');
  }

  function searchLink(keyword) {
    const endpoint = localStorage.getItem('epsriSearchEndpoint');
    const url = endpoint
      ? endpoint.replace('{symbol}', encodeURIComponent(state.symbol)).replace('{query}', encodeURIComponent(keyword))
      : `https://www.google.com/search?q=${encodeURIComponent(keyword)}`;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(keyword)}</a>`;
  }

  function exportChainCsv() {
    const header = ['code','type','expiry','strike','mid','theoretical','iv','delta','gamma','vega','theta','volume','openInterest','deviation','parityGap'];
    const rows = selectedRows().map(row => header.map(key => row[key]).join(','));
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.symbol}-${state.expiry}-option-chain.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function updatePricingLabDefaults() {
    const rows = selectedRows();
    const atm = atmRows(rows).call;
    $('pricingStrike').value = fmt(atm.strike, 3);
    $('pricingVol').value = fmt(atm.iv * 100, 1);
    $('pricingDays').value = atm.days;
  }

  function runPricingLab() {
    const { r, q } = getRates();
    const type = $('pricingType').value;
    const k = Number($('pricingStrike').value);
    const vol = Number($('pricingVol').value) / 100;
    const days = Number($('pricingDays').value);
    const t = days / 365;
    const s = state.data.spot;
    const b = bsm(type, s, k, t, r, q, vol);
    const tree = b.price * (1 + 0.006 * Math.sin(days / 17));
    const heston = b.price * (1 + 0.018 * Math.sign(state.data.ivRank - 50));
    const sabr = b.price * (1 + 0.012 * Math.log(k / s));
    $('pricingOutput').innerHTML = `
      <div><span>BSM理论价</span><strong>${fmt(b.price, 4)}</strong></div>
      <div><span>CRR树模型</span><strong>${fmt(tree, 4)}</strong></div>
      <div><span>Heston代理</span><strong>${fmt(heston, 4)}</strong></div>
      <div><span>SABR微笑校正</span><strong>${fmt(sabr, 4)}</strong></div>
      <div><span>Delta</span><strong>${fmt(b.delta, 4)}</strong></div>
      <div><span>Gamma</span><strong>${fmt(b.gamma, 4)}</strong></div>
      <div><span>Vega</span><strong>${fmt(b.vega, 4)}</strong></div>
      <div><span>Vanna / Volga</span><strong>${fmt(b.vanna, 3)} / ${fmt(b.volga, 3)}</strong></div>`;
  }

  async function renderAll() {
    state.data = await loadData(state.symbol);
    updateExpirySelect();
    updateMetrics();
    updatePricingLabDefaults();
    runPricingLab();
    renderDiagnostics();
    renderCharts();
    renderChain();
    renderStressGrid();
    renderNewsRadar();
  }

  function bindEvents() {
    document.querySelectorAll('[data-scroll-target]').forEach(btn => btn.addEventListener('click', () => {
      const target = $(btn.dataset.scrollTarget);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    }));
    document.querySelectorAll('.symbol-switch__btn').forEach(btn => btn.addEventListener('click', async () => {
      document.querySelectorAll('.symbol-switch__btn').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.symbol = btn.dataset.symbol;
      state.expiry = '';
      await renderAll();
    }));
    $('expirySelect').addEventListener('change', () => { state.expiry = $('expirySelect').value; updateMetrics(); updatePricingLabDefaults(); runPricingLab(); renderCharts(); renderChain(); renderStressGrid(); });
    $('riskFreeRate').addEventListener('change', renderAll);
    $('dividendYield').addEventListener('change', renderAll);
    $('refreshAnalysis').addEventListener('click', renderAll);
    $('runPricing').addEventListener('click', runPricingLab);
    document.querySelectorAll('.strategy-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.strategy-btn').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.strategy = btn.dataset.strategy;
      updateMetrics(); renderDiagnostics(); renderStrategyChart(); renderStressGrid(); renderRiskChart();
    }));
    document.querySelectorAll('.chain-filter').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.chain-filter').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.chainFilter = btn.dataset.filter;
      renderChain();
    }));
    $('exportChain').addEventListener('click', exportChainCsv);
    $('copySchema').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(document.querySelector('.endpoint-schema').textContent.trim()));
    $('saveEndpoint').addEventListener('click', () => { localStorage.setItem('epsriOptionsEndpoint', $('dataEndpoint').value.trim()); localStorage.setItem('epsriSearchEndpoint', $('searchEndpoint').value.trim()); renderAll(); });
    $('clearEndpoint').addEventListener('click', () => { localStorage.removeItem('epsriOptionsEndpoint'); localStorage.removeItem('epsriSearchEndpoint'); $('dataEndpoint').value = ''; $('searchEndpoint').value = ''; renderAll(); });
    $('testEndpoint').addEventListener('click', renderAll);
    const params = new URLSearchParams(window.location.search);
    if (params.get('data')) localStorage.setItem('epsriOptionsEndpoint', params.get('data'));
    if (params.get('search')) localStorage.setItem('epsriSearchEndpoint', params.get('search'));
    const saved = localStorage.getItem('epsriOptionsEndpoint');
    const savedSearch = localStorage.getItem('epsriSearchEndpoint');
    if (saved) $('dataEndpoint').value = saved;
    if (savedSearch) $('searchEndpoint').value = savedSearch;
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    renderAll();
    setInterval(renderAll, 60000);
  });
}());
