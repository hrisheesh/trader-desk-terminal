const API_CANDIDATES = buildApiCandidates();
const DESK_INTERVAL_MS = 1500;
const FLOW_INTERVAL_MS = 1200;
const CANDLE_REFRESH_MS = 30000;
const CRYPTO_SYMBOLS = new Set(["BTC-USD", "ETH-USD"]);
const INTERVAL_SECONDS = { "1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 };
const VISIBLE_BARS = { "1m": 80, "2m": 72, "5m": 84, "15m": 80, "30m": 72, "1h": 72 };

let apiBase = API_CANDIDATES[0];
const DEFAULT_SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT", "BTC-USD", "ETH-USD", "SOXL", "SPY"];
let savedWatchlist = (() => {
  try {
    const data = JSON.parse(localStorage.getItem("trader-desk-watchlist"));
    return Array.isArray(data) && data.length > 0 ? data : DEFAULT_SYMBOLS;
  } catch (e) {
    return DEFAULT_SYMBOLS;
  }
})();
let savedHistory = (() => {
  try {
    localStorage.removeItem("trader-desk-history"); // FORCE WIPE
    const data = JSON.parse(localStorage.getItem("trader-desk-history"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
})();
let savedPortfolio = (() => {
  try {
    localStorage.removeItem("trader-desk-portfolio"); // FORCE WIPE
    const data = JSON.parse(localStorage.getItem("trader-desk-portfolio"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
})();
let tradeHistory = (() => {
  try {
    const data = JSON.parse(localStorage.getItem("trader-desk-trade-history"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
})();
let activeTab = "watchlist";

let activeSymbol = "BTC-USD";
let activeInterval = "1m";
let chartMode = "candles";
let quotes = [];
let previousPrices = new Map();
let pulse = null;
let alerts = [];
let detail = null;
let signals = [];
let chartCandles = [];
let liveCandleUpdates = new Map();
let baseRestCandles = [];
let lastCandlePayload = null;
let pendingFocusRender = false;
let refreshTimer = null;
let flowTimer = null;
let candleTimer = null;
let tickSocket = null;
let panOffset = 0;
let isPanning = false;
let lastPanX = 0;

const els = {
  command: document.querySelector("#command-input"),
  watchlist: document.querySelector("#watchlist"),
  refresh: document.querySelector("#refresh-button"),
  marketState: document.querySelector("#market-state"),
  clock: document.querySelector("#desk-clock"),
  focusSymbol: document.querySelector("#focus-symbol"),
  focusPrice: document.querySelector("#focus-price"),
  focusChange: document.querySelector("#focus-change"),
  pinBtn: document.querySelector("#pin-button"),
  metricHigh: document.querySelector("#metric-high"),
  metricLow: document.querySelector("#metric-low"),
  metricVolume: document.querySelector("#metric-volume"),
  metricVenue: document.querySelector("#metric-venue"),
  headerSignal: document.querySelector("#header-signal"),
  headerTarget: document.querySelector("#header-target"),
  chart: document.querySelector("#price-chart"),
  chartCaption: document.querySelector("#chart-caption"),
  flowSource: document.querySelector("#flow-source"),
  bids: document.querySelector("#book-bids"),
  asks: document.querySelector("#book-asks"),
  tape: document.querySelector("#tape-list"),
  ticker: document.querySelector("#ticker-tape"),
  status: document.querySelector("#api-status"),
  pulse: document.querySelector("#pulse-grid"),
  movers: document.querySelector("#movers-list"),
  alerts: document.querySelector("#alerts-list"),
  signals: document.querySelector("#signal-list"),
  timeframeControls: document.querySelector("#timeframe-controls"),
  chartModeControls: document.querySelector("#chart-mode-controls"),
  railTabs: document.querySelector("#rail-tabs"),
  historyList: document.querySelector("#history-list"),
  portfolioList: document.querySelector("#portfolio-list"),
  btnBuy: document.querySelector("#btn-buy"),
  btnSell: document.querySelector("#btn-sell"),
  orderModal: document.querySelector("#order-modal"),
  modalClose: document.querySelector("#modal-close"),
  modalConfirm: document.querySelector("#modal-confirm"),
  orderQty: document.querySelector("#order-qty"),
  orderTotal: document.querySelector("#order-total"),
  modalPrice: document.querySelector("#modal-price"),
  modalTitle: document.querySelector("#modal-title"),
  historyList: document.querySelector("#history-list"),
};

function updateStorage() {
  localStorage.setItem("trader-desk-watchlist", JSON.stringify(savedWatchlist));
  localStorage.setItem("trader-desk-history", JSON.stringify(savedHistory));
  localStorage.setItem("trader-desk-portfolio", JSON.stringify(savedPortfolio));
  localStorage.setItem("trader-desk-trade-history", JSON.stringify(tradeHistory));
}

window.toggleWatchlist = function (symbol) {
  if (savedWatchlist.includes(symbol)) {
    savedWatchlist = savedWatchlist.filter((s) => s !== symbol);
  } else {
    savedWatchlist.push(symbol);
  }
  updateStorage();
  if (activeTab === "watchlist") loadDesk();
  else renderWatchlist(); // Update the +/- buttons
};

function addToHistory(symbol) {
  savedHistory = [symbol, ...savedHistory.filter((s) => s !== symbol)].slice(0, 15);
  updateStorage();
  if (activeTab === "history" && !quotes.find(q => q.symbol === symbol)) loadDesk();
}

function buildApiCandidates() {
  const host = window.location.hostname || "localhost";
  const candidates = [`http://${host}:8000`, "http://localhost:8000", "http://127.0.0.1:8000"];
  return [...new Set(candidates)];
}

function websocketUrl(path) {
  const url = new URL(apiBase || API_CANDIDATES[0]);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const digits = Math.abs(number) >= 1000 ? 2 : 4;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(number);
}

function formatVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(number);
}

function shortTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString([], { hour12: false });
}

function toneClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function symbolAlias(value) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "BTC") return "BTC-USD";
  if (normalized === "ETH") return "ETH-USD";
  return normalized;
}

async function fetchFromApi(path) {
  let lastError;
  for (const candidate of API_CANDIDATES) {
    try {
      const response = await fetch(`${candidate}${path}`, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `${response.status} ${response.statusText}`);
      }
      apiBase = candidate;
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Backend unavailable");
}

function setStatus(text, mode = "ok") {
  els.status.textContent = text;
  els.status.className = `api-status ${mode}`;
}

function renderWatchlist() {
  els.watchlist.classList.remove("loading");
  els.watchlist.innerHTML = quotes
    .map((quote, index) => {
      const prior = previousPrices.get(quote.symbol);
      const flash =
        prior !== undefined && quote.price !== prior ? (quote.price > prior ? "flash-up" : "flash-down") : "";
      previousPrices.set(quote.symbol, quote.price);
      const isWatchlist = savedWatchlist.includes(quote.symbol);
      const actionIcon = isWatchlist ? "-" : "+";
      return `
        <div class="watch-row ${quote.symbol === activeSymbol ? "active" : ""} ${flash}" onclick="selectSymbol('${quote.symbol}')">
          <span class="rank">${String(index + 1).padStart(2, "0")}</span>
          <div class="watch-left">
            <strong>${quote.symbol} <b>${formatPrice(quote.price)}</b></strong>
            <span>
              <small class="feed-pill ${quote.isRealtime ? "live" : "delayed"}">${quote.isRealtime ? "LIVE" : "DLY"}</small>
              <small class="${toneClass(quote.change)}">${quote.changePercent > 0 ? "+" : ""}${(quote.changePercent || 0).toFixed(2)}%</small>
            </span>
          </div>
          <button class="rail-action-btn" onclick="event.stopPropagation(); toggleWatchlist('${quote.symbol}')">${actionIcon}</button>
        </div>
      `;
    })
    .join("");
}

const LOT_COLORS = ["#00ffff", "#ff00ff", "#ffff00", "#ffa500", "#0088ff", "#8a2be2", "#ff1493", "#00fa9a", "#ff6347"];

function renderPortfolio() {
  if (savedPortfolio.length === 0) {
    els.portfolioList.innerHTML = `<div style="padding:16px; color:var(--muted); text-align:center;">No positions yet. Buy something!</div>`;
    return;
  }
  
  els.portfolioList.innerHTML = savedPortfolio.map(pos => {
    const q = quotes.find(quote => quote.symbol === pos.symbol);
    const currentPrice = q ? q.price : pos.avgPrice;
    const pnl = (currentPrice - pos.avgPrice) * pos.qty;
    const pnlPercent = ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100;
    
    return `
      <div class="portfolio-item ${pos.symbol === activeSymbol ? "active" : ""}" onclick="selectSymbol('${pos.symbol}')">
        <div class="port-row main">
          <strong><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${pos.color};margin-right:6px;"></span>${pos.symbol}</strong>
          <b>$${formatPrice(currentPrice)}</b>
        </div>
        <div class="port-row meta">
          <span>${pos.qty} @ $${formatPrice(pos.avgPrice)}</span>
          <span class="${toneClass(pnl)}">${pnl > 0 ? "+" : ""}$${formatPrice(Math.abs(pnl))} (${pnlPercent.toFixed(2)}%)</span>
        </div>
        <div class="port-row action">
          <button class="port-sell-btn" onclick="event.stopPropagation(); executeTrade('${pos.symbol}', 'sell', ${pos.qty}, ${currentPrice}, '${pos.id}')">SELL</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderHistory() {
  if (tradeHistory.length === 0) {
    els.historyList.innerHTML = `<div style="padding:16px; color:var(--muted); text-align:center;">No trade history.</div>`;
    return;
  }
  
  els.historyList.innerHTML = tradeHistory.map(trade => {
    const isBuy = trade.type === "BUY";
    const pnlDisplay = !isBuy && trade.pnl !== undefined 
      ? `<span class="${toneClass(trade.pnl)}">${trade.pnl > 0 ? "+" : ""}$${formatPrice(Math.abs(trade.pnl))}</span>` 
      : "";
      
    return `
      <div class="portfolio-item" style="cursor: default;">
        <div class="port-row main">
          <strong>
            <span style="display:inline-block; padding:2px 4px; border-radius:3px; font-size:9px; background:${isBuy ? 'var(--green)' : 'var(--line)'}; color:${isBuy ? '#000' : 'var(--muted)'}; margin-right:6px;">${trade.type}</span>
            ${trade.symbol}
          </strong>
          <b>@ $${formatPrice(trade.price)}</b>
        </div>
        <div class="port-row meta">
          <span>Qty: ${trade.qty} &bull; ${trade.timestamp}</span>
          ${pnlDisplay}
        </div>
      </div>
    `;
  }).reverse().join("");
}

function executeTrade(symbol, side, qty, price, id = null) {
  const timestamp = new Date().toLocaleTimeString();
  
  if (side === "buy") {
    // Determine the next color based on the number of existing lots for this symbol
    const existingLots = savedPortfolio.filter(p => p.symbol === symbol).length;
    const color = LOT_COLORS[existingLots % LOT_COLORS.length];
    const newId = Date.now().toString() + Math.floor(Math.random() * 1000);
    
    savedPortfolio.push({ id: newId, symbol, qty, avgPrice: price, color });
    tradeHistory.push({ type: "BUY", symbol, qty, price, timestamp });
  } else if (side === "sell") {
    let pnl = 0;
    if (id) {
      const existingIdx = savedPortfolio.findIndex(p => p.id === id);
      if (existingIdx > -1) {
        const existing = savedPortfolio[existingIdx];
        pnl = (price - existing.avgPrice) * qty;
        existing.qty -= qty;
        if (existing.qty <= 0) {
          savedPortfolio.splice(existingIdx, 1);
        }
      }
    } else {
      // If no ID provided (e.g. from general sell button without tooltip), sell FIFO from all lots
      let qtyToSell = qty;
      const matchingLots = savedPortfolio.filter(p => p.symbol === symbol);
      for (const lot of matchingLots) {
        if (qtyToSell <= 0) break;
        const sellQty = Math.min(lot.qty, qtyToSell);
        pnl += (price - lot.avgPrice) * sellQty;
        
        if (lot.qty <= qtyToSell) {
          qtyToSell -= lot.qty;
          savedPortfolio = savedPortfolio.filter(p => p.id !== lot.id);
        } else {
          lot.qty -= qtyToSell;
          qtyToSell = 0;
        }
      }
    }
    tradeHistory.push({ type: "SELL", symbol, qty, price, timestamp, pnl });
  }
  updateStorage();
  if (activeTab === "portfolio") renderPortfolio();
  if (activeTab === "history") renderHistory();
  renderChart();
}

function renderTicker() {
  els.ticker.innerHTML = quotes
    .map((quote) => {
      const sign = quote.change > 0 ? "+" : "";
      return `<span class="${toneClass(quote.change)}">${quote.symbol} ${formatPrice(quote.price)} ${sign}${(quote.changePercent || 0).toFixed(2)}%</span>`;
    })
    .join("");
}

function renderPulse() {
  if (!pulse) return;
  els.pulse.innerHTML = `
    <div><span>Up</span><strong>${pulse.advancers}</strong></div>
    <div><span>Down</span><strong>${pulse.decliners}</strong></div>
    <div><span>Feeds</span><strong>${pulse.liveFeeds} LIVE</strong></div>
    <div><span>Notional</span><strong>${formatVolume(pulse.notionalVolume)}</strong></div>
  `;

  const movers = [...quotes].sort((a, b) => Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0)).slice(0, 5);
  els.movers.innerHTML = movers
    .map((quote) => {
      const width = Math.min(100, Math.abs(quote.changePercent || 0) * 14);
      return `
        <div class="mover-row" style="cursor: pointer;" onclick="selectSymbol('${quote.symbol}')">
          <span class="clickable-ticker">${quote.symbol}</span>
          <div class="mover-bar"><i class="${toneClass(quote.change)}" style="width:${width}%"></i></div>
          <strong class="${toneClass(quote.change)}">${quote.changePercent > 0 ? "+" : ""}${(quote.changePercent || 0).toFixed(2)}%</strong>
        </div>
      `;
    })
    .join("");

  els.alerts.innerHTML = alerts
    .map((alert) => {
      const cleanMessage = alert.message.replace(alert.symbol, '').trim();
      return `<div class="alert-row ${alert.level}"><strong class="clickable-ticker" onclick="selectSymbol('${alert.symbol}')">${alert.symbol}</strong><span>${cleanMessage}</span></div>`;
    })
    .join("");
}

function renderFocus() {
  if (!detail) return;
  els.focusSymbol.textContent = detail.symbol || activeSymbol;
  els.focusPrice.textContent = formatPrice(detail.price);
  const changeSign = detail.change > 0 ? "+" : "";
  els.focusChange.textContent = `${changeSign}${formatPrice(detail.change)} / ${changeSign}${(detail.changePercent || 0).toFixed(2)}%`;
  els.focusChange.className = toneClass(detail.change);
  els.metricHigh.textContent = formatPrice(detail.dayHigh);
  els.metricLow.textContent = formatPrice(detail.dayLow);
  els.metricVolume.textContent = formatVolume(detail.volume);
  els.metricVenue.textContent = `${detail.exchange || "--"} / ${detail.currency || "--"}`;
  els.marketState.textContent = detail.isRealtime ? "LIVE COINBASE" : "DELAYED EQUITY";
  const isPinned = savedWatchlist.includes(activeSymbol);
  els.pinBtn.textContent = isPinned ? "Unpin" : "Pin";
  
  // Also update quote in global quotes array so portfolio stays ultra live
  const existingQuoteIdx = quotes.findIndex(q => q.symbol === activeSymbol);
  if (existingQuoteIdx > -1) {
    quotes[existingQuoteIdx] = { symbol: activeSymbol, price: detail.price, change: detail.change, changePercent: detail.changePercent };
  } else {
    quotes.push({ symbol: activeSymbol, price: detail.price, change: detail.change, changePercent: detail.changePercent });
  }
  
  if (activeTab === "portfolio") renderPortfolio();
  
  pendingFocusRender = false;
  els.pinBtn.className = isPinned ? "pin-btn active" : "pin-btn";
  updateChartCaption();
  renderChart();
}

function updateChartCaption(extra = "") {
  if (!detail) return;
  const feed = detail.isRealtime ? "Coinbase WS ticks + real Coinbase candles" : "Yahoo delayed OHLC";
  const granularity = lastCandlePayload?.nativeIntervalSeconds && lastCandlePayload.nativeIntervalSeconds !== lastCandlePayload.intervalSeconds
    ? ` | history native ${lastCandlePayload.nativeIntervalSeconds}s`
    : "";
  els.chartCaption.textContent = `${feed} | ${activeInterval} ${chartMode.toUpperCase()}${granularity} | last ${shortTime(
    detail.lastTradeTime || detail.regularMarketTime
  )}${extra}`;
}

function toTimestamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

function intervalMs() {
  return (INTERVAL_SECONDS[activeInterval] || 60) * 1000;
}

function candleBucket(candle) {
  return Math.floor(toTimestamp(candle.time) / intervalMs()) * intervalMs();
}

function visibleLimit() {
  return VISIBLE_BARS[activeInterval] || 80;
}

function fillCandleGaps(sorted) {
  if (sorted.length === 0) return [];
  const ms = intervalMs();
  const filled = [sorted[0]];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    let expectedTime = current.timestamp + ms;
    const gapMs = next.timestamp - current.timestamp;
    
    if (gapMs > ms && gapMs < 5 * ms) {
      while (expectedTime < next.timestamp) {
        filled.push({
          time: new Date(expectedTime).toISOString(),
          timestamp: expectedTime,
          open: current.close,
          high: current.close,
          low: current.close,
          close: current.close,
          volume: 0,
        });
        expectedTime += ms;
      }
    }
    filled.push(next);
    current = next;
  }
  return filled;
}

function normalizeCandles(candles) {
  const sorted = (candles || [])
    .filter((candle) => ["open", "high", "low", "close"].every((key) => Number.isFinite(Number(candle[key]))))
    .map((candle) => ({
      ...candle,
      timestamp: toTimestamp(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  
  return fillCandleGaps(sorted).slice(-160);
}

function mergeLiveCandles(restCandles) {
  if (!CRYPTO_SYMBOLS.has(activeSymbol)) return restCandles;
  const merged = restCandles.map((candle) => ({ ...candle }));
  const restBucketIndex = new Map(merged.map((candle, index) => [candleBucket(candle), index]));
  const newestRestBucket = merged.length ? candleBucket(merged.at(-1)) : 0;

  for (const [bucket, liveCandle] of liveCandleUpdates.entries()) {
    const restIndex = restBucketIndex.get(bucket);
    if (restIndex !== undefined) {
      const restCandle = merged[restIndex];
      merged[restIndex] = {
        ...restCandle,
        high: Math.max(restCandle.high, liveCandle.high),
        low: Math.min(restCandle.low, liveCandle.low),
        close: liveCandle.close,
        volume: Math.max(Number(restCandle.volume || 0), Number(liveCandle.volume || 0)),
      };
    } else if (bucket > newestRestBucket) {
      merged.push({ ...liveCandle });
    }
  }
  const sorted = merged.sort((a, b) => a.timestamp - b.timestamp);
  const targetLength = Math.max(120, restCandles.length || 120);
  return fillCandleGaps(sorted).slice(-targetLength);
}

function applyTickToCandle(tick) {
  const price = Number(tick.price);
  if (!Number.isFinite(price)) return;
  const bucket = Math.floor(toTimestamp(tick.time || tick.fetchedAt) / intervalMs()) * intervalMs();
  const bucketIso = new Date(bucket).toISOString();

  let liveCandle = liveCandleUpdates.get(bucket);
  if (!liveCandle) {
    const baseCandle = baseRestCandles.find(c => candleBucket(c) === bucket);
    if (baseCandle) {
      liveCandle = { ...baseCandle };
    } else {
      liveCandle = { time: bucketIso, timestamp: bucket, open: price, high: price, low: price, close: price, volume: 0 };
    }
    liveCandleUpdates.set(bucket, liveCandle);
  }

  liveCandle.high = Math.max(liveCandle.high, price);
  liveCandle.low = Math.min(liveCandle.low, price);
  liveCandle.close = price;
  liveCandle.volume = Number(liveCandle.volume || 0) + Number(tick.lastSize || 0);

  chartCandles = mergeLiveCandles(baseRestCandles);

  if (detail && tick.symbol === activeSymbol) {
    detail.price = price;
    detail.bid = tick.bid ?? detail.bid;
    detail.ask = tick.ask ?? detail.ask;
    detail.lastTradeTime = tick.time || tick.fetchedAt;
    scheduleFocusRender();
  } else {
    renderChart();
  }
}

function chartScale(candles, width, height, plot) {
  const lows = candles.map((candle) => candle.low);
  const highs = candles.map((candle) => candle.high);
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  const rawSpan = max - min;
  const padding = rawSpan > 0 ? rawSpan * 0.12 : Math.max(Math.abs(max) * 0.002, 0.01);
  min -= padding;
  max += padding;
  const span = max - min || 1;
  const y = (price) => plot.top + ((max - price) / span) * (height - plot.top - plot.bottom);
  const x = (index) => plot.left + (index / Math.max(candles.length - 1, 1)) * (width - plot.left - plot.right);
  return { min, max, span, x, y };
}

function renderChart() {
  const svg = els.chart;
  svg.innerHTML = "";
  const vLimit = visibleLimit();
  const maxPan = Math.max(0, chartCandles.length - vLimit);
  panOffset = Math.max(0, Math.min(panOffset, maxPan));
  const endIndex = chartCandles.length - Math.floor(panOffset);
  const startIndex = Math.max(0, endIndex - vLimit);
  const candles = chartCandles.slice(startIndex, endIndex);
  if (!candles.length) {
    svg.innerHTML = `<text x="32" y="72" fill="#9aa697" font-size="20">No real candle data from upstream</text>`;
    return;
  }

  const width = 900;
  const height = 430;
  const plot = { left: 22, right: 108, top: 24, bottom: 42 };
  const scale = chartScale(candles, width, height, plot);
  const plotRight = width - plot.right;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((step) => {
      const price = scale.max - scale.span * step;
      const y = plot.top + step * (height - plot.top - plot.bottom);
      return `
        <line x1="${plot.left}" x2="${plotRight}" y1="${y}" y2="${y}" stroke="#26332b"></line>
        <text x="${plotRight + 12}" y="${y + 6}" fill="#9aa697" font-size="16">${formatPrice(price)}</text>
      `;
    })
    .join("");

  let xAxis = "";
  const tickCount = 6;
  const drawnIndices = new Set();
  for (let i = 0; i < tickCount; i++) {
    const index = Math.floor((candles.length - 1) * (i / (tickCount - 1)));
    if (drawnIndices.has(index)) continue;
    drawnIndices.add(index);
    const c = candles[index];
    if (c) {
      const xPos = scale.x(index);
      
      // Round to nearest logical boundary for cleaner labels
      let timeStr = "";
      const intervalMsVal = intervalMs();
      const dt = new Date(c.timestamp ? c.timestamp * 1000 : toTimestamp(c.time));
      
      const showDate = intervalMsVal >= 900000; // >= 15 minutes
      if (activeInterval.endsWith("d")) {
        timeStr = dt.toLocaleDateString([], { month: "short", day: "numeric" });
      } else if (showDate) {
        timeStr = dt.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      } else {
        timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      }
      
      let anchor = "middle";
      let xOff = xPos;
      if (i === 0) { anchor = "start"; xOff = plot.left; }
      if (i === tickCount - 1) { anchor = "end"; xOff = plotRight - 4; }
      xAxis += `<text x="${xOff}" y="${height - 14}" fill="#737373" font-size="11" text-anchor="${anchor}">${timeStr}</text>`;
      xAxis += `<line x1="${xPos}" x2="${xPos}" y1="${plot.top}" y2="${height - 30}" stroke="rgba(255,255,255,0.05)" stroke-width="1"></line>`;
    }
  }

  const slot = (plotRight - plot.left) / Math.max(candles.length, 1);
  const bodyWidth = Math.max(5, Math.min(13, slot * 0.58));
  let series = "";

  if (chartMode === "line") {
    const points = candles.map((candle, index) => `${scale.x(index).toFixed(2)},${scale.y(candle.close).toFixed(2)}`).join(" ");
    const last = candles.at(-1);
    const lastTone = (detail?.change || 0) >= 0 ? "#00ff66" : "#ff3333";
    series = `
      <polyline points="${points}" fill="none" stroke="${lastTone}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
      <circle cx="${scale.x(candles.length - 1)}" cy="${scale.y(last.close)}" r="3" fill="${lastTone}"></circle>
    `;
  } else {
    series = candles
      .map((candle, index) => {
        const x = scale.x(index);
        const openY = scale.y(candle.open);
        const closeY = scale.y(candle.close);
        const highY = scale.y(candle.high);
        const lowY = scale.y(candle.low);
        const up = candle.close >= candle.open;
        const tone = up ? "#2eff88" : "#ff4c56";
        const top = Math.min(openY, closeY);
        const bodyHeight = Math.max(1, Math.abs(closeY - openY));
        const fill = up ? "#2eff88" : "#ff4c56";
        return `
          <line class="candle wick" x1="${x}" x2="${x}" y1="${highY}" y2="${lowY}" stroke="${tone}" stroke-width="1"></line>
          <rect class="candle body" x="${x - bodyWidth / 2}" y="${top}" width="${bodyWidth}" height="${bodyHeight}" fill="${fill}" stroke="${tone}" stroke-width="1"></rect>
        `;
      })
      .join("");
  }

  let positionLines = "";
  const existingLots = savedPortfolio.filter(p => p.symbol === activeSymbol);
  
  existingLots.forEach((lot) => {
    const posY = scale.y(lot.avgPrice);
    if (posY >= plot.top && posY <= height - plot.bottom) {
      positionLines += `
        <line x1="${plot.left}" x2="${plotRight}" y1="${posY}" y2="${posY}" stroke="${lot.color || 'var(--cyan)'}" stroke-width="1.5" stroke-dasharray="4 4" class="position-line"></line>
        <g style="pointer-events: none;">
          <rect x="${plot.left + 5}" y="${posY - 8}" width="42" height="16" fill="var(--bg)" stroke="${lot.color || 'var(--cyan)'}" stroke-width="1" rx="2"></rect>
          <text x="${plot.left + 26}" y="${posY + 3}" fill="${lot.color || 'var(--cyan)'}" font-size="9" text-anchor="middle" font-weight="bold">${formatPrice(lot.avgPrice)}</text>
        </g>
      `;
    }
  });

  const last = candles.at(-1);
  const lastTone = last.close >= last.open ? "#2eff88" : "#ff4c56";
  const lastY = scale.y(last.close);
  svg.innerHTML = `
    <rect x="${plot.left}" y="${plot.top}" width="${plotRight - plot.left}" height="${height - plot.top - plot.bottom}" fill="rgba(5,10,7,0.34)"></rect>
    ${grid}
    ${xAxis}
    ${series}
    <line x1="${plot.left}" x2="${plotRight}" y1="${lastY}" y2="${lastY}" stroke="${lastTone}" stroke-width="1" stroke-dasharray="2 3"></line>
    <path d="M${plotRight + 4} ${lastY} L${plotRight + 10} ${lastY - 9} H${width - 6} V${lastY + 9} H${plotRight + 10} Z" fill="#000" stroke="${lastTone}"></path>
    <text x="${plotRight + 14}" y="${lastY + 4}" fill="${lastTone}" font-size="12" font-weight="bold">${formatPrice(last.close)}</text>
    ${positionLines}
  `;
}

// Tooltip logic removed as per plan

function scheduleFocusRender() {
  if (pendingFocusRender) return;
  pendingFocusRender = true;
  requestAnimationFrame(() => {
    pendingFocusRender = false;
    renderFocus();
  });
}

function renderBook(book) {
  els.bids.innerHTML = "";
  els.asks.innerHTML = "";
  const bestBid = book.bids?.[0]?.price;
  const bestAsk = book.asks?.[0]?.price;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
  const renderSide = (container, rows, className) => {
    const maxSize = Math.max(...rows.map(r => r.size || 0), 10);
    rows.slice(0, 10).forEach((row) => {
      const sizePct = Math.min(100, Math.max(5, (row.size / maxSize) * 100));
      const div = document.createElement("div");
      div.className = `book-row ${className}`;
      div.innerHTML = `<div class="book-row-bg" style="width: ${sizePct}%"></div><span>${formatPrice(row.price)}</span><span>${formatPrice(row.size)}</span><small>${row.orders || ""}</small>`;
      container.appendChild(div);
    });
  };
  renderSide(els.bids, book.bids || [], "positive");
  renderSide(els.asks, book.asks || [], "negative");
  els.flowSource.textContent = spread ? `SPR ${formatPrice(spread)}` : book.source || "--";
}

function renderNoBook(symbol) {
  els.bids.innerHTML = `<div class="empty-flow">No public level 2 book for ${symbol} on this feed.</div>`;
  els.asks.innerHTML = "";
  els.flowSource.textContent = "LAST SALE";
}

function renderTape(payload) {
  els.tape.innerHTML = "";
  (payload.trades || []).slice(0, 14).forEach((trade) => {
    const row = document.createElement("div");
    row.className = `tape-row ${trade.side || "neutral"}`;
    row.innerHTML = `<span>${shortTime(trade.time)}</span><strong>${formatPrice(trade.price)}</strong><small>${formatPrice(trade.size)}</small>`;
    els.tape.appendChild(row);
  });
}

async function loadDesk() {
  let symbols = [];
  if (activeTab === "watchlist") symbols = savedWatchlist;
  else if (activeTab === "portfolio") symbols = Array.from(new Set(savedPortfolio.map(p => p.symbol)));
  else if (activeTab === "history") symbols = Array.from(new Set(tradeHistory.map(t => t.symbol)));
  
  if (!symbols.length) {
    quotes = [];
    if (activeTab === "watchlist") renderWatchlist();
    else if (activeTab === "portfolio") renderPortfolio();
    return;
  }
  
  const payload = await fetchFromApi(`/api/desk?symbols=${encodeURIComponent(symbols.join(","))}`);
  quotes = payload.quotes || [];
  pulse = payload.pulse;
  alerts = payload.alerts || [];
  signals = payload.signals || [];
  els.clock.textContent = shortTime(payload.fetchedAt);
  
  if (activeTab === "watchlist") renderWatchlist();
  else if (activeTab === "portfolio") renderPortfolio();
  
  renderTicker();
  renderPulse();
}

async function loadCandles() {
  const tzOffset = new Date().getTimezoneOffset();
  const payload = await fetchFromApi(
    `/api/candles/${encodeURIComponent(activeSymbol)}?interval=${encodeURIComponent(activeInterval)}&tz=${tzOffset}`
  );
  lastCandlePayload = payload;
  const restCandles = normalizeCandles(payload.candles);
  baseRestCandles = restCandles;
  chartCandles = mergeLiveCandles(restCandles);
  updateChartCaption(` | ${payload.isRealtime ? "LIVE CAPABLE" : "DELAYED"}`);
  renderChart();
  renderFocus();
}

async function loadDetail(symbol) {
  detail = await fetchFromApi(`/api/quotes/${encodeURIComponent(symbol)}`);
  if (!chartCandles.length) chartCandles = normalizeCandles(detail.candles);
  renderFocus();
}

async function loadFlow(symbol) {
  if (CRYPTO_SYMBOLS.has(symbol)) {
    const book = await fetchFromApi(`/api/orderbook/${encodeURIComponent(symbol)}`);
    renderBook(book);
  } else {
    renderNoBook(symbol);
  }
  const tape = await fetchFromApi(`/api/tape/${encodeURIComponent(symbol)}`);
  renderTape(tape);
}

async function loadNews() {
  if (!activeSymbol) return;
  try {
    const data = await fetchFromApi(`/api/news/${encodeURIComponent(activeSymbol)}`);
    const list = document.getElementById("news-list");
    if (!list) return;
    if (!data.news || data.news.length === 0) {
      list.innerHTML = `<span class="caption">No recent news</span>`;
      return;
    }
    list.innerHTML = data.news.map(item => {
      const sentClass = `sentiment-${item.sentiment}`;
      const sentText = item.sentiment === "positive" ? "BUY SIGNAL" : (item.sentiment === "negative" ? "SELL SIGNAL" : "NEUTRAL");
      
      let timeStr = "";
      if (item.time) {
        const d = new Date(item.time * 1000);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        timeStr = `${hh}:${mm}`;
      }
      
      let tickerBadge = "";
      if (item.ticker) {
        const changeStr = item.tickerChange ? `${item.tickerChange > 0 ? "+" : ""}${item.tickerChange.toFixed(2)}%` : "";
        const changeClass = item.tickerChange > 0 ? "positive" : (item.tickerChange < 0 ? "negative" : "neutral");
        tickerBadge = `<span class="news-ticker-badge" style="cursor:pointer;" onclick="selectSymbol('${item.ticker}')">${item.ticker} <span class="${changeClass}">${changeStr}</span></span>`;
      }
      
      return `
        <div class="news-item">
          <a href="${item.link}" target="_blank" rel="noopener noreferrer">${item.title}</a>
          <div class="news-meta">
            <span>${tickerBadge} &bull; ${item.publisher} &bull; ${timeStr}</span>
            <span class="${sentClass}">${sentText}</span>
          </div>
        </div>
      `;
    }).join("");
  } catch (err) {
    console.error("News error", err);
  }
}

async function refreshAll() {
  try {
    try { await loadDesk(); } catch (e) { console.error("loadDesk failed", e); }
    try { await loadDetail(activeSymbol); } catch (e) { console.error("loadDetail failed", e); }
    try { await loadCandles(); } catch (e) { console.error("loadCandles failed", e); }
    try { await loadFlow(activeSymbol); } catch (e) { console.error("loadFlow failed", e); }
    try { await loadNews(); } catch (e) { console.error("loadNews failed", e); }
    setStatus(`API ${apiBase || "same-origin"} ${new Date().toLocaleTimeString([], { hour12: false })}`, "ok");
  } catch (error) {
    setStatus(`Backend unavailable: ${error.message}`, "error");
  }
}

async function refreshFlowOnly() {
  try {
    await loadFlow(activeSymbol);
  } catch (error) {
    setStatus(`Flow update failed: ${error.message}`, "error");
  }
}

async function refreshCandlesOnly() {
  try {
    await loadCandles();
  } catch (error) {
    setStatus(`Candle update failed: ${error.message}`, "error");
  }
}

function connectStream(symbol) {
  if (tickSocket) tickSocket.close();
  tickSocket = null;
  if (!CRYPTO_SYMBOLS.has(symbol)) return;

  tickSocket = new WebSocket(websocketUrl(`/api/stream/${encodeURIComponent(symbol)}`));
  tickSocket.addEventListener("message", (event) => {
    const tick = JSON.parse(event.data);
    applyTickToCandle(tick);
    setStatus(`STREAM ${symbol} ${shortTime(tick.time || tick.fetchedAt)}`, "ok");
  });
  tickSocket.addEventListener("error", () => setStatus(`Stream unavailable for ${symbol}`, "error"));
}

async function selectSymbol(symbol) {
  if (!symbol) return;
  activeSymbol = symbol;
  panOffset = 0;
  chartCandles = [];
  liveCandleUpdates.clear();
  lastCandlePayload = null;
  connectStream(symbol);
  await refreshAll();
}

function setActiveButtons(container, key, value) {
  container.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset[key] === value);
  });
}

function bindControls() {
  els.timeframeControls.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      activeInterval = button.dataset.interval;
      panOffset = 0;
      setActiveButtons(els.timeframeControls, "interval", activeInterval);
      chartCandles = [];
      baseRestCandles = [];
      liveCandleUpdates.clear();
      lastCandlePayload = null;
      await refreshCandlesOnly();
    });
  });

  els.chartModeControls.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      chartMode = button.dataset.mode;
      setActiveButtons(els.chartModeControls, "mode", chartMode);
      updateChartCaption();
      renderChart();
    });
  });
  els.railTabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      setActiveButtons(els.railTabs, "tab", activeTab);
      
      els.watchlist.classList.add("hidden");
      els.historyList.classList.add("hidden");
      els.portfolioList.classList.add("hidden");
      
      if (activeTab === "watchlist") {
        els.watchlist.classList.remove("hidden");
        renderWatchlist();
      } else if (activeTab === "portfolio") {
        els.portfolioList.classList.remove("hidden");
        renderPortfolio();
      } else if (activeTab === "history") {
        els.historyList.classList.remove("hidden");
        renderHistory();
      }
    });
  });
  els.pinBtn.addEventListener("click", () => {
    if (savedWatchlist.includes(activeSymbol)) {
      savedWatchlist = savedWatchlist.filter((s) => s !== activeSymbol);
    } else {
      savedWatchlist.push(activeSymbol);
    }
    updateStorage();
    renderFocus();
    if (activeTab === "watchlist") loadDesk();
  });

  // Trade Modal Listeners
  let currentTradeSide = "buy";

  function openTradeModal(side) {
    currentTradeSide = side;
    const q = quotes.find(quote => quote.symbol === activeSymbol);
    const price = q ? q.price : 0;
    
    els.modalTitle.textContent = `${side.toUpperCase()} ${activeSymbol}`;
    els.modalPrice.textContent = formatPrice(price);
    
    els.orderModal.querySelector(".modal-box").className = `modal-box ${side}-mode`;
    els.orderModal.classList.remove("hidden");
    
    // reset/update inputs
    els.orderQty.value = 1;
    els.orderTotal.textContent = `$${formatPrice(price * 1)}`;
  }

  els.btnBuy.addEventListener("click", () => openTradeModal("buy"));
  els.btnSell.addEventListener("click", () => openTradeModal("sell"));

  els.modalClose.addEventListener("click", () => {
    els.orderModal.classList.add("hidden");
  });

  els.orderQty.addEventListener("input", (e) => {
    const q = quotes.find(quote => quote.symbol === activeSymbol);
    const price = q ? q.price : 0;
    const qty = parseFloat(e.target.value) || 0;
    els.orderTotal.textContent = `$${formatPrice(price * qty)}`;
  });

  els.modalConfirm.addEventListener("click", () => {
    const q = quotes.find(quote => quote.symbol === activeSymbol);
    const price = q ? q.price : 0;
    const qty = parseFloat(els.orderQty.value) || 0;
    if (qty > 0 && price > 0) {
      executeTrade(activeSymbol, currentTradeSide, qty, price);
      els.orderModal.classList.add("hidden");
    }
  });
}

function startTimers() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (flowTimer) clearInterval(flowTimer);
  if (candleTimer) clearInterval(candleTimer);
  refreshTimer = setInterval(loadDesk, DESK_INTERVAL_MS);
  flowTimer = setInterval(refreshFlowOnly, FLOW_INTERVAL_MS);
  candleTimer = setInterval(refreshCandlesOnly, CANDLE_REFRESH_MS);
}

els.refresh.addEventListener("click", refreshAll);
let searchTimeout = null;
const searchDropdown = document.getElementById("search-dropdown");
let searchResults = [];
let searchSelectedIndex = -1;

function renderSearchResults() {
  if (searchResults.length === 0) {
    searchDropdown.classList.add("hidden");
    return;
  }
  searchSelectedIndex = -1;
  searchDropdown.innerHTML = searchResults.map((item, i) => `
    <div class="search-item" data-index="${i}" onclick="selectSearchResult(${i})">
      <span class="sym">${item.symbol}</span>
      <span class="name">${item.name || item.type} ${item.exchange ? `(${item.exchange})` : ""}</span>
    </div>
  `).join("");
  searchDropdown.classList.remove("hidden");
}

window.selectSearchResult = async function(index) {
  const item = searchResults[index];
  if (item) {
    const sym = item.symbol.toUpperCase();
    try {
      await fetchFromApi(`/api/quotes/${encodeURIComponent(sym)}`);
      addToHistory(sym);
      selectSymbol(sym);
    } catch (err) {
      setStatus(`Symbol not found: ${sym}`, "error");
    }
    els.command.value = "";
    searchDropdown.classList.add("hidden");
  }
};

function updateSearchSelection() {
  const items = searchDropdown.querySelectorAll(".search-item");
  items.forEach((item, i) => {
    item.classList.toggle("active", i === searchSelectedIndex);
    if (i === searchSelectedIndex) {
      item.scrollIntoView({ block: "nearest" });
    }
  });
}

document.addEventListener("click", (e) => {
  if (!els.command.contains(e.target) && !searchDropdown.contains(e.target)) {
    searchDropdown.classList.add("hidden");
  }
});

window.addEventListener("resize", renderChart);
window.addEventListener("resize", renderFocus);

els.chart.addEventListener("mousedown", (e) => {
  e.preventDefault();
  isPanning = true;
  lastPanX = e.clientX;
});
window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  const dx = e.clientX - lastPanX;
  if (Math.abs(dx) > 0) {
    const pixelsPerBar = (window.innerWidth - 120) / visibleLimit();
    panOffset += dx / pixelsPerBar;
    lastPanX = e.clientX;
    renderChart();
  }
});
window.addEventListener("mouseup", () => isPanning = false);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    els.command.focus();
  }
});

els.command.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const val = e.target.value.trim();
    if (val.startsWith("/")) {
      const parts = val.slice(1).split(" ");
      const cmd = parts[0].toLowerCase();
      if (cmd === "chart" && parts[1]) {
         const sym = parts[1].toUpperCase();
         selectSymbol(sym);
         // Optionally add to watchlist if not there
      }
      e.target.value = "";
      els.command.blur();
    } else if (searchResults.length > 0) {
      selectSearchResult(0);
    }
  }
});

els.command.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  if (!query || query.startsWith("/")) {
    searchDropdown.classList.add("hidden");
    return;
  }
  
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    try {
      const data = await fetchFromApi(`/api/search?q=${encodeURIComponent(query)}`);
      searchResults = data.results || [];
      renderSearchResults();
    } catch (err) {
      console.error("Search error:", err);
    }
  }, 300);
});

async function handleCommand(cmdStr) {
  const parts = cmdStr.split(" ");
  const cmd = parts[0].toLowerCase();
  
  if (cmd === "/chart" || cmd === "/c") {
    const sym = parts[1];
    const intv = parts[2];
    if (sym) {
      const upperSym = sym.toUpperCase();
      try {
        await fetchFromApi(`/api/quotes/${encodeURIComponent(upperSym)}`);
        addToHistory(upperSym);
        selectSymbol(upperSym);
      } catch (err) {
        setStatus(`Symbol not found: ${upperSym}`, "error");
      }
    }
    if (intv && ["1m", "2m", "5m", "15m", "1h", "1d", "1wk"].includes(intv)) {
      activeInterval = intv;
      document.querySelectorAll(".time-selector button").forEach(b => b.classList.toggle("active", b.dataset.int === intv));
      fetchData();
    }
  } else if (cmd === "/clear") {
    savedWatchlist = ["BTC-USD"];
    localStorage.setItem("traderWatchlist", JSON.stringify(savedWatchlist));
    fetchData();
  }
}

els.command.addEventListener("keydown", async (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!searchDropdown.classList.contains("hidden") && searchSelectedIndex < searchResults.length - 1) {
      searchSelectedIndex++;
      updateSearchSelection();
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!searchDropdown.classList.contains("hidden") && searchSelectedIndex > 0) {
      searchSelectedIndex--;
      updateSearchSelection();
    }
  } else if (event.key === "Enter") {
    if (!searchDropdown.classList.contains("hidden") && searchSelectedIndex >= 0) {
      event.preventDefault();
      selectSearchResult(searchSelectedIndex);
      return;
    }
    const requested = els.command.value.trim();
    if (!requested) return;
    
    if (requested.startsWith("/")) {
      handleCommand(requested);
      els.command.value = "";
      return;
    }
    
    els.command.value = "";
    searchDropdown.classList.add("hidden");
    const alias = symbolAlias(requested);
    try {
      await fetchFromApi(`/api/quotes/${encodeURIComponent(alias)}`);
      addToHistory(alias);
      selectSymbol(alias);
    } catch (err) {
      setStatus(`Symbol not found: ${alias}`, "error");
    }
  } else if (event.key === "Escape") {
    searchDropdown.classList.add("hidden");
  }
});

bindControls();
connectStream(activeSymbol);
refreshAll();
startTimers();
