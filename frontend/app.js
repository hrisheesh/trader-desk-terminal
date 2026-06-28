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
    const data = JSON.parse(localStorage.getItem("trader-desk-history"));
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
};

function updateStorage() {
  localStorage.setItem("trader-desk-watchlist", JSON.stringify(savedWatchlist));
  localStorage.setItem("trader-desk-history", JSON.stringify(savedHistory));
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
    <div><span>Up</span><strong>${pulse.upCount}</strong></div>
    <div><span>Down</span><strong>${pulse.downCount}</strong></div>
    <div><span>Feeds</span><strong>${pulse.liveFeeds} LIVE</strong></div>
    <div><span>Notional</span><strong>${formatVolume(pulse.notionalVolume)}</strong></div>
  `;

  const movers = [...quotes].sort((a, b) => Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0)).slice(0, 5);
  els.movers.innerHTML = movers
    .map((quote) => {
      const width = Math.min(100, Math.abs(quote.changePercent || 0) * 14);
      return `
        <div class="mover-row">
          <span>${quote.symbol}</span>
          <div class="mover-bar"><i class="${toneClass(quote.change)}" style="width:${width}%"></i></div>
          <strong class="${toneClass(quote.change)}">${quote.changePercent > 0 ? "+" : ""}${(quote.changePercent || 0).toFixed(2)}%</strong>
        </div>
      `;
    })
    .join("");

  els.alerts.innerHTML = alerts
    .map((alert) => `<div class="alert-row ${alert.level}"><strong>${alert.symbol}</strong><span>${alert.message}</span></div>`)
    .join("");
}

function renderSignals() {
  const activeSignals = detail?.signals || signals.find((item) => item.symbol === activeSymbol);
  if (!activeSignals) {
    els.signals.innerHTML = `<div class="signal-row neutral"><span>Waiting signal data</span></div>`;
    return;
  }
  const dirClass =
    activeSignals.direction === "up" ? "positive" : activeSignals.direction === "down" ? "negative" : "neutral";
  els.signals.innerHTML = `
    <div class="signal-tile ${dirClass}">
      <span>Bias</span><strong>${activeSignals.direction.toUpperCase()} ${activeSignals.confidence}%</strong>
    </div>
    <div class="signal-row"><span>EMA 9 / 21</span><strong>${formatPrice(activeSignals.ema9)} / ${formatPrice(activeSignals.ema21)}</strong></div>
    <div class="signal-row"><span>RSI 14</span><strong>${formatPrice(activeSignals.rsi14)}</strong></div>
    <div class="signal-row"><span>VWAP</span><strong>${formatPrice(activeSignals.vwap)}</strong></div>
    <div class="signal-row"><span>Realized vol</span><strong>${formatPrice(activeSignals.realizedVol)}%</strong></div>
  `;
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
  els.pinBtn.className = isPinned ? "pin-btn active" : "pin-btn";
  updateChartCaption();
  renderChart();
  renderSignals();
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

function normalizeCandles(candles) {
  return (candles || [])
    .filter((candle) => ["open", "high", "low", "close"].every((key) => Number.isFinite(Number(candle[key]))))
    .map((candle) => ({
      time: candle.time,
      timestamp: toTimestamp(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-160);
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
  return merged.sort((a, b) => a.timestamp - b.timestamp).slice(-160);
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
  const candles = chartCandles.slice(-visibleLimit());
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
  for (let i = 0; i < tickCount; i++) {
    const index = Math.floor((candles.length - 1) * (i / (tickCount - 1)));
    const c = candles[index];
    if (c) {
      const xPos = scale.x(index);
      const timeStr = shortTime(c.timestamp);
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
        const fill = up ? tone : "transparent";
        return `
          <line class="candle wick" x1="${x}" x2="${x}" y1="${highY}" y2="${lowY}" stroke="${tone}" stroke-width="1"></line>
          <rect class="candle body" x="${x - bodyWidth / 2}" y="${top}" width="${bodyWidth}" height="${bodyHeight}" fill="${fill}" stroke="${tone}" stroke-width="1"></rect>
        `;
      })
      .join("");
  }

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
  `;
}

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
    rows.slice(0, 10).forEach((row) => {
      const div = document.createElement("div");
      div.className = `book-row ${className}`;
      div.innerHTML = `<span>${formatPrice(row.price)}</span><span>${formatPrice(row.size)}</span><small>${row.orders || ""}</small>`;
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
  const symbols = activeTab === "watchlist" ? savedWatchlist : savedHistory;
  if (!symbols.length) {
    quotes = [];
    renderWatchlist();
    return;
  }
  const payload = await fetchFromApi(`/api/desk?symbols=${encodeURIComponent(symbols.join(","))}`);
  quotes = payload.quotes || [];
  pulse = payload.pulse;
  alerts = payload.alerts || [];
  signals = payload.signals || [];
  els.clock.textContent = shortTime(payload.fetchedAt);
  renderWatchlist();
  renderTicker();
  renderPulse();
  renderSignals();
}

async function loadCandles() {
  const payload = await fetchFromApi(
    `/api/candles/${encodeURIComponent(activeSymbol)}?interval=${encodeURIComponent(activeInterval)}`
  );
  lastCandlePayload = payload;
  const restCandles = normalizeCandles(payload.candles);
  baseRestCandles = restCandles;
  chartCandles = mergeLiveCandles(restCandles);
  updateChartCaption(` | ${payload.isRealtime ? "LIVE CAPABLE" : "DELAYED"}`);
  renderChart();
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

async function refreshAll() {
  try {
    await loadDesk();
    await loadDetail(activeSymbol);
    await loadCandles();
    await loadFlow(activeSymbol);
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
  if (!symbol || symbol === activeSymbol) return;
  activeSymbol = symbol;
  chartCandles = [];
  baseRestCandles = [];
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
      loadDesk();
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
els.command.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const requested = symbolAlias(els.command.value);
  if (!requested) return;
  els.command.value = "";
  try {
    // Validate by fetching quote
    await fetchFromApi(`/api/quotes/${encodeURIComponent(requested)}`);
    addToHistory(requested);
    selectSymbol(requested);
  } catch (err) {
    setStatus(`Symbol not found: ${requested}`, "error");
  }
});

bindControls();
connectStream(activeSymbol);
refreshAll();
startTimers();
