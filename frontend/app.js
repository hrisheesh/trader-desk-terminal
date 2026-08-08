const API_CANDIDATES = buildApiCandidates();
const DESK_INTERVAL_MS = 1500;
const FLOW_INTERVAL_MS = 1200;
const CANDLE_REFRESH_MS = 30000;
const CRYPTO_SYMBOLS = new Set(["BTC-USD", "ETH-USD"]);
const BOT_CRYPTO_SYMBOLS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "XRP-USD",
  "DOGE-USD",
  "ADA-USD",
  "AVAX-USD",
  "LINK-USD",
  "DOT-USD",
  "LTC-USD",
  "BCH-USD",
  "UNI-USD",
  "ATOM-USD",
  "ETC-USD",
  "XLM-USD",
  "FIL-USD",
  "ALGO-USD",
  "ICP-USD",
  "HBAR-USD",
  "NEAR-USD",
  "APT-USD",
  "SUI-USD",
  "OP-USD",
  "ARB-USD",
  "INJ-USD",
  "AAVE-USD",
  "SHIB-USD",
  "PEPE-USD",
  "BONK-USD",
  "WIF-USD",
  "FLOKI-USD",
  "TON-USD",
  "POL-USD",
  "CRO-USD",
  "VET-USD",
  "GRT-USD",
  "STX-USD",
  "IMX-USD",
  "SEI-USD",
  "TIA-USD",
  "TAO-USD",
  "FET-USD",
  "ENA-USD",
  "ONDO-USD",
  "CRV-USD",
  "ZEC-USD",
];
const INTERVAL_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };
const VISIBLE_BARS = { "1m": 80, "5m": 84, "15m": 80, "1h": 72, "6h": 60, "1d": 90 };

let apiBase = API_CANDIDATES[0];
const DEFAULT_SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT", "BTC-USD", "ETH-USD", "SOXL", "SPY"];
let watchlists = (() => {
  try {
    const data = JSON.parse(localStorage.getItem("trader-desk-watchlists"));
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
      return data;
    }
  } catch(e) {}
  
  // Migration from old flat array
  try {
    const oldData = JSON.parse(localStorage.getItem("trader-desk-watchlist"));
    if (Array.isArray(oldData) && oldData.length > 0) {
      return { "My Watchlist": oldData };
    }
  } catch(e) {}
  
  return { "My Watchlist": DEFAULT_SYMBOLS };
})();

let activeWatchlistName = (() => {
  const saved = localStorage.getItem("trader-desk-active-watchlist");
  return (saved && watchlists[saved]) ? saved : Object.keys(watchlists)[0];
})();

let savedWatchlist = watchlists[activeWatchlistName];

const GLOBAL_MARKETS = [
  { name: "US Markets", tz: "America/New_York", open: "09:30", close: "16:00", symbols: ["AAPL", "MSFT", "NVDA", "SPY", "QQQ"] },
  { name: "China (SSE)", tz: "Asia/Shanghai", open: "09:30", close: "15:00", symbols: ["BABA", "TCEHY", "BIDU"] },
  { name: "Japan (TSE)", tz: "Asia/Tokyo", open: "09:00", close: "15:00", symbols: ["TM", "SONY", "HMC"] },
  { name: "Europe (Euronext)", tz: "Europe/Paris", open: "09:00", close: "17:30", symbols: ["ASML", "LVMUY", "SAP"] },
  { name: "Hong Kong (HKEX)", tz: "Asia/Hong_Kong", open: "09:30", close: "16:00", symbols: ["0700.HK", "9988.HK", "3690.HK"] },
  { name: "India (NSE/BSE)", tz: "Asia/Kolkata", open: "09:15", close: "15:30", symbols: ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS"] },
  { name: "UK (LSE)", tz: "Europe/London", open: "08:00", close: "16:30", symbols: ["SHEL", "ASTL", "HSBC"] },
  { name: "Canada (TSX)", tz: "America/Toronto", open: "09:30", close: "16:00", symbols: ["RY", "TD", "SHOP"] },
  { name: "Saudi Arabia (Tadawul)", tz: "Asia/Riyadh", open: "10:00", close: "15:00", symbols: ["2222.SR", "1120.SR", "2010.SR"] },
  { name: "Switzerland (SIX)", tz: "Europe/Zurich", open: "09:00", close: "17:30", symbols: ["NSRGY", "ROG.SW", "NOVN.SW"] },
  { name: "Crypto 24/7", tz: "UTC", open: "00:00", close: "23:59", symbols: BOT_CRYPTO_SYMBOLS }
];

function isMarketOpen(market) {
  if (market.name === "Crypto 24/7") return true;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: market.tz,
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(new Date());
    const h = parts.find(p => p.type === 'hour').value.padStart(2, '0');
    const m = parts.find(p => p.type === 'minute').value.padStart(2, '0');
    const time = `${h}:${m}`;
    return time >= market.open && time <= market.close;
  } catch(e) {
    return false;
  }
}

function getMarketWatchlists() {
  const result = {};
  for (const m of GLOBAL_MARKETS) {
    const status = isMarketOpen(m) ? "🟢 Live" : "🔴 Closed";
    result[`${m.name} (${status})`] = m.symbols;
  }
  return result;
}
let savedHistory = (() => {
  try {
    const data = JSON.parse(localStorage.getItem("trader-desk-history"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
})();
let savedPortfolio = (() => {
  try {
    const data = JSON.parse(localStorage.getItem("trader-desk-portfolio"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
})();
let walletCash = (() => {
  try {
    const cash = localStorage.getItem("trader-desk-wallet-cash");
    return cash ? parseFloat(cash) : 100000;
  } catch (e) {
    return 100000;
  }
})();
let startingBalance = (() => {
  try {
    const start = localStorage.getItem("trader-desk-wallet-start");
    return start ? parseFloat(start) : 100000;
  } catch (e) {
    return 100000;
  }
})();
let tradeHistory = (() => {
  try {
    const data = JSON.parse(localStorage.getItem("trader-desk-trade-history"));
    if (!Array.isArray(data)) return [];
    return data.slice(-500);
  } catch (e) {
    return [];
  }
})();
let activeTab = "watchlist";

let activeSymbol = savedWatchlist[0] || DEFAULT_SYMBOLS[0];
let activeInterval = "1m";
let chartMode = "candles";
let previousPrices = new Map();
let quotes = [];
window.getBotUniverseQuotes = () => quotes;
let activeChartScale = null;
let pulse = null;
let alerts = [];
let detail = null;
let signals = [];
let chartCandles = [];
let baseRestCandles = [];
let lwChart = null;
let lwSeries = null;
let lwLineSeries = null;
let lwVolumeSeries = null;
let lwEma9 = null;
let lwEma21 = null;
let lastCandlePayload = null;
let activeFeed = null;
let isRealtime = false;
let liveCandleUpdates = new Map();
let emaVisible = true;
let pendingFocusRender = false;
let refreshTimer = null;
let deskLoadInFlight = false;
let flowTimer = null;
let candleTimer = null;
let tickSocket = null;
let panOffset = 0;
let isPanning = false;
let lastPanX = 0;

const els = {
  command: document.querySelector("#command-input"),
  watchlist: document.querySelector("#watchlist"),
  watchlistSelector: document.querySelector("#watchlist-selector"),
  watchlistAdd: document.querySelector("#watchlist-add"),
  watchlistRename: document.querySelector("#watchlist-rename"),
  watchlistDelete: document.querySelector("#watchlist-delete"),
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
  signals: document.querySelector("#signals-list"),
  timeframeControls: document.querySelector("#timeframe-controls"),
  chartModeControls: document.querySelector("#chart-mode-controls"),
  railTabs: document.querySelector("#rail-tabs"),
  historyList: document.querySelector("#history-list"),
  historyTab: document.querySelector("#history-tab"),
  historyChart: document.querySelector("#history-chart"),
  portfolioList: document.querySelector("#portfolio-list"),
  btnBuy: document.querySelector("#btn-buy"),
  btnSell: document.querySelector("#btn-sell"),
  btnBot: document.querySelector("#btn-bot"),
  botModal: document.querySelector("#bot-modal"),
  botClose: document.querySelector("#bot-close"),
  botStart: document.querySelector("#bot-start"),
  botStop: document.querySelector("#bot-stop"),
  botState: document.querySelector("#bot-state"),
  botSummary: document.querySelector("#bot-summary"),
  botClearLog: document.querySelector("#bot-clear-log"),
  botReset: document.querySelector("#bot-reset"),
  botUniverseMode: document.querySelector("#bot-universe-mode"),
  botHome: document.querySelector("#bot-home"),
  orderModal: document.querySelector("#order-modal"),
  modalClose: document.querySelector("#modal-close"),
  modalConfirm: document.querySelector("#modal-confirm"),
  orderQty: document.querySelector("#order-qty"),
  orderTotal: document.querySelector("#order-total"),
  modalPrice: document.querySelector("#modal-price"),
  modalTitle: document.querySelector("#modal-title"),
  lightningBuy: document.querySelector("#btn-lightning-buy"),
  lightningSell: document.querySelector("#btn-lightning-sell"),
  lightningFlatten: document.querySelector("#btn-lightning-flatten"),
  posTracker: document.querySelector("#pos-tracker"),
  terminalOutput: document.querySelector("#terminal-output"),
  terminalClear: document.querySelector("#terminal-clear"),
  ticketBuy: document.querySelector("#ticket-buy"),
  ticketSell: document.querySelector("#ticket-sell"),
  ticketSize: document.querySelector("#ticket-size"),
  ticketModeAmount: document.querySelector("#ticket-mode-amount"),
  ticketModeShares: document.querySelector("#ticket-mode-shares"),
  ticketMarket: document.querySelector("#ticket-market"),
  ticketTrigger: document.querySelector("#ticket-trigger"),
  ticketTriggerPrice: document.querySelector("#ticket-trigger-price"),
  ticketPreview: document.querySelector("#ticket-preview"),
  ticketRisk: document.querySelector("#ticket-risk"),
  ticketSubmit: document.querySelector("#ticket-submit"),
  pendingOrders: document.querySelector("#pending-orders"),
  btnToggleEma: document.querySelector("#btn-toggle-ema"),
};

let lwHistoryChart = null;
let lwHistorySeries = null;
const TERMINAL_MAX_LINES = 100;
const TERMINAL_HISTORY_KEY = "trader-desk-terminal-history";
let terminalHistory = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(TERMINAL_HISTORY_KEY));
    return Array.isArray(stored) ? stored.slice(-50) : [];
  } catch (e) {
    return [];
  }
})();
let terminalHistoryIndex = terminalHistory.length;
const PENDING_ORDERS_KEY = "trader-desk-pending-orders";
let pendingOrders = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(PENDING_ORDERS_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch (e) {
    return [];
  }
})();
let activeTicketSide = "buy";
let ticketSizeMode = "amount";
let ticketOrderType = "market";
const BOT_CONFIG_KEY = "trader-desk-bot-config-v3";
const BOT_STATE_KEY = "trader-desk-bot-state-v4";
const BOT_RUNS_KEY = "trader-desk-bot-runs-v1";
const BOT_PRICE_MEMORY_LIMIT = 200; // 100 seconds at 500ms ticks
const BOT_MIN_TRADE_NOTIONAL = 0.25; // paper minimum; scales with account size below
const BOT_TICK_MS = 500;
const BOT_FEE_RATE = 0.001; // 0.1% per side (maker/taker average)
const BOT_STALE_TICK_LIMIT = 20; // Skip symbols with no price change for 20+ ticks
const BOT_FULLY_DEPLOYED_LOG_MS = 10000;
const BOT_RUN_HISTORY_LIMIT = 20;
const BOT_RUN_AUDIT_LIMIT = 12000;
// Keep the live audit rich in memory, but keep browser storage and the API
// payload below the browser/API size ceilings during long runs.
const BOT_RUN_PERSIST_AUDIT_LIMIT = 600;
const BOT_MODES = {
  calm: {
    label: "Calm",
    capital: 10000,
    philosophy: "protect capital, wait for confirmation, scale into quiet strength",
    riskAppetite: 0.26,
    patience: 0.86,
    convictionBias: 0.72,
    maxExposure: 0.09,
    maxPosition: 0.012,
    stopLossBase: 0.34,
    stopLossVol: 0.12,
    takeProfitBase: 0.18,
    takeProfitVol: 0.12,
    signalBias: 0.4,
  },
  normal: {
    label: "Normal",
    capital: 10000,
    philosophy: "balance trend, signal agreement, and controlled opportunity cost",
    riskAppetite: 0.52,
    patience: 0.58,
    convictionBias: 0.52,
    maxExposure: 0.18,
    maxPosition: 0.025,
    stopLossBase: 0.46,
    stopLossVol: 0.16,
    takeProfitBase: 0.24,
    takeProfitVol: 0.16,
    signalBias: 0.6,
  },
  aggressive: {
    label: "Aggressive",
    capital: 10000,
    philosophy: "hunt acceleration, rotate quickly, accept wider variance for upside",
    riskAppetite: 0.9,
    patience: 0.18,
    convictionBias: 0.26,
    maxExposure: 0.3,
    maxPosition: 0.04,
    stopLossBase: 0.34,
    stopLossVol: 0.16,
    takeProfitBase: 0.15,
    takeProfitVol: 0.22,
    signalBias: 0.8,
  },
};
const defaultBotConfig = {
  durationMin: 30,
  observeMinutes: 2,
  strategyMode: "swarm",
  polymarketInterval: "15m",
  polymarketCapital: 100,
  polymarketModes: { calm: 100, normal: 100, aggressive: 100 },
  universeMode: "watchlist",
  feesEnabled: false,
  multiplierEnabled: false,
  enabled: { calm: true, normal: true, aggressive: true },
  modes: Object.fromEntries(Object.entries(BOT_MODES).map(([mode, def]) => [mode, { capital: def.capital }])),
};
function botFeeRate() {
  return botConfig.feesEnabled === true ? BOT_FEE_RATE : 0;
}
window.botFeeRate = botFeeRate;
function botMultiplierEnabled() {
  return botConfig.multiplierEnabled === true;
}
window.botMultiplierEnabled = botMultiplierEnabled;
function createBotModeState() {
return { positions: {}, trades: [], logs: [], rankings: [], priceMemory: {}, lastTradeAt: {}, lastActionAt: 0, realized: 0, decisions: 0, lastLog: {} };
}
function createBotState() {
  return {
    running: false,
    timer: null,
    startedAt: null,
    stopAt: null,
    modes: Object.fromEntries(Object.keys(BOT_MODES).map(mode => [mode, createBotModeState()])),
  };
}
let botConfig = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(BOT_CONFIG_KEY));
    return {
      ...defaultBotConfig,
      ...(stored || {}),
      enabled: { ...defaultBotConfig.enabled, ...((stored && stored.enabled) || {}) },
      modes: { ...defaultBotConfig.modes, ...((stored && stored.modes) || {}) },
    };
  } catch (e) {
    return { ...defaultBotConfig };
  }
})();
window.botState = undefined;
Object.defineProperty(window, "botState", { get: () => botState, set: (v) => botState = v });
let botState = (() => {
try {
const stored = JSON.parse(localStorage.getItem(BOT_STATE_KEY));
const next = createBotState();
Object.keys(BOT_MODES).forEach(mode => {
      next.modes[mode] = { ...createBotModeState(), ...((stored && stored.modes && stored.modes[mode]) || {}) };
    });
    return next;
} catch (e) {
return createBotState();
}
})();
const polymarketState = {
  running: false,
  startedAt: null,
  stopAt: null,
  interval: "15m",
  capital: 100,
  cash: 100,
  realized: 0,
  position: null,
  trades: [],
  history: [],
  learning: { trades: 0, wins: 0, losses: 0, pnl: 0, bySide: {}, byEdge: {} },
  latest: null,
  lastDecision: null,
  error: "",
  audit: [],
  modelSide: null,
  modelSideCount: 0,
  lastExitAt: 0,
  swarms: {},
  positions: {},
  windowSeen: {},
  sessionAligned: false,
  sessionSlug: null,
  sessionEnd: null,
  inFlight: false,
};
window.polymarketState = polymarketState;
const polymarketSwarmEngine = window.PolymarketSwarmEngine ? new window.PolymarketSwarmEngine(polymarketState) : null;
window.polymarketSwarmEngine = polymarketSwarmEngine;
let polymarketPreviewInFlight = false;
let polymarketPreviewAt = 0;

async function refreshPolymarketPreview(force = false) {
  if (botConfig.strategyMode !== "polymarket" || botState.running || polymarketPreviewInFlight) return;
  if (!force && Date.now() - polymarketPreviewAt < 5_000) return;
  polymarketPreviewInFlight = true;
  polymarketPreviewAt = Date.now();
  polymarketState.interval = botConfig.polymarketInterval || "15m";
  try {
    const data = await fetchFromApi("/api/polymarket/btc");
    polymarketState.latest = data;
    const focus = (data.markets || []).find(row => row.interval === polymarketState.interval);
    const history = focus ? data.spotHistory?.[focus.slug] : null;
    polymarketState.history = Array.isArray(history)
      ? history.map(point => ({ time: Number(point.time), price: Number(point.price) })).filter(point => point.time > 0 && point.price > 0).slice(-1_800)
      : [];
    polymarketState.error = "";
  } catch (error) {
    polymarketState.error = error.message || "Polymarket preview unavailable";
  } finally {
    polymarketPreviewInFlight = false;
    renderPolymarketPanel();
    renderBotStatus();
  }
}
try {
  const savedPolymarketLearning = JSON.parse(localStorage.getItem("trader-desk-polymarket-learning-v1"));
  if (savedPolymarketLearning) polymarketState.learning = {
    ...polymarketState.learning,
    ...savedPolymarketLearning,
    bySide: { ...polymarketState.learning.bySide, ...(savedPolymarketLearning.bySide || {}) },
    byEdge: { ...polymarketState.learning.byEdge, ...(savedPolymarketLearning.byEdge || {}) },
  };
} catch (e) {}
let botRuns = (() => {
try {
const stored = JSON.parse(localStorage.getItem(BOT_RUNS_KEY));
return Array.isArray(stored) ? stored : [];
} catch (e) {
return [];
}
})();
window.botLearning = new window.LearningEngine();
try {
  const stored = JSON.parse(localStorage.getItem("trader-desk-bot-learning-v1"));
  if (stored && stored.modes) window.botLearning.hydrate(stored);
} catch (e) {}
let activeBotRun = null;
function updateStorage() {
  watchlists[activeWatchlistName] = savedWatchlist;
  localStorage.setItem("trader-desk-watchlists", JSON.stringify(watchlists));
  localStorage.setItem("trader-desk-active-watchlist", activeWatchlistName);
  localStorage.setItem("trader-desk-history", JSON.stringify(savedHistory));
  localStorage.setItem("trader-desk-portfolio", JSON.stringify(savedPortfolio));
localStorage.setItem("trader-desk-trade-history", JSON.stringify(tradeHistory));
localStorage.setItem("trader-desk-wallet-cash", walletCash.toString());
  localStorage.setItem("trader-desk-wallet-start", startingBalance.toString());
  localStorage.setItem(PENDING_ORDERS_KEY, JSON.stringify(pendingOrders));
  localStorage.setItem(BOT_CONFIG_KEY, JSON.stringify(botConfig));
  updateLightningTracker();
  renderTradeTicket();
  renderBotStatus();
}

function updateLightningTracker() {
  if (!els.posTracker) return;
  const currentQ = quotes.find(q => q.symbol === activeSymbol);
  const currentPrice = currentQ ? currentQ.price : (detail ? (detail.lastTradePrice || detail.regularMarketPrice) : 0);
  
  const existingLots = savedPortfolio.filter(p => p.symbol === activeSymbol);
  if (existingLots.length === 0) {
    els.posTracker.innerHTML = "NO OPEN POSITION";
    els.posTracker.className = "";
    if (els.lightningFlatten) els.lightningFlatten.style.display = "none";
    return;
  }
  
  if (els.lightningFlatten) els.lightningFlatten.style.display = "block";
  let totalQty = 0;
  let totalCost = 0;
  existingLots.forEach(lot => {
    totalQty += lot.qty;
    totalCost += (lot.qty * lot.avgPrice);
  });
  
  const avgEntry = totalCost / totalQty;
  const pnl = (currentPrice - avgEntry) * totalQty;
  const pnlTone = pnl >= 0 ? "positive" : "negative";

  els.posTracker.innerHTML = `<span>${totalQty.toFixed(2)} @ $${avgEntry.toFixed(2)}</span> | P&L: <span class="${pnlTone}">$${pnl.toFixed(2)}</span>`;
  els.posTracker.className = "active-pos";
}

function renderWallet() {
const elsBalance = document.getElementById("wallet-balance");
const elsPnl = document.getElementById("wallet-pnl");
if (!elsBalance || !elsPnl) return;
  
  let portfolioValue = 0;
  savedPortfolio.forEach(pos => {
    const q = quotes.find(quote => quote.symbol === pos.symbol);
    const currentPrice = q ? q.price : pos.avgPrice;
    portfolioValue += (pos.qty * currentPrice);
  });
  
  const totalValue = walletCash + portfolioValue;
  const pnl = totalValue - startingBalance;
  const pnlPct = startingBalance > 0 ? (pnl / startingBalance) * 100 : 0;
  
  elsBalance.textContent = `$${formatPrice(totalValue)}`;
  elsPnl.textContent = `${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
  elsPnl.className = pnl >= 0 ? "positive" : "negative";

updateLightningTracker();
}

function activeMarketPrice(symbol = activeSymbol) {
const q = quotes.find(quote => quote.symbol === symbol);
if (q?.price) return Number(q.price);
if (symbol === activeSymbol && detail) return Number(detail.price || detail.lastTradePrice || detail.regularMarketPrice || 0);
return 0;
}

function heldQuantity(symbol) {
return savedPortfolio
.filter(pos => pos.symbol === symbol)
.reduce((sum, pos) => sum + Number(pos.qty || 0), 0);
}

function calculateTicketQuantity(price) {
const size = Number(els.ticketSize?.value || 0);
if (!Number.isFinite(size) || size <= 0 || !price) return 0;
return ticketSizeMode === "amount" ? size / price : size;
}

function renderPendingOrders() {
if (!els.pendingOrders) return;
const activeOrders = pendingOrders.filter(order => order.symbol === activeSymbol);
if (!activeOrders.length) {
els.pendingOrders.innerHTML = "";
return;
}
els.pendingOrders.innerHTML = activeOrders.map(order => `
<div class="pending-order ${order.side}">
<span>${order.side.toUpperCase()} ${order.qty.toFixed(4)} ${order.symbol}</span>
<strong>${order.direction === "above" ? ">=" : "<="} $${formatPrice(order.triggerPrice)}</strong>
<button type="button" onclick="cancelPendingOrder('${order.id}')">Cancel</button>
</div>
`).join("");
}

function renderTradeTicket() {
if (!els.ticketPreview) return;
const price = activeMarketPrice();
const qty = calculateTicketQuantity(price);
const notional = qty * price;
const positionQty = heldQuantity(activeSymbol);
const pendingCount = pendingOrders.filter(order => order.symbol === activeSymbol).length;

els.ticketBuy?.classList.toggle("active", activeTicketSide === "buy");
els.ticketSell?.classList.toggle("active", activeTicketSide === "sell");
els.ticketModeAmount?.classList.toggle("active", ticketSizeMode === "amount");
els.ticketModeShares?.classList.toggle("active", ticketSizeMode === "shares");
els.ticketMarket?.classList.toggle("active", ticketOrderType === "market");
els.ticketTrigger?.classList.toggle("active", ticketOrderType === "trigger");
if (els.ticketTriggerPrice) els.ticketTriggerPrice.disabled = ticketOrderType !== "trigger";

els.ticketPreview.textContent = price && qty
? `${qty.toFixed(qty >= 10 ? 2 : 4)} ${activeSymbol} / $${formatPrice(notional)}`
: "Enter size";
els.ticketRisk.textContent = `${activeTicketSide.toUpperCase()} | Cash $${formatPrice(walletCash)} | Pos ${positionQty.toFixed(4)}${pendingCount ? ` | ${pendingCount} armed` : ""}`;
els.ticketSubmit.textContent = ticketOrderType === "trigger" ? "Arm" : `Place ${activeTicketSide.toUpperCase()}`;
els.ticketSubmit.className = `ticket-submit ${activeTicketSide}`;
renderPendingOrders();
}

function triggerDirection(side, triggerPrice, currentPrice) {
if (side === "buy") return triggerPrice >= currentPrice ? "above" : "below";
return triggerPrice <= currentPrice ? "below" : "above";
}

function shouldTrigger(order, price) {
return order.direction === "above" ? price >= order.triggerPrice : price <= order.triggerPrice;
}

function placeTicketOrder() {
const price = activeMarketPrice();
const qty = calculateTicketQuantity(price);
if (!activeSymbol || !price || !qty) {
appendTerminalLine("Order ticket needs a live price and valid size.", "warn");
return;
}

if (ticketOrderType === "market") {
const ok = executeTrade(activeSymbol, activeTicketSide, qty, price);
if (ok) appendTerminalLine(`${activeTicketSide.toUpperCase()} ${qty.toFixed(4)} ${activeSymbol} @ $${formatPrice(price)}`, "ok");
return;
}

const triggerPrice = Number(els.ticketTriggerPrice?.value || 0);
if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
appendTerminalLine("Trigger order needs a valid trigger price.", "warn");
return;
}

const order = {
id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
symbol: activeSymbol,
side: activeTicketSide,
qty,
triggerPrice,
direction: triggerDirection(activeTicketSide, triggerPrice, price),
createdAt: new Date().toISOString(),
};
pendingOrders.push(order);
updateStorage();
renderChart();
appendTerminalLine(`Armed ${order.side.toUpperCase()} ${order.qty.toFixed(4)} ${order.symbol} ${order.direction === "above" ? ">=" : "<="} $${formatPrice(order.triggerPrice)}`, "ok");
}

function processPendingOrders() {
if (!pendingOrders.length) return;
const remaining = [];
let changed = false;
pendingOrders.forEach(order => {
const price = activeMarketPrice(order.symbol);
if (!price || !shouldTrigger(order, price)) {
remaining.push(order);
return;
}
const ok = executeTrade(order.symbol, order.side, order.qty, price);
if (ok) {
changed = true;
appendTerminalLine(`Triggered ${order.side.toUpperCase()} ${order.qty.toFixed(4)} ${order.symbol} @ $${formatPrice(price)}`, "ok");
} else {
remaining.push(order);
}
});
if (changed || remaining.length !== pendingOrders.length) {
pendingOrders = remaining;
updateStorage();
renderChart();
}
}

window.cancelPendingOrder = function(id) {
  pendingOrders = pendingOrders.filter(order => order.id !== id);
  updateStorage();
  renderChart();
};

function botModeIds() {
  return Object.keys(BOT_MODES);
}

function botModeEnabled(mode) {
  return botConfig.enabled?.[mode] !== false;
}

function enabledBotModeIds() {
  return botModeIds().filter(botModeEnabled);
}

function syncBotEnableInputs() {
  botModeIds().forEach(mode => {
    const checked = botModeEnabled(mode);
    [document.querySelector(`#bot-enabled-${mode}`), document.querySelector(`#polymarket-enabled-${mode}`)].forEach(input => {
      if (input) input.checked = checked;
    });
  });
}

function botModeEl(mode, name) {
  return document.querySelector(`#bot-${name}-${mode}`);
}

function botInputFor(mode) {
  return document.querySelector(`#bot-capital-${mode}`);
}

function readBotConfig() {
  const duration = Number(document.querySelector("#bot-duration")?.value);
  const observe = Number(document.querySelector("#bot-observe")?.value);
  const strategyMode = document.querySelector("#bot-strategy-mode")?.value || "swarm";
  const polymarketInterval = document.querySelector("#polymarket-interval")?.value || "15m";
  const polymarketCapital = Number(document.querySelector("#polymarket-capital-calm")?.value);
  const polymarketModes = {};
  const enabled = {};
  botModeIds().forEach(mode => {
    const input = document.querySelector(`#polymarket-capital-${mode}`);
    const value = Number(input?.value);
    polymarketModes[mode] = Number.isFinite(value) ? Math.max(1, value) : (botConfig.polymarketModes?.[mode] || defaultBotConfig.polymarketCapital);
    const modeInput = strategyMode === "polymarket"
      ? document.querySelector(`#polymarket-enabled-${mode}`)
      : document.querySelector(`#bot-enabled-${mode}`);
    enabled[mode] = modeInput ? modeInput.checked : botModeEnabled(mode);
  });
  const universeMode = els.botUniverseMode?.value || "crypto";
  const feesEnabled = document.querySelector("#bot-fees-enabled")?.checked === true;
  const multiplierEnabled = document.querySelector("#bot-multiplier-enabled")?.checked === true;
  const modes = {};
  botModeIds().forEach(mode => {
    const input = botInputFor(mode);
    const capital = Number(input?.value);
    modes[mode] = { capital: Number.isFinite(capital) ? Math.max(0, capital) : BOT_MODES[mode].capital };
  });
  botConfig = {
    durationMin: Number.isFinite(duration) ? clamp(Math.max(1, duration), 1, 1440) : defaultBotConfig.durationMin,
    observeMinutes: Number.isFinite(observe) ? clamp(Math.max(0, observe), 0, 240) : defaultBotConfig.observeMinutes,
    strategyMode: strategyMode === "polymarket" ? "polymarket" : "swarm",
    polymarketInterval: polymarketInterval === "5m" ? "5m" : "15m",
    polymarketCapital: Number.isFinite(polymarketCapital) ? Math.max(1, polymarketCapital) : defaultBotConfig.polymarketCapital,
    polymarketModes,
    universeMode,
    feesEnabled,
    multiplierEnabled,
    enabled,
    modes,
  };
  localStorage.setItem(BOT_CONFIG_KEY, JSON.stringify(botConfig));
  return botConfig;
}

function hydrateBotForm() {
const duration = document.querySelector("#bot-duration");
if (duration) duration.value = botConfig.durationMin || defaultBotConfig.durationMin;
const observe = document.querySelector("#bot-observe");
if (observe) observe.value = botConfig.observeMinutes ?? defaultBotConfig.observeMinutes;
const strategyMode = document.querySelector("#bot-strategy-mode");
if (strategyMode) strategyMode.value = botConfig.strategyMode || defaultBotConfig.strategyMode;
const polymarketInterval = document.querySelector("#polymarket-interval");
if (polymarketInterval) polymarketInterval.value = botConfig.polymarketInterval || defaultBotConfig.polymarketInterval;
botModeIds().forEach(mode => {
  const input = document.querySelector(`#polymarket-capital-${mode}`);
  if (input) input.value = botConfig.polymarketModes?.[mode] ?? botConfig.polymarketCapital ?? defaultBotConfig.polymarketCapital;
});
syncBotEnableInputs();
if (els.botUniverseMode) {
  // Ensure the option exists before setting it, handled mostly in updateWatchlistUI, but safe to assign
  els.botUniverseMode.value = botConfig.universeMode || "crypto";
}
const feesToggle = document.querySelector("#bot-fees-enabled");
if (feesToggle) feesToggle.checked = botConfig.feesEnabled === true;
const multiplierToggle = document.querySelector("#bot-multiplier-enabled");
if (multiplierToggle) multiplierToggle.checked = botConfig.multiplierEnabled === true;
botModeIds().forEach(mode => {
const input = botInputFor(mode);
if (input) input.value = botConfig.modes?.[mode]?.capital ?? BOT_MODES[mode].capital;
});
}

function compactBotRun(run) {
  const audits = run?.audit || {};
  const auditCounts = run?.auditCounts && typeof run.auditCounts === "object"
    ? { ...run.auditCounts }
    : Object.fromEntries(Object.entries(audits).map(([mode, rows]) => [mode, Array.isArray(rows) ? rows.length : 0]));
  return {
    ...run,
    auditCounts,
    audit: Object.fromEntries(Object.entries(audits).map(([mode, rows]) => [
      mode,
      Array.isArray(rows) ? rows.slice(-BOT_RUN_PERSIST_AUDIT_LIMIT) : [],
    ])),
  };
}

function botPersistRuns() {
  const compactRuns = botRuns.slice(0, BOT_RUN_HISTORY_LIMIT).map(compactBotRun);
  localStorage.setItem(BOT_RUNS_KEY, JSON.stringify(compactRuns));
}

function botPersistRunFile(run) {
  const payload = compactBotRun(run);
  postToApi("/api/bot-runs", payload).catch(() => {});
}

function botSnapshotForAudit(mode, ranked = null) {
  const snap = botPortfolioSnapshot(mode, ranked);
  const openPositions = Object.values(botState.modes[mode].positions || {})
    .filter(position => Number(position.qty || 0) > 0).length;
  return {
cash: Number(snap.cash || 0),
deployed: Number(snap.openValue || 0),
totalValue: Number(snap.totalValue || 0),
    pnl: Number(snap.pnl || 0),
    capital: Number(snap.capital || 0),
    openPositions,
    flat: openPositions === 0,
  };
}

function generateBotRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `run_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function botStartRunRecord() {
const symbols = botUniverseSymbols();
const run = {
id: generateBotRunId(),
startedAt: new Date().toISOString(),
endedAt: null,
reason: null,
durationMin: botConfig.durationMin,
universeMode: botConfig.universeMode,
feesEnabled: botConfig.feesEnabled === true,
multiplierEnabled: botConfig.multiplierEnabled === true,
symbols,
modes: Object.fromEntries(botModeIds().map(mode => [mode, {
capital: botCapital(mode),
start: botSnapshotForAudit(mode),
final: null,
}])),
audit: Object.fromEntries(botModeIds().map(mode => [mode, []])),
auditCounts: Object.fromEntries(botModeIds().map(mode => [mode, 0])),
};
botRuns.unshift(run);
botRuns = botRuns.slice(0, BOT_RUN_HISTORY_LIMIT);
activeBotRun = run;
botPersistRuns();
botPersistRunFile(run);
}

function botAppendRunAudit(mode, row, ranked = null) {
if (!activeBotRun) return;
const audit = activeBotRun.audit[mode] || [];
const timing = botRunTiming(mode);
const snap = botSnapshotForAudit(mode, ranked);
audit.push({
ts: new Date().toISOString(),
elapsedSec: Math.round(timing.elapsedMs / 1000),
remainingSec: Math.max(0, Math.round(timing.remainingMs / 1000)),
phase: timing.phase,
mode,
action: row.action || "WATCH",
symbol: row.symbol || null,
    price: Number(row.price || 0),
    confidence: Number(row.confidence || row.score || 0),
    risk: Number(row.risk || 0),
    edge: Number(row.edge || 0),
    requiredEdge: Number(row.requiredEdge || 0),
    notional: Number(row.notional || 0),
    multiplier: row.multiplier === undefined ? botConfig.multiplierEnabled === true : row.multiplier === true,
    freeHand: row.freeHand === true,
    setupType: row.setupType || "",
    blockedBy: row.blockedBy || "",
    exitCause: row.exitCause || "",
    stopLossPct: Number(row.stopLossPct || 0),
    takeProfitPct: Number(row.takeProfitPct || 0),
    cash: snap.cash,
deployed: snap.deployed,
totalValue: snap.totalValue,
pnl: snap.pnl,
reason: row.reason || "",
});
activeBotRun.audit[mode] = audit.slice(-BOT_RUN_AUDIT_LIMIT);
activeBotRun.auditCounts = activeBotRun.auditCounts || {};
activeBotRun.auditCounts[mode] = Number(activeBotRun.auditCounts[mode] || 0) + 1;
botPersistRuns();

const now = Date.now();
if (!activeBotRun._lastPersist || now - activeBotRun._lastPersist > 2500) {
  botPersistRunFile(activeBotRun);
  activeBotRun._lastPersist = now;
}
}

function botFinishRunRecord(reason) {
  if (!activeBotRun) return;
  activeBotRun.endedAt = new Date().toISOString();
  activeBotRun.reason = reason;
  botModeIds().forEach(mode => {
    activeBotRun.modes[mode].final = botSnapshotForAudit(mode);
  });
  botPersistRuns();
  botPersistRunFile(activeBotRun);
  activeBotRun = null;
}

function botPersistState() {
const clean = createBotState();
  clean.running = botState.running;
  clean.startedAt = botState.startedAt;
  clean.stopAt = botState.stopAt;
  botModeIds().forEach(mode => {
    const state = botState.modes[mode];
    clean.modes[mode] = {
      ...createBotModeState(),
      positions: state.positions,
      trades: state.trades.slice(0, 200),
      logs: state.logs.slice(0, 240),
      rankings: state.rankings.slice(0, 20),
      priceMemory: state.priceMemory,
lastTradeAt: state.lastTradeAt,
lastActionAt: state.lastActionAt,
realized: state.realized,
      decisions: state.decisions,
      lastLog: state.lastLog,
    };
  });
  localStorage.setItem(BOT_STATE_KEY, JSON.stringify(clean));
  if (window.botLearning) {
    localStorage.setItem("trader-desk-bot-learning-v1", JSON.stringify(window.botLearning.serialize()));
  }
}

function resetBotSession() {
  const wasRunning = botState.running;
  if (botState.timer) clearTimeout(botState.timer);
  const prevModes = botState.modes;
  botState = createBotState();
  Object.keys(BOT_MODES).forEach(mode => {
    const prev = prevModes && prevModes[mode];
    if (prev) {
      botState.modes[mode].positions = prev.positions || {};
      botState.modes[mode].realized = Number(prev.realized || 0);
      botState.modes[mode].trades = Array.isArray(prev.trades) ? prev.trades : [];
    }
  });
  botDropOffUniversePositions();
  botState.running = wasRunning;
  botState.startedAt = Date.now();
  botState.stopAt = Date.now() + Math.max(1, Number(botConfig.durationMin || 30)) * 60000;
  botPersistState();
}

// Close any carried-over paper positions whose symbol is no longer in the
// configured universe, at cost, so they don't linger untracked.
function botDropOffUniversePositions() {
  const symbols = new Set(botUniverseSymbols());
  Object.keys(BOT_MODES).forEach(mode => {
    const positions = botState.modes[mode].positions || {};
    Object.keys(positions).forEach(symbol => {
      if (!symbols.has(symbol) && Number(positions[symbol].qty || 0) > 0) {
        const position = positions[symbol];
        executeBotSell(mode, { symbol, price: Number(position.avgPrice || 0), score: 0, confidence: 0, risk: 0, shortMomentumPct: 0, noisePct: 0, signalAction: "Exit", signalConfidence: 0, setupType: position.setupType || "" }, Number(position.qty || 0), "symbol left universe — closed at cost");
      }
    });
  });
}

function resetBots() {
if (botState.timer) clearTimeout(botState.timer);
botState = createBotState();
resetPolymarketSession();
polymarketState.learning = { trades: 0, wins: 0, losses: 0, pnl: 0, bySide: {}, byEdge: {} };
localStorage.setItem("trader-desk-polymarket-learning-v1", JSON.stringify(polymarketState.learning));
activeBotRun = null;
botRuns = [];
if (window.botLearning) {
  window.botLearning.reset();
  localStorage.setItem("trader-desk-bot-learning-v1", JSON.stringify(window.botLearning.serialize()));
}
botPersistState();
botPersistRuns();
renderBotStatus();
renderBotLog();
}

function clearPolymarketAudit() {
  if (polymarketSwarmEngine) {
    polymarketSwarmEngine.modes().forEach(mode => {
      const swarm = polymarketState.swarms?.[mode];
      if (!swarm) return;
      swarm.audit = [];
      swarm.trades = [];
    });
    polymarketSwarmEngine.sync();
  } else {
    polymarketState.audit = [];
    polymarketState.trades = [];
  }
  renderPolymarketPanel();
  appendTerminalLine("[BOT] Polymarket audit cleared", "ok");
}

function botUniverseSymbols() {
  if (botConfig.universeMode === "crypto") return BOT_CRYPTO_SYMBOLS;
  const globalMarkets = getMarketWatchlists();
  if (globalMarkets[botConfig.universeMode]) {
    return globalMarkets[botConfig.universeMode];
  }
  return watchlists[botConfig.universeMode] || savedWatchlist;
}

function botUniverseLabel() {
  return botConfig.universeMode === "crypto" ? "crypto universe" : botConfig.universeMode;
}

function botCapital(mode) {
  return Math.max(0, Number(botConfig.modes?.[mode]?.capital ?? BOT_MODES[mode].capital));
}

function botQuoteFor(symbol, ranked = []) {
  return (ranked || []).find(item => item.symbol === symbol) || quotes.find(item => item.symbol === symbol);
}

function botNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function rememberBotPrice(mode, symbol, price) {
  if (!price) return;
  const memory = botState.modes[mode].priceMemory;
  const history = Array.isArray(memory[symbol]) ? memory[symbol] : [];
  history.push({ price, time: Date.now() });
  memory[symbol] = history.slice(-BOT_PRICE_MEMORY_LIMIT);
}

function botMicroMove(mode, symbol) {
  const history = botState.modes[mode].priceMemory[symbol] || [];
  if (history.length < 2) return 0;
  const first = history[0].price;
  const last = history[history.length - 1].price;
  return first ? ((last - first) / first) * 100 : 0;
}

function botVolatility(mode, symbol) {
  const history = botState.modes[mode].priceMemory[symbol] || [];
  if (history.length < 4) return 0.75;
  const returns = [];
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1].price;
    const next = history[i].price;
    if (prev > 0 && next > 0) returns.push(((next - prev) / prev) * 100);
  }
  if (!returns.length) return 0.75;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  return clamp(Math.sqrt(variance), 0.15, 5);
}


window.botAnalyzeOrderBook = function(symbol) {
  const book = window.activeOrderBook || { bids: [], asks: [] };
  if (!book.bids.length && !book.asks.length) return { bidVol: 0, askVol: 0, imbalance: 0 };
  const bidVol = book.bids.slice(0, 10).reduce((sum, r) => sum + Number(r.size || 0), 0);
  const askVol = book.asks.slice(0, 10).reduce((sum, r) => sum + Number(r.size || 0), 0);
  const total = bidVol + askVol;
  return {
    bidVol,
    askVol,
    imbalance: total > 0 ? ((bidVol - askVol) / total) * 100 : 0
  };
};

function botSignalFor(symbol) {
  return signals.find(item => item.symbol === symbol);
}

function botHeldQuantity(mode, symbol) {
  return Number(botState.modes[mode].positions[symbol]?.qty || 0);
}

function botAverageEntry(mode, symbol) {
  return Number(botState.modes[mode].positions[symbol]?.avgPrice || 0);
}

function botOpenValue(mode, ranked = botState.modes[mode].rankings) {
  return Object.entries(botState.modes[mode].positions).reduce((sum, [symbol, position]) => {
    const quote = botQuoteFor(symbol, ranked);
    const price = Number(quote?.price || position.avgPrice || 0);
    return sum + (Number(position.qty || 0) * price);
  }, 0);
}

function botCostBasis(mode) {
  return Object.values(botState.modes[mode].positions).reduce((sum, position) => sum + Number(position.costBasis || 0), 0);
}

function botPortfolioSnapshot(mode, ranked = botState.modes[mode].rankings) {
  const capital = botCapital(mode);
  const openValue = botOpenValue(mode, ranked);
  const costBasis = botCostBasis(mode);
  const realized = Number(botState.modes[mode].realized || 0);
  const cash = Math.max(0, capital - costBasis + realized);
  const totalValue = cash + openValue;
  return { capital, openValue, costBasis, realized, cash, totalValue, pnl: totalValue - capital };
}

function botMinimumTradeNotional(snapshot) {
  const accountValue = Math.max(0, Number(snapshot?.totalValue || snapshot?.capital || 0));
  // Keep the order meaningful for normal accounts while allowing a $10 paper
  // account to deploy small fractional orders instead of being hard-blocked
  // by a fixed exchange-sized minimum.
  return Math.max(BOT_MIN_TRADE_NOTIONAL, accountValue * 0.01);
}

function analyzeBotSymbolLegacy(mode, quote) {
  const def = BOT_MODES[mode];
  const price = Number(quote.price || 0);
  if (!price) return null;
  rememberBotPrice(mode, quote.symbol, price);
  const changePercent = Number(quote.changePercent ?? quote.change_percent ?? 0);
  const dayRange = quote.high && quote.low ? ((quote.high - quote.low) / price) * 100 : 0;
  const microMove = botMicroMove(mode, quote.symbol);
  const volatility = botVolatility(mode, quote.symbol);
  const signal = botSignalFor(quote.symbol);
  const heldQty = botHeldQuantity(mode, quote.symbol);
  const entry = botAverageEntry(mode, quote.symbol);
  const pnlPct = heldQty && entry ? ((price - entry) / entry) * 100 : 0;
  let score = 50;
  const reasons = [];

  if (changePercent > 0) score += clamp(changePercent * (mode === "aggressive" ? 7 : mode === "calm" ? 3.8 : 5.2), 0, 22);
  if (changePercent < 0) score += clamp(changePercent * (mode === "aggressive" ? 5.5 : 4.2), -24, 0);
  reasons.push(`day ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`);

  if (microMove > 0) score += clamp(microMove * (mode === "aggressive" ? 18 : 11), 0, 18);
  if (microMove < 0) score += clamp(microMove * (mode === "calm" ? 13 : 9), -18, 0);
  reasons.push(`tape ${microMove >= 0 ? "+" : ""}${microMove.toFixed(2)}%`);

  if (dayRange > 0) {
    const rangeFit = mode === "calm" ? dayRange <= 3.2 : mode === "normal" ? dayRange <= 5.2 : dayRange <= 8;
    score += rangeFit ? 5 : -6;
    reasons.push(`range ${dayRange.toFixed(2)}%`);
  }
  if (volatility > 0) {
    const volFit = mode === "calm" ? volatility <= 1.6 : mode === "normal" ? volatility <= 2.7 : volatility <= 4.2;
    score += volFit ? 5 : -5;
    reasons.push(`vol ${volatility.toFixed(2)}%`);
  }
  if (signal?.action) {
    const confidence = Number(signal.confidence || 50);
    const bias = Math.max(0, confidence - 50) * def.signalBias;
    score += signal.action === "Buy" ? 8 + bias : -(8 + bias);
    reasons.push(`signal ${signal.action} ${confidence}%`);
  }
  if (heldQty > 0) {
    score += clamp(pnlPct * (mode === "aggressive" ? 2.8 : 2), -14, 14);
    reasons.push(`open P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);
  }
  const lastTradeAt = botState.modes[mode].lastTradeAt[quote.symbol] || 0;
  if (Date.now() - lastTradeAt < def.cooldownMs && heldQty <= 0) {
    score -= 8;
    reasons.push("cooldown");
  }
  const boundedScore = clamp(Math.round(score), 0, 100);
  const stopLossPct = clamp(def.stopLossBase + volatility * def.stopLossVol, 0.35, mode === "aggressive" ? 5.8 : 3.5);
  const takeProfitPct = clamp(def.takeProfitBase + volatility * def.takeProfitVol + Math.max(0, boundedScore - 70) * 0.025, 0.45, mode === "aggressive" ? 8 : 5.5);
  return {
    symbol: quote.symbol,
    price,
    score: boundedScore,
    rankScore: boundedScore + Math.max(0, changePercent) * (mode === "aggressive" ? 2.2 : 1.4),
    reasons: reasons.join(" | "),
    heldQty,
    entry,
    pnlPct,
    stopLossPct,
    takeProfitPct,
    openedAt: botState.modes[mode].positions[quote.symbol]?.openedAt || 0,
  };
}

function botRankAnalyses(analyses) {
  return analyses.filter(Boolean).sort((a, b) => b.rankScore - a.rankScore);
}

function botOrderNotionalLegacy(mode, candidate, cash) {
  const def = BOT_MODES[mode];
  const capital = botCapital(mode);
  const reserve = capital * def.reservePct;
  const spendable = Math.max(0, cash - reserve);
  const currentValue = botHeldQuantity(mode, candidate.symbol) * candidate.price;
  const positionRoom = Math.max(0, (capital * def.maxPositionPct) - currentValue);
  const conviction = clamp((candidate.score - def.threshold + 12) / 34, 0.35, 1.25);
  return Math.min(spendable, positionRoom, capital * def.allocationPct * conviction);
}

function botRecordTrade(mode, row) {
  const state = botState.modes[mode];
  state.trades.unshift({ time: botNow(), ...row });
  state.trades = state.trades.slice(0, 200);
}

function logBotDecision(mode, row, options = {}) {
  const state = botState.modes[mode];
  const key = options.key || `${row.action}:${row.symbol || "desk"}:${row.reason || ""}`;
  const now = Date.now();
  if (options.throttleMs && state.lastLog[key] && now - state.lastLog[key] < options.throttleMs) return;
  state.lastLog[key] = now;
  state.logs.unshift({ time: botNow(), mode, ...row });
  state.logs = state.logs.slice(0, 240);
  botPersistState();
  renderBotLog(mode);
}

function executeBotBuy(mode, candidate, notional, reason) {
  const state = botState.modes[mode];
  const snapshot = botPortfolioSnapshot(mode);
  const minTrade = botMinimumTradeNotional(snapshot);
  const cleanNotional = Math.min(notional, snapshot.cash);
  if (cleanNotional < minTrade || candidate.price <= 0) return false;
  // Apply fee: fee is added to cost basis
  const fee = cleanNotional * botFeeRate();
  const qty = cleanNotional / candidate.price;
  const position = state.positions[candidate.symbol] || { qty: 0, avgPrice: 0, costBasis: 0, realized: 0, openedAt: Date.now() };
  position.qty = Number(position.qty || 0) + qty;
  position.costBasis = Number(position.costBasis || 0) + cleanNotional + fee; // Fee baked into cost
  position.avgPrice = position.qty > 0 ? position.costBasis / position.qty : 0;
  position.openedAt = position.openedAt || Date.now();
  position.updatedAt = Date.now();
  position.lastMarkPrice = Number(candidate.price) || position.lastMarkPrice || position.avgPrice;
  position.setupType = candidate.setupType || position.setupType || "unknown";
  const multiplier = candidate.multiplier === true;
  position.multiplier = multiplier;
  position.freeHand = candidate.freeHand === true || (multiplier && candidate.takeProfitPct === 0);
  position.entryMomentumZ = Number(candidate.momZ || 0);
  position.entryMoveZ = Number(candidate.moveZ || 0);
  position.entryConfidence = Number(candidate.confidence || candidate.verdict?.confidence || 0);
  position.entrySignal = candidate.signalAction || "Hold";
  // Persist risk plan from the candidate so BotBase.evaluateExit can enforce it.
  if (candidate.stopLossPct !== undefined) position.stopLossPct = Number(candidate.stopLossPct);
  if (position.freeHand) position.takeProfitPct = 0;
  else if (candidate.takeProfitPct !== undefined) position.takeProfitPct = Number(candidate.takeProfitPct);
  if (candidate.trailPct !== undefined) position.trailPct = Number(candidate.trailPct);
  position.lastStopPrice = Number(candidate.stopPrice) || 0;
  state.positions[candidate.symbol] = position;
  state.lastTradeAt[candidate.symbol] = Date.now();
  botRecordTrade(mode, { side: "BUY", symbol: candidate.symbol, qty, price: candidate.price, notional: cleanNotional, fee, multiplier, freeHand: position.freeHand, reason });
  logBotDecision(mode, { action: "BUY", symbol: candidate.symbol, qty, price: candidate.price, notional: cleanNotional, fee, multiplier, freeHand: position.freeHand, score: candidate.score, reason });
  return true;
}

function executeBotSell(mode, candidate, qty, reason) {
  const state = botState.modes[mode];
  const position = state.positions[candidate.symbol];
  if (!position || Number(position.qty || 0) <= 0) return false;
  const sellQty = Math.min(qty, Number(position.qty || 0));
  if (sellQty <= 0 || candidate.price <= 0) return false;
  const avgPrice = Number(position.avgPrice || candidate.price);
  const notional = sellQty * candidate.price;
  // Apply exit fee
  const fee = notional * botFeeRate();
  const costRemoved = sellQty * avgPrice;
  const realized = notional - costRemoved - fee; // Fee subtracted from realized P&L
  position.qty = Math.max(0, Number(position.qty || 0) - sellQty);
  position.costBasis = Math.max(0, Number(position.costBasis || 0) - costRemoved);
  position.realized = Number(position.realized || 0) + realized;
  position.closedPnl = Number(position.closedPnl || 0) + realized;
  if (candidate.action === "LOCK PROFIT" || candidate.action === "REDUCE") position.targetHit = true;
  position.updatedAt = Date.now();
  state.realized = Number(state.realized || 0) + realized;
  if (position.qty <= 0.000001) {
    const outcome = {
      symbol: candidate.symbol,
      setupType: candidate.setupType || position.setupType || "unknown",
      pnl: position.closedPnl || realized,
      pnlPct: Number(candidate.pnlPct) || 0,
      volatility: Number(candidate.volatilityPct || 0),
      capital: botCapital(mode),
      entryMomentumZ: Number(position.entryMomentumZ || 0),
      entryMoveZ: Number(position.entryMoveZ || 0),
      entryConfidence: Number(position.entryConfidence || 0),
      entrySignal: position.entrySignal || "Hold",
      freeHand: position.freeHand === true,
    };
    if (window.botLearning && window.botLearning.recordExit) window.botLearning.recordExit(mode, outcome);
    delete state.positions[candidate.symbol];
  }
  else state.positions[candidate.symbol] = position;
  state.lastTradeAt[candidate.symbol] = Date.now();
  botRecordTrade(mode, { side: "SELL", symbol: candidate.symbol, qty: sellQty, price: candidate.price, notional, fee, pnl: realized, multiplier: position.multiplier === true, freeHand: position.freeHand === true, reason });
  logBotDecision(mode, { action: "SELL", symbol: candidate.symbol, qty: sellQty, price: candidate.price, notional, fee, pnl: realized, multiplier: position.multiplier === true, freeHand: position.freeHand === true, score: candidate.score, reason });
  return true;
}

function renderBotPositions(mode) {
  const el = botModeEl(mode, "positions");
  if (!el) return;
  const rows = Object.entries(botState.modes[mode].positions)
    .filter(([, position]) => Number(position.qty || 0) > 0)
    .map(([symbol, position]) => {
      const quote = botQuoteFor(symbol);
      const price = Number(quote?.price || position.avgPrice || 0);
      const qty = Number(position.qty || 0);
      const value = qty * price;
      const entry = Number(position.avgPrice || 0);
      const pnl = entry ? (price - entry) * qty : 0;
      const pnlPct = entry ? ((price - entry) / entry) * 100 : 0;
      return { symbol, qty, price, value, entry, pnl, pnlPct };
    });
  if (!rows.length) {
    el.innerHTML = '<div class="bot-empty">No positions. Waiting for a clean entry.</div>';
    return;
  }
  el.innerHTML = rows.map(item => `
    <div class="bot-position-row ${item.pnl >= 0 ? "positive" : "negative"}">
      <strong>${item.symbol}</strong>
      <span>${item.qty.toFixed(4)} sh @ $${formatPrice(item.entry)}</span>
      <em>$${formatPrice(item.value)}</em>
      <small>${item.pnl >= 0 ? "+" : ""}$${formatPrice(item.pnl)} (${item.pnlPct >= 0 ? "+" : ""}${item.pnlPct.toFixed(2)}%)</small>
    </div>
  `).join("");
}

function renderBotSwarm() {
  botModeIds().forEach(mode => {
    const el = botModeEl(mode, "swarm");
    if (!el) return;
    const bot = window.tradingBots && window.tradingBots[mode];
    const worker = bot && bot.worker;
    const state = botState.modes[mode];
    const rankings = (state.rankings || []).slice(0, 16);
    const heldEntries = Object.entries(state.positions || {})
      .filter(([, position]) => Number(position.qty || 0) > 0);
    const heldSymbols = new Set(heldEntries.map(([symbol]) => symbol));
    const swarms = (worker && worker.swarms) || {};

    const arrowFor = direction => direction === "bullish" ? "▲" : direction === "bearish" ? "▼" : "•";
    const ageFor = ms => {
      const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    };

    const pinnedRows = heldEntries.map(([symbol, position]) => {
      const item = rankings.find(row => row.symbol === symbol);
      const agent = swarms[symbol];
      const watcher = position.lastSwarm || {};
      const verdict = item?.verdict || watcher.direction
        ? (item?.verdict || watcher)
        : (agent?.verdict || { direction: "neutral", confidence: 0 });
      const quote = botQuoteFor(symbol);
      const price = Number(item?.price || quote?.price || position.lastMarkPrice || position.avgPrice || 0);
      const entry = Number(position.avgPrice || 0);
      const qty = Number(position.qty || 0);
      const value = qty * price;
      const pnl = entry ? (price - entry) * qty : 0;
      const pnlPct = entry ? ((price - entry) / entry) * 100 : 0;
      const stale = Boolean(item?.feedStale || watcher.feedStale || (agent && agent.staleTickCount() > Number(window.BOT_STALE_TICK_LIMIT || 20)));
      const reasoning = item?.reasoning || {
        chain: watcher.summary ? [watcher.summary] : [],
        reverseCheck: watcher.reverseCheck || "",
      };
      const chain = reasoning.chain || [];
      const reverse = reasoning.reverseCheck || "";
      return `<div class="swarm-card swarm-position-card ${stale ? "stale" : pnl >= 0 ? "bullish" : "bearish"}" data-symbol="${symbol}" data-position-watch="true">
        <div class="swarm-card-head">
          <strong class="swarm-symbol">${symbol}</strong>
          <span class="swarm-position-tag">${stale ? "STALE · PROTECTING" : "WATCHING"}</span>
          <span class="swarm-verdict ${verdict.direction || "neutral"}">${arrowFor(verdict.direction)} ${verdict.direction || "neutral"}</span>
          <em>${Number(verdict.confidence || 0)}%</em>
        </div>
        <div class="swarm-card-sub swarm-position-sub">
          <span>${price > 0 ? "$" + formatPrice(price) : "--"}</span>
          <span class="${pnl >= 0 ? "pos" : "neg"}">${pnl >= 0 ? "+" : ""}$${formatPrice(pnl)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</span>
          <span>entry $${formatPrice(entry)}</span>
          <span>age ${ageFor(Date.now() - Number(position.openedAt || Date.now()))}</span>
        </div>
        <div class="swarm-card-sub swarm-position-plan">
          <span>${position.setupType || watcher.setupType || "position"}</span>
          <span>stop -${Number(position.stopLossPct || 0).toFixed(2)}%</span>
          <span>${position.freeHand ? "free-hand momentum" : `target +${Number(position.takeProfitPct || 0).toFixed(2)}%`}</span>
          <span>value $${formatPrice(value)}</span>
          <span>${stale ? `${Number(watcher.staleTickCount || 0)} stale ticks` : `sample ${agent ? agent.sampleCount() : Number(item?.samples || 0)}`}</span>
        </div>
        ${chain.length || reverse ? `<div class="swarm-cot position-watch-reasoning">
          <ol class="cot-chain">${chain.slice(-4).map(c => `<li>${c}</li>`).join("")}</ol>
          ${reverse ? `<p class="cot-reverse"><b>rCoT</b> · ${reverse}</p>` : ""}
        </div>` : ""}
      </div>`;
    }).join("");

    const pinned = pinnedRows
      ? `<section class="swarm-pinned"><div class="swarm-pinned-head"><strong>Positions under watch</strong><span>${heldEntries.length} live</span></div><div class="swarm-list">${pinnedRows}</div></section>`
      : "";

    if (!worker && !rankings.length && !heldEntries.length) { el.innerHTML = ""; return; }
    if (!rankings.length && !Object.keys(swarms).length) {
      el.innerHTML = pinned || '<div class="bot-empty">Swarm agents boot as live prices arrive.</div>';
      return;
    }

    if (!rankings.length) {
      const accumulating = Object.entries(swarms).map(([symbol, agent]) => {
        const v = agent.verdict || { direction: "neutral", confidence: 0 };
        return `<div class="swarm-card ${v.direction}">
          <div class="swarm-card-head"><strong class="swarm-symbol">${symbol}</strong><span class="swarm-verdict ${v.direction}">${arrowFor(v.direction)} ${v.direction}</span><em>${v.confidence}%</em><span class="swarm-meta">${agent.sampleCount()}s · accumulating</span></div>
        </div>`;
      }).join("");
      el.innerHTML = `${pinned}<div class="swarm-list">${accumulating}</div>`;
      return;
    }

    const rows = rankings.filter(item => !heldSymbols.has(item.symbol)).map((item, index) => {
      const agent = swarms[item.symbol];
      const v = (item.verdict && item.verdict.direction) ? item.verdict : (agent ? agent.verdict : { direction: "neutral", confidence: 0 });
      const samples = agent ? agent.sampleCount() : Number(item.samples || 0);
      const reasoning = item.reasoning || null;
      const chain = (reasoning && reasoning.chain) ? reasoning.chain : [];
      const reverse = (reasoning && reasoning.reverseCheck) ? reasoning.reverseCheck : "";
      const expandable = chain.length > 0 || reverse;
      const arrow = arrowFor(v.direction);
      const score = Math.round(item.rankScore || item.score || 0);
      const setup = String(item.setupType || "unknown");
      const price = Number(item.price || 0);
      const micro = Number(item.shortMomentumPct || 0);
      return `<div class="swarm-card ${v.direction}" data-symbol="${item.symbol}">
        <div class="swarm-card-head">
          <strong class="swarm-symbol">${item.symbol}</strong>
          <span class="swarm-rank">#${index + 1}</span>
          <span class="swarm-score" title="rank score">${score}</span>
          <span class="swarm-verdict ${v.direction}">${arrow} ${v.direction}</span>
          <em>${v.confidence}%</em>
        </div>
        <div class="swarm-card-sub">
          <span>${price > 0 ? "$" + formatPrice(price) : "--"}</span>
          <span class="${micro >= 0 ? "pos" : "neg"}">${micro >= 0 ? "+" : ""}${micro.toFixed(2)}%/4t</span>
          <span>${setup}</span>
          <span>${samples} samples</span>
          ${expandable ? `<button type="button" class="swarm-expand" aria-label="Show reasoning">⌄</button>` : ""}
        </div>
        ${expandable ? `<div class="swarm-cot hidden">
          <ol class="cot-chain">${chain.map(c => `<li>${c}</li>`).join("")}</ol>
          ${reverse ? `<p class="cot-reverse"><b>rCoT</b> · ${reverse}</p>` : ""}
        </div>` : ""}
      </div>`;
    }).join("");
    el.innerHTML = `${pinned}<div class="swarm-list">${rows || '<div class="bot-empty">No new candidates. Position watcher remains active.</div>'}</div>`;
  });
}

function renderBotLog(mode) {
  const modes = mode ? [mode] : botModeIds();
  modes.forEach(currentMode => {
    const el = botModeEl(currentMode, "log");
    if (!el) return;
    const logs = botState.modes[currentMode].logs;
    if (!logs.length) {
      el.innerHTML = '<div class="bot-empty">Audit log will appear here.</div>';
      return;
    }
    el.innerHTML = logs.slice(0, 80).map(row => `
      <div class="bot-log-row ${String(row.action || "").toLowerCase()}">
        <strong>${row.action || "SCAN"}${row.symbol ? ` ${row.symbol}` : ""}</strong>
        <span>${row.time}</span>
        <small>${row.notional ? `$${formatPrice(row.notional)} | ` : ""}${row.qty ? `${Number(row.qty).toFixed(4)} sh | ` : ""}${row.pnl !== undefined ? `P&L ${row.pnl >= 0 ? "+" : ""}$${formatPrice(row.pnl)} | ` : ""}${row.reason || ""}</small>
      </div>
    `).join("");
  });
}

function botFmtCountdown(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return "--:--";
  const total = Math.floor(Number(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateBotClock() {
  const el = document.querySelector("#bot-clock");
  if (el) el.textContent = botNow();
}

function botTimelineSeg() {
  const setText = (id, txt) => { const el = document.querySelector(id); if (el) el.textContent = txt; };
  const setPhase = (id, active) => { const seg = document.querySelector(`.bot-phase-seg[data-phase="${id}"]`); if (seg) seg.classList.toggle("active", !!active); };
  const pill = document.querySelector("#bot-phase-label");
  const bar = document.querySelector("#bot-phase-progress");
  const polymarketMode = botConfig.strategyMode === "polymarket";
  const caption = document.querySelector(".bot-timeline-caption");
  if (polymarketMode) {
    if (caption) caption.textContent = "Market session → trade live → settle at Polymarket window end";
    if (!botState.running || !polymarketState.sessionAligned || !polymarketState.sessionEnd) {
      setText("#bot-phase-observe", "market");
      setText("#bot-phase-trade", "waiting");
      setText("#bot-phase-exit", "settle");
      setText("#bot-total-countdown", "--:--");
      setPhase("observe", false); setPhase("trade", false); setPhase("exit", false);
      if (bar) bar.style.width = "0%";
      if (pill) { pill.textContent = botState.running ? "Finding market" : "Stopped"; pill.className = "bot-phase-pill " + (botState.running ? "build" : "stopped"); }
      return;
    }
    const t = botRunTiming("polymarket");
    const settling = t.remainingMs <= 15_000;
    setText("#bot-phase-observe", "done");
    setText("#bot-phase-trade", settling ? "closing" : "live");
    setText("#bot-phase-exit", botFmtCountdown(t.remainingMs));
    setText("#bot-total-countdown", botFmtCountdown(t.remainingMs));
    setPhase("observe", false); setPhase("trade", !settling); setPhase("exit", settling);
    if (bar) bar.style.width = Math.max(0, Math.min(100, t.progress * 100)) + "%";
    if (pill) { pill.textContent = settling ? "Settling" : "Market live"; pill.className = "bot-phase-pill " + (settling ? "exit" : "trade"); }
    return;
  }
  if (caption) caption.textContent = "Warm-up → trade freely → cash safety check";
  if (!botState.running) {
    setText("#bot-phase-observe", botFmtCountdown((Number(botConfig.observeMinutes ?? defaultBotConfig.observeMinutes) || 2) * 60000));
    setText("#bot-phase-trade", "--:--");
    setText("#bot-phase-exit", "--:--");
    setText("#bot-total-countdown", "--:--");
    setPhase("observe", false); setPhase("trade", false); setPhase("exit", false);
    if (bar) bar.style.width = "0%";
    if (pill) { pill.textContent = "Stopped"; pill.className = "bot-phase-pill stopped"; }
    return;
  }
  const t = botRunTiming("normal");
  const tradeEnd = Math.max(0, t.durationMs - t.exitMs);
  const tradeDur = Math.max(0, tradeEnd - t.observeMs);
  const tradeRem = Math.max(0, tradeEnd - t.elapsedMs);
  setText("#bot-phase-observe", t.elapsedMs >= t.observeMs ? "done" : botFmtCountdown(t.observeMs - t.elapsedMs));
  // The safety buffer is not a sell-only lock; the trade clock remains live
  // until the exact deadline while the final close protects any residue.
  setText("#bot-phase-trade", t.elapsedMs < t.observeMs ? botFmtCountdown(tradeDur) : botFmtCountdown(tradeRem));
  setText("#bot-phase-exit", botFmtCountdown(t.remainingMs));
  setText("#bot-total-countdown", botFmtCountdown(t.remainingMs));
  setPhase("observe", t.phase === "observe");
  setPhase("trade", t.phase !== "observe");
  setPhase("exit", t.phase === "exit");
  if (bar) bar.style.width = Math.max(0, Math.min(100, t.progress * 100)) + "%";
  if (pill) {
    const label = t.phase === "observe" ? "Warm-up" : t.phase === "exit" ? "Cash safety" : "Trading";
    pill.textContent = botState.running ? label : "Stopped";
    pill.className = "bot-phase-pill " + (botState.running ? t.phase : "stopped");
  }
}

function renderBotLearning() {
  botModeIds().forEach(mode => {
    const el = botModeEl(mode, "learning");
    if (!el) return;
    const bot = window.tradingBots && window.tradingBots[mode];
    if (!window.botLearning || !bot || typeof window.botLearning.getParams !== "function") {
      el.innerHTML = '<div class="bot-empty">Learning engine idle.</div>';
      return;
    }
    const L = window.botLearning.getParams(mode, bot.traits());
    const pct = v => (Number(v) * 100).toFixed(0) + "%";
    const fmtEdge = (m, e) => `<span class="edge-chip ${e >= 0 ? "pos" : "neg"}">${m} ${e >= 0 ? "+" : ""}${(e * 100).toFixed(0)}</span>`;
    const setupChips = Object.entries(L.setupEdge || {}).map(([s, e]) => fmtEdge(s, e)).join("");
    const symChips = Object.entries(L.symbolEdge || {}).map(([s, e]) => fmtEdge(s, e)).join("");
    const expect = Number(L.expectancyPct || 0);
    const realized = Number(L.pnl || 0);
    const momentumEdges = Object.entries(L.momentumEdge || {})
      .map(([bucket, stats]) => `${bucket} ${(Number(stats.edge || 0) >= 0 ? "+" : "")}${(Number(stats.edge || 0) * 100).toFixed(0)}`)
      .join(" · ");
    const multiplierLearning = botConfig.multiplierEnabled === true;
    el.innerHTML = `
      <div class="learning-stats">
        <div><span>Trades</span><strong>${L.trades}</strong></div>
        <div><span>Win rate</span><strong>${pct(L.winRate)}</strong></div>
        <div><span>Payoff</span><strong>${Number(L.payoff || 1).toFixed(2)}</strong></div>
        <div><span>Kelly</span><strong>${pct(L.kelly)}</strong></div>
        <div><span>Expectancy</span><strong class="${expect >= 0 ? "positive" : "negative"}">${expect >= 0 ? "+" : ""}${expect.toFixed(3)}%</strong></div>
        <div><span>Realized</span><strong class="${realized >= 0 ? "positive" : "negative"}">${realized >= 0 ? "+" : ""}$${formatPrice(realized)}</strong></div>
      </div>
      <div class="learning-plan">
        <div><span>Min edge</span><strong>${Number(L.minEdge).toFixed(1)}</strong></div>
        <div><span>Stop</span><strong>${Number(L.stopPct).toFixed(2)}%</strong></div>
        <div><span>${multiplierLearning ? "Exit" : "Target"}</span><strong>${multiplierLearning ? "Momentum" : `${Number(L.targetPct).toFixed(2)}%`}</strong></div>
        <div><span>Trail</span><strong>${Number(L.trailPct).toFixed(2)}%</strong></div>
        <div><span>Risk ×</span><strong>${Number(L.riskMultiplier).toFixed(2)}</strong></div>
      </div>
      <div class="learning-edges">
        <div><h4>Setup edge</h4><p>${setupChips || '<em class="muted">no closed setups yet</em>'}</p></div>
        <div><h4>Symbol edge</h4><p>${symChips || '<em class="muted">no closed symbols yet</em>'}</p></div>
        <div><h4>Momentum learning</h4><p>${momentumEdges || '<em class="muted">learning from closed momentum trades</em>'}</p></div>
      </div>`;
  });
}

function renderBotStatus() {
updateBotClock();
botTimelineSeg();
const polymarketMode = botConfig.strategyMode === "polymarket";
const botModal = document.querySelector("#bot-modal");
botModal?.classList.toggle("polymarket-layout", polymarketMode);
const pageEyebrow = document.querySelector("#bot-page-eyebrow");
const pageTitle = document.querySelector("#bot-page-title");
const pageSubtitle = document.querySelector("#bot-page-subtitle");
if (pageEyebrow) pageEyebrow.textContent = polymarketMode ? "Polymarket paper workspace" : "Autonomous paper trader";
if (pageTitle) pageTitle.textContent = polymarketMode ? "BTC Up / Down · Polymarket" : "Swarm paper trader";
if (pageSubtitle) pageSubtitle.textContent = polymarketMode
  ? "Polymarket Chainlink TWAP relay · exact 30s / 60s contract feeds · paper only"
  : "Momentum-led paper execution · positions stay watched · no live orders";
["swarm", "polymarket"].forEach(view => {
  const button = document.querySelector(`#bot-view-${view}`);
  if (button) {
    button.classList.toggle("active", (view === "polymarket") === polymarketMode);
    button.disabled = botState.running;
  }
});
const controlHolder = selector => {
  const input = document.querySelector(selector);
  return input?.closest("label") || input?.closest(".bot-duration-card") || input?.parentElement;
};
document.querySelector(".bot-timeline")?.classList.toggle("hidden", polymarketMode);
document.querySelector(".bot-run-bar")?.classList.toggle("hidden", polymarketMode);
document.querySelector(".bot-overview")?.classList.toggle("hidden", polymarketMode);
document.querySelector("#bot-polymarket-panel")?.classList.toggle("hidden", !polymarketMode);
document.querySelector(".bot-modes-grid")?.classList.toggle("hidden", polymarketMode);
if (polymarketMode) {
  const polyEngine = polymarketSwarmEngine;
  if (!botState.running) polymarketState.interval = botConfig.polymarketInterval || "15m";
  const swarms = polyEngine ? polyEngine.modes().map(mode => polymarketState.swarms?.[mode]).filter(Boolean) : [];
  const configuredTotal = botModeIds().reduce((sum, mode) => sum + (botModeEnabled(mode) ? Math.max(1, Number(botConfig.polymarketModes?.[mode] || botConfig.polymarketCapital || 100)) : 0), 0);
  const hasLiveSwarms = swarms.length > 0;
  const capital = hasLiveSwarms && polyEngine ? polyEngine.totalCapital() : configuredTotal;
  const cash = hasLiveSwarms && polyEngine ? polyEngine.totalCash() : configuredTotal;
  const openValue = swarms.reduce((sum, swarm) => sum + (swarm.position ? swarm.position.qty * Number(swarm.position.lastMark || swarm.position.entryPrice || 0) : 0), 0);
  const totalValue = cash + openValue;
  const totalPnl = totalValue - capital;
  const openPositions = swarms.filter(swarm => swarm.position).length;
  const decisions = swarms.reduce((sum, swarm) => sum + Number(swarm.decisions || 0), 0);
  const sessionEnd = polymarketState.sessionEnd ? new Date(polymarketState.sessionEnd).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : null;
  const setPoly = (id, txt, cls) => { const el = document.querySelector(id); if (el) { el.textContent = txt; el.className = cls || ""; } };
  setPoly("#bot-overview-value", `$${formatPrice(totalValue)}`);
  setPoly("#bot-overview-pnl", `${totalPnl >= 0 ? "+" : ""}$${formatPrice(totalPnl)}`, totalPnl >= 0 ? "positive" : "negative");
  setPoly("#bot-overview-capital", `$${formatPrice(capital)}`);
  setPoly("#bot-overview-open", String(openPositions));
  setPoly("#bot-overview-decisions", String(decisions));
  setPoly("#bot-overview-fees", "CLOB book", "positive");
  setPoly("#bot-overview-multiplier", "Paper", "positive");
  if (els.botState) { els.botState.textContent = botState.running ? "Running" : "Stopped"; els.botState.className = botState.running ? "running" : ""; }
  if (els.botSummary) els.botSummary.textContent = `Polymarket BTC · ${polymarketState.interval} · paper only · ${sessionEnd ? `session ends ${sessionEnd}` : "waiting for active market"}`;
  if (els.botStart) { els.botStart.classList.toggle("hidden", botState.running); els.botStart.disabled = botState.running; }
  if (els.botStop) { els.botStop.classList.toggle("hidden", !botState.running); els.botStop.disabled = !botState.running; }
  document.querySelector("#bot-duration")?.toggleAttribute("disabled", true);
  document.querySelector("#bot-observe")?.toggleAttribute("disabled", true);
  document.querySelector("#bot-strategy-mode")?.toggleAttribute("disabled", botState.running);
  document.querySelector("#polymarket-interval")?.toggleAttribute("disabled", botState.running);
  botModeIds().forEach(mode => {
    document.querySelector(`#polymarket-capital-${mode}`)?.toggleAttribute("disabled", botState.running);
    document.querySelector(`#polymarket-enabled-${mode}`)?.toggleAttribute("disabled", botState.running);
  });
  renderPolymarketPanel();
  if (!botState.running) refreshPolymarketPreview();
  els.btnBot?.classList.toggle("active", botState.running);
  return;
}
controlHolder("#bot-duration")?.classList.toggle("hidden", false);
controlHolder("#bot-observe")?.classList.toggle("hidden", false);
document.querySelector(".bot-sizing-note")?.classList.toggle("hidden", false);
const snapshots = Object.fromEntries(botModeIds().map(mode => [mode, botPortfolioSnapshot(mode)]));
const totalCapital = Object.values(snapshots).reduce((sum, snap) => sum + snap.capital, 0);
const totalValue = Object.values(snapshots).reduce((sum, snap) => sum + snap.totalValue, 0);
const totalPnl = totalValue - totalCapital;
const totalOpen = botModeIds().reduce((sum, mode) => sum + Object.keys(botState.modes[mode].positions).filter(s => Number(botState.modes[mode].positions[s].qty || 0) > 0).length, 0);
const totalDecisions = botModeIds().reduce((sum, mode) => sum + Number(botState.modes[mode].decisions || 0), 0);
const setOv = (id, txt, cls) => { const el = document.querySelector(id); if (!el) return; el.textContent = txt; el.className = cls || ""; };
setOv("#bot-overview-value", `$${formatPrice(totalValue)}`);
setOv("#bot-overview-pnl", `${totalPnl >= 0 ? "+" : ""}$${formatPrice(totalPnl)}`, totalPnl >= 0 ? "positive" : "negative");
setOv("#bot-overview-capital", `$${formatPrice(totalCapital)}`);
setOv("#bot-overview-open", String(totalOpen));
setOv("#bot-overview-decisions", String(totalDecisions));
setOv("#bot-overview-fees", botConfig.feesEnabled ? "On" : "Off", botConfig.feesEnabled ? "positive" : "");
  setOv("#bot-overview-multiplier", botConfig.multiplierEnabled ? "Free-hand" : "Off", botConfig.multiplierEnabled ? "positive" : "");
  if (els.botState) {
    els.botState.textContent = botState.running ? "Running" : "Stopped";
    els.botState.className = botState.running ? "running" : "";
  }
  if (els.botSummary) {
    const symbolsCount = botUniverseSymbols().length;
    els.botSummary.textContent = `${enabledBotModeIds().length}/3 bots enabled · ${botUniverseLabel()} · ${symbolsCount} symbols · fees ${botConfig.feesEnabled ? "on" : "off"} · free-hand momentum ${botConfig.multiplierEnabled ? "on" : "off"} · window ${Math.round(Number(botConfig.durationMin || 30))}m`;
  }
  if (els.botStart) {
    els.botStart.classList.toggle("hidden", botState.running);
    els.botStart.disabled = botState.running;
  }
  if (els.botStop) {
    els.botStop.classList.toggle("hidden", !botState.running);
    els.botStop.disabled = !botState.running;
  }
  els.btnBot?.classList.toggle("active", botState.running);
  document.querySelector("#bot-duration")?.toggleAttribute("disabled", botState.running);
  document.querySelector("#bot-observe")?.toggleAttribute("disabled", botState.running);
  document.querySelector("#bot-fees-enabled")?.toggleAttribute("disabled", botState.running);
  document.querySelector("#bot-multiplier-enabled")?.toggleAttribute("disabled", botState.running);
  document.querySelector("#bot-strategy-mode")?.toggleAttribute("disabled", botState.running);
  document.querySelector("#polymarket-interval")?.toggleAttribute("disabled", botState.running);
  els.botUniverseMode?.toggleAttribute("disabled", botState.running);
  botModeIds().forEach(mode => {
    const enabled = botModeEnabled(mode);
    document.querySelector(`[data-bot-mode="${mode}"]`)?.classList.toggle("bot-disabled", !enabled);
    const snap = snapshots[mode];
    const stateEl = botModeEl(mode, "state");
    const valueEl = botModeEl(mode, "value");
    const pnlEl = botModeEl(mode, "pnl");
    const cashEl = botModeEl(mode, "cash");
    const deployedEl = botModeEl(mode, "deployed");
    const phaseEl = botModeEl(mode, "phase");
    botInputFor(mode)?.toggleAttribute("disabled", botState.running);
    document.querySelector(`#bot-enabled-${mode}`)?.toggleAttribute("disabled", botState.running);
    if (stateEl) stateEl.textContent = enabled ? (botState.running ? "Live" : "Idle") : "Disabled";
    if (valueEl) valueEl.textContent = `$${formatPrice(snap.totalValue)}`;
    if (pnlEl) {
      pnlEl.textContent = `${snap.pnl >= 0 ? "+" : ""}$${formatPrice(snap.pnl)}`;
      pnlEl.className = snap.pnl >= 0 ? "positive" : "negative";
    }
    if (cashEl) cashEl.textContent = `$${formatPrice(snap.cash)}`;
    if (deployedEl) deployedEl.textContent = `$${formatPrice(snap.openValue)}`;
    if (phaseEl) {
      if (!enabled) {
        phaseEl.textContent = "disabled";
        phaseEl.className = "idle";
      } else if (!botState.running) {
        phaseEl.textContent = "idle";
        phaseEl.className = "idle";
      } else {
        const t = botRunTiming(mode);
        const label = t.phase === "observe" ? "warm-up" : "trade";
        const rem = t.phase === "observe" ? botFmtCountdown(t.observeMs - t.elapsedMs) : botFmtCountdown(t.remainingMs);
        phaseEl.textContent = `${label} ${rem}`;
        phaseEl.className = t.phase === "observe" ? "observe" : "trade";
      }
    }
renderBotPositions(mode);
});
renderBotSwarm();
renderBotLearning();
}

function botCloseOpenPositions(reason) {
botModeIds().forEach(mode => {
Object.keys(botState.modes[mode].positions).forEach(symbol => {
const position = botState.modes[mode].positions[symbol];
const qty = Number(position?.qty || 0);
if (qty <= 0) return;
const quote = botQuoteFor(symbol);
const price = Number(quote?.price || position.lastMarkPrice || position.avgPrice || 0);
if (price <= 0) return;
const entry = Number(position.avgPrice || price);
const candidate = {
symbol,
price,
score: 0,
confidence: 0,
risk: 0,
shortMomentumPct: 0,
noisePct: 0,
signalAction: "Exit",
signalConfidence: 0,
setupType: position.setupType || "unknown",
action: "EXIT",
pnlPct: entry ? ((price - entry) / entry) * 100 : 0,
volatilityPct: 0,
};
if (executeBotSell(mode, candidate, qty, reason)) {
botAppendRunAudit(mode, { action: "SELL", symbol, price, reason, setupType: candidate.setupType, pnl: candidate.pnlPct }, null);
}
});
});
}

function stopBot(reason = "stopped") {
  if (botConfig.strategyMode === "polymarket" || polymarketState.running) {
    if (botState.timer) clearTimeout(botState.timer);
    botState.timer = null;
    if (botState.running || polymarketState.running) stopPolymarketMode(reason);
    botState.running = false;
    botPersistState();
    renderBotStatus();
    return;
  }
  if (botState.timer) clearTimeout(botState.timer);
  botState.timer = null;
  if (window.botL2Timer) clearTimeout(window.botL2Timer);
  window.botL2Timer = null;
  if (botState.running) {
    if (window.tradingBots) {
        Object.values(window.tradingBots).forEach(bot => bot.stop());
    }
    // Every run ends flat. Positions are managed continuously above; this is
    // only the last-resort cash safety net for anything still open at the
    // exact deadline, so capital cannot remain locked in a stopped bot.
    botCloseOpenPositions(reason === "run duration completed" ? "run safety close" : reason);
    botModeIds().forEach(mode => logBotDecision(mode, { action: "STOP", reason }, { key: `stop:${reason}`, throttleMs: 500 }));
    botFinishRunRecord(reason);
  }
  botState.running = false;
  botPersistState();
  renderBotStatus();
}

function scheduleBotDecision() {
  if (!botState.running) return;
  if (botState.timer) clearTimeout(botState.timer);
  if (Date.now() >= botState.stopAt) {
    stopBot("run duration completed");
    return;
  }
  renderBotStatus();
  botState.timer = setTimeout(botConfig.strategyMode === "polymarket" ? runPolymarketTick : enhancedRunBotDecision, BOT_TICK_MS);
}


// Initialize OOP Bots
window.tradingBots = {
  calm: new CalmBot(),
  normal: new NormalBot(),
  aggressive: new AggressiveBot()
};

function startBot() {
if (botState.running) return;
readBotConfig();
resetBotSession();
botState.running = true;
if (botConfig.strategyMode === "polymarket") {
  startPolymarketMode();
  renderBotStatus();
  return;
}
botStartRunRecord();
enabledBotModeIds().forEach(mode => {
  logBotDecision(mode, { action: "START", reason: `$${formatPrice(botCapital(mode))} capital; ${botConfig.durationMin} minute run; scanning ${botUniverseSymbols().length} ${botUniverseLabel()} symbols; free-hand momentum ${botConfig.multiplierEnabled ? "ON" : "off"}` });
});
  renderBotStatus();
  enhancedRunBotDecision();

    enabledBotModeIds().forEach(mode => {
        if (window.tradingBots && window.tradingBots[mode]) {
            window.tradingBots[mode].start();
        }
    });

}

function runBotModeDecisionLegacy(mode, ranked) {
  const def = BOT_MODES[mode];
  const state = botState.modes[mode];
  state.rankings = ranked;
  state.decisions += 1;
  const threshold = def.threshold;
  const strongestCandidate = ranked.find(item => botHeldQuantity(mode, item.symbol) <= 0);

  for (const item of ranked.filter(row => botHeldQuantity(mode, row.symbol) > 0)) {
    const qty = botHeldQuantity(mode, item.symbol);
    const heldMs = Date.now() - (state.positions[item.symbol]?.openedAt || Date.now());
    const betterSetup = heldMs >= def.minHoldMs && strongestCandidate && strongestCandidate.symbol !== item.symbol && strongestCandidate.rankScore >= item.rankScore + def.rotationGap;
    const exitReason = item.pnlPct <= -item.stopLossPct
      ? `risk exit: ${item.pnlPct.toFixed(2)}% hit stop ${item.stopLossPct.toFixed(2)}%`
      : item.pnlPct >= item.takeProfitPct
        ? `profit taken: ${item.pnlPct.toFixed(2)}% reached target ${item.takeProfitPct.toFixed(2)}%`
        : item.score <= Math.max(32, threshold - 25)
          ? `edge faded: ${item.score}/100 below hold line`
          : betterSetup
            ? `rotation: ${strongestCandidate.symbol} has stronger setup`
            : null;
    if (exitReason && qty > 0) {
      executeBotSell(mode, item, qty, exitReason);
      return;
    }
  }

  const snapshot = botPortfolioSnapshot(mode, ranked);
  const minTrade = botMinimumTradeNotional(snapshot);
  if (snapshot.cash < minTrade) {
    logBotDecision(mode, { action: "HOLD", reason: `cash fully deployed; managing exits on $${formatPrice(snapshot.openValue)} open value` }, { key: "fully-deployed", throttleMs: BOT_FULLY_DEPLOYED_LOG_MS });
    return;
  }

  const best = ranked.find(item => item.score >= threshold && botHeldQuantity(mode, item.symbol) <= 0);
  if (!best) {
    logBotDecision(mode, { action: "HOLD", reason: `best ${ranked[0].symbol} ${ranked[0].score}/100; buy line ${threshold}; waiting for cleaner edge` }, { key: `hold:${ranked[0].symbol}:${ranked[0].score}`, throttleMs: 6000 });
    return;
  }

  const notional = botOrderNotional(mode, best, snapshot.cash);
  if (notional < minTrade) {
    logBotDecision(mode, { action: "HOLD", symbol: best.symbol, score: best.score, reason: `capital reserved or position cap reached; cash $${formatPrice(snapshot.cash)}` }, { key: `sized-out:${best.symbol}`, throttleMs: 8000 });
    return;
  }

  executeBotBuy(mode, best, notional, `score ${best.score}/100 over ${threshold}; size $${formatPrice(notional)}; stop ${best.stopLossPct.toFixed(2)}%; target ${best.takeProfitPct.toFixed(2)}%; ${best.reasons}`);
}

function botHistoryStats(history, price) {
  const prices = history.map(item => Number(item.price || 0)).filter(Boolean);
  const samples = prices.length;
  if (!samples || !price) {
    return { samples: 0, momentumPct: 0, shortMomentumPct: 0, volatilityPct: 0.75, noisePct: 0, rsiProxy: 50, zScore: 0, priceMean: price || 0, priceStdDev: 0, supportDistancePct: 0, resistanceDistancePct: 0 };
  }
  const first = prices[0];
  const pivot = prices[Math.max(0, samples - 4)];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const returns = [];
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i - 1] > 0) returns.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  }
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length : 0;
  const volatilityPct = clamp(Math.sqrt(variance), 0.08, 7);
  const noisePct = clamp(volatilityPct - Math.abs(mean), 0, 7);
  
  // RSI calculation
  let gains = 0;
  let losses = 0;
  returns.forEach(ret => {
    if (ret > 0) gains += ret;
    else losses += Math.abs(ret);
  });
  const rs = losses === 0 ? 100 : gains / losses;
  const rsiProxy = returns.length > 0 ? 100 - (100 / (1 + rs)) : 50;

  // Z-Score Mean Reversion: how far is current price from recent mean?
  // Z < -2 = statistically oversold (BUY zone)
  // Z > 0 = price reverted to/above mean (EXIT zone)
  // Use a subset of recent prices for more responsive stats
  const zWindow = prices.slice(-Math.min(samples, 200));
  const priceMean = zWindow.reduce((s, p) => s + p, 0) / zWindow.length;
  const priceVariance = zWindow.reduce((s, p) => s + ((p - priceMean) ** 2), 0) / zWindow.length;
  const priceStdDev = Math.sqrt(priceVariance);
  const zScore = priceStdDev > 0 ? (price - priceMean) / priceStdDev : 0;
  
  return {
    samples,
    momentumPct: first ? ((price - first) / first) * 100 : 0,
    shortMomentumPct: pivot ? ((price - pivot) / pivot) * 100 : 0,
    volatilityPct,
    noisePct,
    rsiProxy,
    zScore,
    priceMean,
    priceStdDev,
    supportDistancePct: low ? ((price - low) / low) * 100 : 0,
    resistanceDistancePct: high ? ((high - price) / price) * 100 : 0,
  };
}

function botMarketAgreement(context) {
  let agreement = 0;
  if (context.changePercent > 0) agreement += 1;
  if (context.momentumPct > 0) agreement += 1;
  if (context.shortMomentumPct > 0) agreement += 1;
  if (context.signalAction === "Buy") agreement += 1;
  if (context.signalAction === "Sell") agreement -= 1;
  if (context.dayRangePct > 6 && context.noisePct > 2.5) agreement -= 1;
  return clamp(agreement / 4, -1, 1);
}

function analyzeBotSymbol(mode, quote) {
  const price = Number(quote.price || 0);
  if (!price || price < 0.001) return null; // Filter broken quotes (e.g. UNI at $0.0002)
  rememberBotPrice(mode, quote.symbol, price);
  const history = botState.modes[mode].priceMemory[quote.symbol] || [];

  // Filter stale data: skip if price hasn't changed in many ticks
  if (history.length >= 2) {
    let staleCount = 0;
    for (let i = history.length - 1; i > 0; i -= 1) {
      if (history[i].price === history[i - 1].price) staleCount += 1;
      else break;
    }
    if (staleCount > BOT_STALE_TICK_LIMIT) return null; // Skip frozen quotes
  }
  const stats = botHistoryStats(history, price);
  const signal = botSignalFor(quote.symbol);
  const heldQty = botHeldQuantity(mode, quote.symbol);
  const entry = botAverageEntry(mode, quote.symbol);
  const changePercent = Number(quote.changePercent ?? quote.change_percent ?? 0);
  const dayRangePct = quote.high && quote.low ? ((quote.high - quote.low) / price) * 100 : 0;
  const pnlPct = heldQty && entry ? ((price - entry) / entry) * 100 : 0;
  
  // Track High Water Mark for Trailing Stops
  let highWaterPrice = 0;
  let drawdownFromHighPct = 0;
  if (heldQty > 0) {
    const pos = botState.modes[mode].positions[quote.symbol];
    if (pos) {
      if (!pos.highWaterPrice || price > pos.highWaterPrice) pos.highWaterPrice = price;
      highWaterPrice = pos.highWaterPrice;
      drawdownFromHighPct = ((highWaterPrice - price) / highWaterPrice) * 100;
    }
  }

  const signalConfidence = Number(signal?.confidence || 50);
  const signalAction = signal?.action || "Hold";
  const context = {
    symbol: quote.symbol,
    price,
    changePercent,
    dayRangePct,
    signalAction,
    signalConfidence,
    heldQty,
    entry,
    pnlPct,
    highWaterPrice,
    drawdownFromHighPct,
    openedAt: botState.modes[mode].positions[quote.symbol]?.openedAt || 0,
    ...stats,
  };
  context.agreement = botMarketAgreement(context);
  context.trendQuality = clamp((context.momentumPct * 9) + (context.shortMomentumPct * 14) + (context.changePercent * 3) + (context.agreement * 18) - (context.noisePct * 4), -45, 55);
  context.riskLoad = clamp((context.volatilityPct * 9) + (context.dayRangePct * 1.6) + Math.max(0, -context.shortMomentumPct) * 9, 0, 100);
  context.opportunity = clamp(50 + context.trendQuality - (context.riskLoad * 0.35), 0, 100);
  context.score = Math.round(context.opportunity);
  context.setupType = window.botClassifySetup(context);
  context.regime = window.botRegimeLabel(context);
context.rankScore = context.opportunity + Math.max(0, context.shortMomentumPct) * 4 + Math.max(0, context.resistanceDistancePct) * 0.6;
return context;
}

function botRecentPerformance(mode) {
  const trades = botState.modes[mode].trades.filter(trade => trade.side === "SELL").slice(0, 12);
  if (!trades.length) return { realizedBias: 0, winRate: 0.5 };
  const wins = trades.filter(trade => Number(trade.pnl || 0) > 0).length;
  const pnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const capital = Math.max(1, botCapital(mode));
  return { realizedBias: clamp((pnl / capital) * 100, -10, 10), winRate: wins / trades.length };
}

function botStrategyProfile(mode, snapshot) {
  const def = BOT_MODES[mode];
  const drawdownPct = snapshot.capital ? Math.max(0, ((snapshot.capital - snapshot.totalValue) / snapshot.capital) * 100) : 0;
  const performance = botRecentPerformance(mode);
  const pressure = clamp(drawdownPct / 8, 0, 1);
  const timeLeftPct = botState.running && botState.stopAt > botState.startedAt
    ? clamp((botState.stopAt - Date.now()) / (botState.stopAt - botState.startedAt), 0, 1)
    : 1;
  const learningBias = ((performance.winRate - 0.5) * 0.12) + (performance.realizedBias / 80);
  const urgency = 1 - timeLeftPct;
  const convictionDemand = clamp(def.convictionBias + pressure * 0.12 - learningBias - urgency * (def.riskAppetite * 0.08), 0.24, 0.86);
  return {
    ...def,
    mode,
    drawdownPct,
    timeLeftPct,
    performance,
    convictionDemand,
    riskTolerance: clamp(def.riskAppetite - pressure * (0.38 - def.riskAppetite * 0.18) + learningBias, 0.16, 0.92),
    patienceLevel: clamp(def.patience + pressure * 0.16 + convictionDemand * 0.08 - urgency * def.riskAppetite * 0.14, 0.15, 0.92),
  };
}

function botDecisionReason(decision, context) {
  const side = decision.action === "BUY" ? `size $${formatPrice(decision.notional || 0)}` : decision.action;
  return `${side}; ${decision.style} style; confidence ${Math.round(decision.confidence)}; risk ${Math.round(decision.risk)}; patience ${Math.round(decision.patience * 100)}; conviction need ${Math.round(decision.conviction * 100)}; momentum ${context.shortMomentumPct >= 0 ? "+" : ""}${context.shortMomentumPct.toFixed(2)}%; noise ${context.noisePct.toFixed(2)}%; ${context.signalAction} signal ${context.signalConfidence}%`;
}

function botBuildDecision(action, context, profile, confidence, risk, notional = 0, sellFraction = 0) {
  const volatility = Math.max(0.25, context.volatilityPct);
  return {
    action,
    symbol: context.symbol,
    price: context.price,
    score: Math.round(confidence),
    confidence: clamp(confidence, 0, 100),
    risk: clamp(risk, 0, 100),
    style: profile.label,
    patience: profile.patienceLevel,
    conviction: profile.convictionDemand,
    notional,
    sellFraction,
    stopLossPct: clamp(0.35 + volatility * (0.7 + profile.riskTolerance), 0.35, 6.5),
    takeProfitPct: clamp(0.5 + volatility * (1.1 + profile.riskTolerance) + Math.max(0, confidence - 62) * 0.035, 0.45, 9),
  };
}

function botObservationNeed(profile) {
  return Math.round(clamp(2.5 + profile.patienceLevel * 3.2 + profile.convictionDemand * 1.4 - profile.riskTolerance * 1.2, 3, 7));
}

function botMinimumEdge(profile, context, snapshot) {
  const exposurePct = snapshot.capital ? snapshot.openValue / snapshot.capital : 0;
  const uncertainty = context.noisePct * 1.25 + Math.max(0, -context.agreement) * 7 + exposurePct * 5;
  const performanceAdjustment = profile.performance.realizedBias * 0.25 + (profile.performance.winRate - 0.5) * 5;
  return clamp(
    5 + profile.patienceLevel * 11 + profile.convictionDemand * 13 - profile.riskTolerance * 9 + uncertainty - performanceAdjustment,
    3,
    28,
  );
}

function calmStrategyBrain(context, profile, snapshot) {
  const ready = context.samples >= botObservationNeed(profile);
  const confidence = clamp(42 + context.trendQuality * 0.78 + context.agreement * 18 - context.noisePct * 7 - profile.drawdownPct * 2 - profile.convictionDemand * 5, 0, 100);
  const risk = clamp(context.riskLoad * (0.78 + profile.convictionDemand * 0.14) + Math.max(0, -context.shortMomentumPct) * 8, 0, 100);
  const edge = confidence - risk * 0.42 - profile.patienceLevel * 8 - profile.convictionDemand * 7;
  const requiredEdge = botMinimumEdge(profile, context, snapshot);
  if (!ready) return botBuildDecision("WAIT", context, profile, confidence, risk);
  if (context.heldQty > 0 && (context.pnlPct <= -botBuildDecision("HOLD", context, profile, confidence, risk).stopLossPct || (context.pnlPct > 0.35 && context.shortMomentumPct < 0))) return botBuildDecision("EXIT", context, profile, confidence, risk, 0, 1);
  if (context.heldQty > 0) return botBuildDecision("HOLD", context, profile, confidence, risk);
  const available = Math.max(0, snapshot.cash - snapshot.capital * (0.22 + profile.drawdownPct / 80));
  const conviction = clamp((edge - requiredEdge + 12) / 48, 0, 0.72) * clamp(1 - profile.convictionDemand * 0.35, 0.55, 1);
  const notional = Math.min(available, snapshot.capital * profile.maxPosition * conviction);
  return notional >= Math.max(0.25, snapshot.capital * 0.01) && edge >= requiredEdge ? botBuildDecision("BUY", context, profile, confidence, risk, notional) : botBuildDecision("WATCH", context, profile, confidence, risk);
}

function normalStrategyBrain(context, profile, snapshot) {
  const ready = context.samples >= botObservationNeed(profile);
  const confidence = clamp(45 + context.trendQuality * 0.92 + context.agreement * 16 - context.noisePct * 4 + profile.performance.realizedBias - profile.convictionDemand * 2, 0, 100);
  const risk = clamp(context.riskLoad * (0.66 + profile.convictionDemand * 0.12) + Math.max(0, -context.momentumPct) * 4, 0, 100);
  const edge = confidence - risk * 0.34 - profile.patienceLevel * 5 - profile.convictionDemand * 4;
  const requiredEdge = botMinimumEdge(profile, context, snapshot);
  if (!ready) return botBuildDecision("WAIT", context, profile, confidence, risk);
  if (context.heldQty > 0 && context.pnlPct <= -botBuildDecision("HOLD", context, profile, confidence, risk).stopLossPct) return botBuildDecision("EXIT", context, profile, confidence, risk, 0, 1);
  if (context.heldQty > 0 && context.pnlPct > botBuildDecision("HOLD", context, profile, confidence, risk).takeProfitPct) return botBuildDecision("LOCK PROFIT", context, profile, confidence, risk, 0, 0.55);
  if (context.heldQty > 0) return botBuildDecision("HOLD", context, profile, confidence, risk);
  const deployedPct = snapshot.capital ? snapshot.openValue / snapshot.capital : 0;
  const exposureRoom = Math.max(0, (snapshot.capital * profile.maxExposure) - snapshot.openValue);
  const conviction = clamp((edge - requiredEdge + 15 + (1 - deployedPct) * 8) / 62, 0, 1);
  const notional = Math.min(snapshot.cash, exposureRoom, snapshot.capital * profile.maxPosition * conviction);
  return notional >= Math.max(0.25, snapshot.capital * 0.01) && edge >= requiredEdge ? botBuildDecision("BUY", context, profile, confidence, risk, notional) : botBuildDecision("WATCH", context, profile, confidence, risk);
}

function aggressiveStrategyBrain(context, profile, snapshot) {
  const ready = context.samples >= botObservationNeed(profile);
  const acceleration = Math.max(0, context.shortMomentumPct - Math.max(0, context.noisePct * 0.18));
  const confidence = clamp(43 + context.trendQuality * 1.08 + acceleration * 12 + context.agreement * 12 - Math.max(0, -profile.performance.realizedBias) * 0.7 + (1 - profile.convictionDemand) * 4, 0, 100);
  const risk = clamp(context.riskLoad * (0.56 + profile.convictionDemand * 0.1) + context.noisePct * 3 + profile.drawdownPct * 1.2, 0, 100);
  const edge = confidence - risk * 0.26 - profile.patienceLevel * 3 - profile.convictionDemand * 2;
  const requiredEdge = botMinimumEdge(profile, context, snapshot);
  if (!ready) return botBuildDecision("WAIT", context, profile, confidence, risk);
  if (context.heldQty > 0 && context.pnlPct <= -botBuildDecision("HOLD", context, profile, confidence, risk).stopLossPct) return botBuildDecision("EXIT", context, profile, confidence, risk, 0, 1);
  if (context.heldQty > 0 && context.pnlPct > 0.45 && context.shortMomentumPct < -0.05) return botBuildDecision("REDUCE", context, profile, confidence, risk, 0, 0.42);
  if (context.heldQty > 0) return botBuildDecision("HOLD", context, profile, confidence, risk);
  const exposureRoom = Math.max(0, (snapshot.capital * profile.maxExposure) - snapshot.openValue);
  const conviction = clamp((edge - requiredEdge + 18) / 58, 0, 1.12);
  const notional = Math.min(snapshot.cash, exposureRoom, snapshot.capital * profile.maxPosition * conviction);
  return notional >= Math.max(0.25, snapshot.capital * 0.01) && edge >= requiredEdge ? botBuildDecision("BUY", context, profile, confidence, risk, notional) : botBuildDecision("WATCH", context, profile, confidence, risk);
}

function botBrainFor(mode, context, profile, snapshot) {
  if (mode === "calm") return calmStrategyBrain(context, profile, snapshot);
  if (mode === "aggressive") return aggressiveStrategyBrain(context, profile, snapshot);
  return normalStrategyBrain(context, profile, snapshot);
}

function botOrderNotional(mode, candidate, cash) {
  const profile = botStrategyProfile(mode, botPortfolioSnapshot(mode));
  const currentValue = botHeldQuantity(mode, candidate.symbol) * candidate.price;
  const positionRoom = Math.max(0, (botCapital(mode) * profile.maxPosition) - currentValue);
  return Math.min(cash, positionRoom, Number(candidate.notional || 0));
}

function runBotModeDecision(mode, ranked) {
  const state = botState.modes[mode];
  state.rankings = ranked;
  state.decisions += 1;
  const snapshot = botPortfolioSnapshot(mode, ranked);
  const profile = botStrategyProfile(mode, snapshot);
  const held = ranked.filter(item => botHeldQuantity(mode, item.symbol) > 0);

  for (const item of held) {
    const decision = botBrainFor(mode, item, profile, snapshot);
    if ((decision.action === "EXIT" || decision.action === "REDUCE" || decision.action === "LOCK PROFIT") && item.heldQty > 0) {
      const qty = item.heldQty * (decision.sellFraction || 1);
      executeBotSell(mode, item, qty, botDecisionReason(decision, item));
      return;
    }
  }

  const openSymbols = new Set(held.map(item => item.symbol));
  const candidates = ranked.filter(item => !openSymbols.has(item.symbol));
  const decisions = candidates.map(item => ({ context: item, decision: botBrainFor(mode, item, profile, snapshot) }));
  const buy = decisions
    .filter(item => item.decision.action === "BUY")
    .sort((a, b) => (b.decision.confidence - b.decision.risk * 0.35) - (a.decision.confidence - a.decision.risk * 0.35))[0];

  if (buy) {
    const notional = botOrderNotional(mode, buy.decision, snapshot.cash);
    if (notional >= Math.max(0.25, snapshot.capital * 0.01)) {
      executeBotBuy(mode, { ...buy.context, ...buy.decision, notional }, notional, botDecisionReason({ ...buy.decision, notional }, buy.context));
      return;
    }
  }

  const top = decisions[0] || (held[0] ? { context: held[0], decision: botBrainFor(mode, held[0], profile, snapshot) } : null);
  if (!top) return;
  const action = top.decision.action === "WAIT" ? "WAIT" : "WATCH";
  const observationNeed = botObservationNeed(profile);
  const sampleText = top.context.samples < observationNeed ? `; samples ${top.context.samples}/${observationNeed}` : "";
  logBotDecision(mode, { action, symbol: top.context.symbol, score: top.decision.score, reason: `${botDecisionReason(top.decision, top.context)}${sampleText}` }, { key: `${action}:${top.context.symbol}:${Math.round(top.decision.confidence / 5)}`, throttleMs: action === "WAIT" ? 2500 : 4500 });
}

function botRunTiming(mode = "normal") {
const now = Date.now();
const startedAt = Number(botState.startedAt || now);
const stopAt = Number(botState.stopAt || now + Math.max(1, Number(botConfig.durationMin || 30)) * 60000);
const durationMs = Math.max(1000, stopAt - startedAt);
const elapsedMs = clamp(now - startedAt, 0, durationMs);
const remainingMs = clamp(stopAt - now, 0, durationMs);
const progress = durationMs ? elapsedMs / durationMs : 0;
// Watch phase: user-configurable minutes, capped at 50% of the run so short demo runs still trade.
const configuredObserveMs = Number(botConfig.observeMinutes ?? defaultBotConfig.observeMinutes) * 60000;
const observeMs = clamp(configuredObserveMs, mode === "aggressive" ? 1500 : mode === "calm" ? 3500 : 2500, Math.max(30000, durationMs * 0.5));
// Start releasing risk well before the deadline. The final stop is only a
// backstop; positions should normally be closed during this earlier window.
const exitMs = clamp(durationMs * 0.15, Math.min(60_000, durationMs * 0.25), Math.min(180_000, durationMs * 0.3));
let phase = "build";
if (elapsedMs < observeMs) phase = "observe";
else if (remainingMs <= exitMs) phase = "exit";
else if (progress > 0.62) phase = "manage";
const activeWindow = Math.max(1, durationMs - observeMs - exitMs);
const activeProgress = clamp((elapsedMs - observeMs) / activeWindow, 0, 1);
return { now, startedAt, stopAt, durationMs, elapsedMs, remainingMs, progress, activeProgress, observeMs, exitMs, phase };
}

function polymarketEdgeBucket(edge) {
  const value = Math.abs(Number(edge || 0));
  if (value >= 0.12) return "large";
  if (value >= 0.07) return "medium";
  return "small";
}

function polymarketRecordAudit(action, reason, market = null, extra = {}) {
  polymarketState.audit.push({
    ts: new Date().toISOString(),
    elapsedSec: botState.startedAt ? Math.round((Date.now() - botState.startedAt) / 1000) : 0,
    action,
    interval: polymarketState.interval,
    slug: market?.slug || null,
    reason,
    ...extra,
  });
  polymarketState.audit = polymarketState.audit.slice(-1200);
}

function polymarketLearningEdge(edge) {
  const bucket = polymarketEdgeBucket(edge);
  const stats = polymarketState.learning.byEdge?.[bucket];
  if (!stats || stats.n < 3) return 0;
  return clamp((stats.wins / stats.n - 0.5) * 2, -0.8, 0.8);
}

function polymarketRecordLearning(position, pnl) {
  const learning = polymarketState.learning;
  const side = position.side;
  const edgeBucket = polymarketEdgeBucket(position.edge);
  const update = (store, key) => {
    const stats = store[key] || { n: 0, wins: 0, pnl: 0 };
    stats.n += 1;
    stats.wins += pnl > 0 ? 1 : 0;
    stats.pnl += pnl;
    store[key] = stats;
  };
  learning.trades += 1;
  learning.wins += pnl > 0 ? 1 : 0;
  learning.losses += pnl > 0 ? 0 : 1;
  learning.pnl += pnl;
  update(learning.bySide, side);
  update(learning.byEdge, edgeBucket);
  localStorage.setItem("trader-desk-polymarket-learning-v1", JSON.stringify(learning));
}

function polymarketClosePosition(reason, exitPrice, market = null, action = "SELL") {
  const position = polymarketState.position;
  if (!position) return false;
  const price = exitPrice === null || exitPrice === undefined
    ? Number(position.lastMark || position.entryPrice || 0)
    : Number(exitPrice);
  if (!(price >= 0 && price <= 1)) return false;
  const proceeds = position.qty * price;
  const pnl = proceeds - position.cost;
  polymarketState.cash += proceeds;
  polymarketState.realized += pnl;
  polymarketRecordLearning(position, pnl);
  polymarketState.trades.unshift({
    time: botNow(), action, side: position.side, slug: position.slug,
    qty: position.qty, price, notional: proceeds, pnl, reason,
  });
  polymarketState.trades = polymarketState.trades.slice(0, 200);
  polymarketRecordAudit(action, reason, market, { side: position.side, price, pnl });
  polymarketState.position = null;
  polymarketState.lastExitAt = Date.now();
  polymarketState.lastDecision = reason;
  return true;
}

function polymarketSettlePosition(reason, won, market = null) {
  return polymarketClosePosition(reason, won ? 1 : 0, market, "SETTLE");
}

function polymarketNormalCdf(value) {
  return clamp(0.5 + 0.5 * Math.tanh(Number(value || 0) * 0.79788456), 0.001, 0.999);
}

function polymarketConfirmModel(model) {
  if (!model.ready) {
    polymarketState.modelSide = null;
    polymarketState.modelSideCount = 0;
    return model;
  }
  if (polymarketState.modelSide === model.side) polymarketState.modelSideCount += 1;
  else {
    polymarketState.modelSide = model.side;
    polymarketState.modelSideCount = 1;
  }
  return { ...model, confirmed: polymarketState.modelSideCount >= 3 };
}

function polymarketModel(market) {
  const history = polymarketState.history;
  const price = Number(polymarketState.latest?.spot?.price || 0);
  const referencePrice = Number(market.reference?.price || 0);
  const remainingSeconds = Math.max(1, Number(market.secondsRemaining || 0));
  const spotAgeMs = Number(polymarketState.latest?.spot?.ageMs);
  if (!(price > 0) || !(referencePrice > 0)) return { ready: false, reason: "Waiting for the Chainlink price-to-beat anchor" };
  if (market.anchorReady !== true) return { ready: false, reason: "Waiting for an exact Chainlink window-start anchor" };
  if (Number.isFinite(spotAgeMs) && spotAgeMs > 5_000) return { ready: false, reason: `Chainlink feed stale (${Math.ceil(spotAgeMs / 1000)}s)` };
  if (history.length < 8) return { ready: false, reason: `Collecting Chainlink momentum (${history.length}/8 samples)` };

  const points = history.slice(-90).filter(row => Number(row.price) > 0 && Number(row.time) > 0);
  const returns = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const dt = clamp((Number(current.time) - Number(previous.time)) / 1000, 0.25, 10);
    const logReturn = Math.log(Number(current.price) / Number(previous.price));
    if (Number.isFinite(logReturn)) returns.push({ logReturn, dt });
  }
  if (returns.length < 4) return { ready: false, reason: "Waiting for enough live Chainlink movement" };
  const totalSeconds = returns.reduce((sum, row) => sum + row.dt, 0);
  const driftPerSecond = returns.reduce((sum, row) => sum + row.logReturn, 0) / Math.max(1, totalSeconds);
  const variancePerSecond = returns.reduce((sum, row) => sum + (row.logReturn ** 2), 0) / Math.max(1, totalSeconds);
  // A quiet few seconds must not collapse the binary-event volatility to
  // almost zero. That was producing absurd 90%+ probabilities from a tiny
  // move around the price-to-beat and caused rapid direction flips.
  const horizonVolFloor = 0.00055 * Math.sqrt(Math.max(60, remainingSeconds) / 300);
  const sigmaRemaining = Math.max(horizonVolFloor, Math.sqrt(variancePerSecond) * Math.sqrt(remainingSeconds));
  const moveFromReference = Math.log(price / referencePrice);
  // Short-horizon drift is useful as a small confirmation, not as a forecast
  // of the entire remaining event. The old multiplier overfit a few recent
  // ticks and turned a 0.03% move into an implausible 88-91% prediction.
  const driftAdjustment = clamp(driftPerSecond * remainingSeconds * 0.08, -sigmaRemaining * 0.2, sigmaRemaining * 0.2);
  const rawModelUp = polymarketNormalCdf((moveFromReference + driftAdjustment) / sigmaRemaining);
  const marketPrior = Number(market.yes?.mid);
  if (!(marketPrior > 0 && marketPrior < 1)) return { ready: false, reason: "Waiting for a live executable market midpoint" };
  // The CLOB is already an information-rich prior. The Chainlink/PTB model
  // is a residual signal, not permission to fade an 85% market with a tiny
  // two-minute move. Keeping the prior dominant prevents underdog churn while
  // still allowing a genuine model/book disagreement to create edge.
  const modelUp = clamp(marketPrior * 0.75 + rawModelUp * 0.25, 0.01, 0.99);
  const shortLookback = points[Math.max(0, points.length - 12)]?.price || price;
  const shortReturnPct = ((price - shortLookback) / shortLookback) * 100;
  const referenceMovePct = ((price - referencePrice) / referencePrice) * 100;
  const momentumZ = (moveFromReference + driftAdjustment) / sigmaRemaining;
  const yesAsk = Number(market.yes?.buyPrice ?? market.yes?.ask ?? 0);
  const noAsk = Number(market.no?.buyPrice ?? market.no?.ask ?? 0);
  const yesSpread = Number(market.yes?.spread || 0);
  const noSpread = Number(market.no?.spread || 0);
  const yesEdge = yesAsk > 0 && yesAsk < 1 ? modelUp - yesAsk : -1;
  const noEdge = noAsk > 0 && noAsk < 1 ? (1 - modelUp) - noAsk : -1;
  const side = yesEdge >= noEdge ? "YES" : "NO";
  const edge = Math.max(yesEdge, noEdge);
  const buyPrice = side === "YES" ? yesAsk : noAsk;
  const spread = side === "YES" ? yesSpread : noSpread;
  const learnedEdge = polymarketLearningEdge(edge);
  const requiredEdge = clamp(Math.max(0.05, spread * 0.75 + 0.012, 0.055 - learnedEdge * 0.01), 0.045, 0.12);
  const sideProbability = side === "YES" ? modelUp : 1 - modelUp;
  return {
    ready: true,
    side,
    edge,
    buyPrice,
    ask: buyPrice,
    modelUp,
    momentumZ,
    returnPct: shortReturnPct,
    referenceMovePct,
    sigmaRemaining,
    rawModelUp,
    marketPrior,
    spread,
    requiredEdge,
    confidence: clamp(0.5 + Math.abs(edge) * 3.2 + Math.min(0.15, Math.abs(momentumZ) * 0.03), 0, 0.98),
    reason: `${side} fair ${(sideProbability * 100).toFixed(1)}% vs buy ${buyPrice.toFixed(3)} · edge ${(edge * 100).toFixed(1)}% · ${referenceMovePct >= 0 ? "+" : ""}${referenceMovePct.toFixed(3)}% vs PTB · ${Math.ceil(remainingSeconds)}s left`,
  };
}

function polymarketOpenPosition(model, market, timing) {
  const eventEntryCutoffSeconds = Math.max(45, Number(timing.exitMs || 0) / 1000);
  if (!model.ready || model.confirmed !== true || Number(market.secondsRemaining || 0) <= eventEntryCutoffSeconds || Date.now() - Number(polymarketState.lastExitAt || 0) < 15_000 || model.edge < model.requiredEdge || !(model.buyPrice > 0 && model.buyPrice < 1)) return false;
  const minTokens = Math.max(5, Number(market[model.side === "YES" ? "yes" : "no"]?.minOrderSize || 5));
  const maxAllocation = clamp(0.25 + Math.max(0, model.edge - model.requiredEdge) * 4.5, 0.25, 0.9);
  const cost = Math.min(polymarketState.cash, polymarketState.capital * maxAllocation);
  if (cost < model.buyPrice * minTokens) return false;
  const qty = cost / model.buyPrice;
  polymarketState.cash -= cost;
  polymarketState.position = {
    side: model.side,
    slug: market.slug,
    interval: market.interval,
    qty,
    cost,
    entryPrice: model.buyPrice,
    lastMark: model.buyPrice,
    highMark: model.buyPrice,
    windowEnd: market.windowEnd,
    referencePrice: market.reference?.price,
    edge: model.edge,
    momentumZ: model.momentumZ,
    openedAt: Date.now(),
  };
  polymarketState.trades.unshift({ time: botNow(), action: "BUY", side: model.side, slug: market.slug, qty, price: model.buyPrice, notional: cost, reason: model.reason });
  polymarketState.trades = polymarketState.trades.slice(0, 200);
  polymarketRecordAudit("BUY", `Paper ${model.reason}`, market, { side: model.side, price: model.buyPrice, notional: cost, confidence: model.confidence, referencePrice: market.reference?.price });
  polymarketState.lastDecision = `Bought ${model.side} · ${model.reason}`;
  return true;
}

function polymarketManagePosition(model, market, timing) {
  const position = polymarketState.position;
  if (!position) return false;
  const book = market[position.side === "YES" ? "yes" : "no"] || {};
  const mark = Number(book.sellPrice ?? book.bid ?? book.mid ?? position.lastMark ?? 0);
  if (mark > 0) position.lastMark = mark;
  position.highMark = Math.max(Number(position.highMark || position.entryPrice), Number(position.lastMark || 0));
  const pnlPct = position.entryPrice ? ((position.lastMark - position.entryPrice) / position.entryPrice) * 100 : 0;
  const marketProb = Number(market.yes?.mid || 0.5);
  const modelUp = model.ready ? Number(model.modelUp) : marketProb;
  const thesisFlip = model.confirmed === true && (position.side === "YES"
    ? modelUp < marketProb - 0.05
    : modelUp > marketProb + 0.05);
  const givebackPct = position.highMark ? ((position.highMark - position.lastMark) / position.highMark) * 100 : 0;
  const profitGiveback = pnlPct >= 8 && givebackPct >= 3;
  const hardLoss = pnlPct <= -8;
  // botRunTiming.exitMs is milliseconds; the Polymarket market clock is
  // seconds. Keep the units explicit so a 180-second runtime buffer cannot
  // accidentally become a 180,000-second event exit threshold.
  const runtimeExitSeconds = Number(timing.exitMs || 0) / 1000;
  const eventSafety = Number(market.secondsRemaining || 0) <= Math.max(45, runtimeExitSeconds);
  if (thesisFlip || hardLoss || profitGiveback || eventSafety) {
    const reason = eventSafety
      ? `Market safety exit · ${Math.ceil(Number(market.secondsRemaining || 0))}s remain`
      : thesisFlip
        ? `Probability thesis flipped · ${model.reason}`
        : profitGiveback
          ? `Profit protected · ${pnlPct.toFixed(1)}% gain gave back ${givebackPct.toFixed(1)}%`
          : `Loss cut · ${pnlPct.toFixed(1)}%`;
    return polymarketClosePosition(reason, position.lastMark, market);
  }
  const fairSideProbability = position.side === "YES" ? model.modelUp : 1 - model.modelUp;
  polymarketState.lastDecision = `Holding ${position.side} · mark ${position.lastMark.toFixed(3)} · P&L ${pnlPct.toFixed(1)}% · ${model.ready ? `fair ${(fairSideProbability * 100).toFixed(1)}%` : "feed updating"}`;
  return false;
}

function renderPolymarketPanel() {
  if (polymarketSwarmEngine) {
    polymarketSwarmEngine.render();
    return;
  }
  const panel = document.querySelector("#bot-polymarket-panel");
  if (!panel) return;
  if (!polymarketState.running) {
    polymarketState.interval = botConfig.polymarketInterval || "15m";
    polymarketState.capital = Math.max(1, Number(botConfig.polymarketCapital || 100));
  }
  const latest = polymarketState.latest;
  const market = latest?.markets?.find(row => row.interval === polymarketState.interval);
  const summary = document.querySelector("#polymarket-summary");
  const card = document.querySelector("#polymarket-market-card");
  const trades = document.querySelector("#polymarket-trades");
  const learning = document.querySelector("#polymarket-learning");
  const position = polymarketState.position;
  const value = polymarketState.cash + (position ? position.qty * Number(position.lastMark || position.entryPrice || 0) : 0);
  if (summary) summary.innerHTML = `<div><span>Paper value</span><strong class="${polymarketState.realized >= 0 ? "positive" : "negative"}">$${formatPrice(value)}</strong></div><div><span>P&L</span><strong class="${polymarketState.realized >= 0 ? "positive" : "negative"}">${polymarketState.realized >= 0 ? "+" : ""}$${formatPrice(polymarketState.realized)}</strong></div><div><span>Chainlink BTC</span><strong>$${formatPrice(latest?.spot?.price)}</strong><small>${latest?.spot?.stale ? "stale" : `${latest?.spot?.ageMs ?? "--"}ms old`}</small></div><div><span>Decision</span><strong>${polymarketState.lastDecision || "Watching"}</strong></div>`;
  if (card) {
    if (!market) card.innerHTML = `<div class="polymarket-empty">No active BTC ${polymarketState.interval} market is available right now.</div>`;
    else card.innerHTML = `<div class="polymarket-market-head"><div><strong>${market.question || `BTC ${market.interval}`}</strong><small>${Math.ceil(Number(market.secondsRemaining || 0))}s remaining · ${market.stale ? "CLOB prices stale" : "live CLOB prices"} · ${market.anchorReady ? `PTB $${formatPrice(market.reference?.price)}` : "PTB anchor pending"}</small></div><span class="polymarket-live-dot"></span></div><div class="polymarket-outcomes"><div class="poly-outcome yes"><span>UP / YES</span><strong>${Number(market.yes?.mid || 0).toFixed(3)}</strong><small>buy ${Number((market.yes?.buyPrice ?? market.yes?.ask) || 0).toFixed(3)} · sell ${Number((market.yes?.sellPrice ?? market.yes?.bid) || 0).toFixed(3)}</small></div><div class="poly-outcome no"><span>DOWN / NO</span><strong>${Number(market.no?.mid || 0).toFixed(3)}</strong><small>buy ${Number((market.no?.buyPrice ?? market.no?.ask) || 0).toFixed(3)} · sell ${Number((market.no?.sellPrice ?? market.no?.bid) || 0).toFixed(3)}</small></div></div><p class="polymarket-thesis">${polymarketState.lastDecision || "The paper model is aligning Chainlink PTB, fair probability, and executable CLOB prices."}</p>`;
  }
  if (trades) trades.innerHTML = position ? `<div class="poly-position"><b>${position.side}</b><span>${position.qty.toFixed(2)} tokens @ ${position.entryPrice.toFixed(3)}</span><strong>mark ${Number(position.lastMark || position.entryPrice).toFixed(3)}</strong></div>` : `<em>No open paper position. The mode waits for a real probability edge.</em>`;
  if (learning) learning.innerHTML = `<div class="poly-learning-stats"><span>${polymarketState.learning.trades} closed</span><span>${polymarketState.learning.trades ? Math.round(polymarketState.learning.wins / polymarketState.learning.trades * 100) : 0}% win</span><span>${polymarketState.learning.pnl >= 0 ? "+" : ""}$${formatPrice(polymarketState.learning.pnl)}</span></div><p>${Object.entries(polymarketState.learning.byEdge || {}).map(([bucket, stats]) => `${bucket}: ${stats.wins}/${stats.n}`).join(" · ") || "Learning starts after the first closed paper trade."}</p>`;
}

async function runPolymarketTick() {
  if (polymarketSwarmEngine) {
    await polymarketSwarmEngine.tick();
    return;
  }
  if (!botState.running || botConfig.strategyMode !== "polymarket" || polymarketState.inFlight) return;
  if (Date.now() >= botState.stopAt) {
    stopBot("run duration completed");
    return;
  }
  polymarketState.inFlight = true;
  try {
    const data = await fetchFromApi("/api/polymarket/btc");
    polymarketState.latest = data;
    const spotPrice = Number(data.spot?.price || 0);
    if (spotPrice > 0) {
      const timestamp = Number(data.spot?.timestampMs || Date.now());
      const previous = polymarketState.history[polymarketState.history.length - 1];
      if (!previous || timestamp > Number(previous.time)) polymarketState.history.push({ time: timestamp, price: spotPrice });
      polymarketState.history = polymarketState.history.slice(-180);
    }
    const timing = botRunTiming("polymarket");
    const market = (data.markets || []).find(row => row.interval === polymarketState.interval);
    const heldMarket = polymarketState.position
      ? (data.markets || []).find(row => row.slug === polymarketState.position.slug)
      : null;
    const positionExpired = polymarketState.position
      && Number(polymarketState.position.windowEnd || 0) > 0
      && Date.now() >= Number(polymarketState.position.windowEnd) * 1000;
    if (positionExpired && spotPrice > 0 && Number(polymarketState.position.referencePrice || 0) > 0) {
      const position = polymarketState.position;
      const won = position.side === "YES"
        ? spotPrice >= Number(position.referencePrice)
        : spotPrice < Number(position.referencePrice);
      polymarketSettlePosition(`Market settled ${won ? "WIN" : "LOSS"} · ${position.side} vs Chainlink PTB`, won, heldMarket || market);
    } else if (polymarketState.position && heldMarket) {
      const model = polymarketConfirmModel(polymarketModel(heldMarket));
      polymarketManagePosition(model, heldMarket, timing);
    } else if (polymarketState.position && !heldMarket) {
      polymarketState.lastDecision = "Held market temporarily missing; position remains pinned and risk is not guessed";
      polymarketRecordAudit("WATCH", polymarketState.lastDecision, market);
    } else if (!market) {
      polymarketState.lastDecision = `Waiting for active BTC ${polymarketState.interval} market`;
      polymarketRecordAudit("WATCH", polymarketState.lastDecision);
    } else if (timing.phase === "observe") {
      polymarketState.lastDecision = `Warm-up: collecting BTC momentum (${polymarketState.history.length} samples) — no entry`;
      polymarketRecordAudit("WATCH", polymarketState.lastDecision, market);
    } else {
      const model = polymarketConfirmModel(polymarketModel(market));
      const eventEntryCutoffSeconds = Math.max(45, Number(timing.exitMs || 0) / 1000);
      if (timing.phase !== "exit" && Number(market.secondsRemaining || 0) > eventEntryCutoffSeconds && !data.spot?.stale && !market.stale && model.ready) {
        if (!polymarketOpenPosition(model, market, timing)) {
          polymarketState.lastDecision = model.confirmed !== true
            ? `Confirming ${model.side} probability signal (${polymarketState.modelSideCount}/3)`
            : model.edge >= model.requiredEdge
              ? "Setup passed; waiting for a clean executable price or cooldown"
              : `Watching · edge ${(model.edge * 100).toFixed(1)}% below ${(model.requiredEdge * 100).toFixed(1)}%`;
        }
      } else if (data.spot?.stale || market.stale) {
        polymarketState.lastDecision = "Stale Chainlink/CLOB prices: monitoring only, no new paper entry";
      } else if (Number(market.secondsRemaining || 0) <= eventEntryCutoffSeconds) {
        polymarketState.lastDecision = `Event safety window: no new entry with ${Math.ceil(Number(market.secondsRemaining || 0))}s left`;
      } else if (!model.ready) {
        polymarketState.lastDecision = model.reason;
      }
    }
    polymarketState.error = "";
  } catch (error) {
    polymarketState.error = error.message || "Polymarket feed unavailable";
    polymarketState.lastDecision = polymarketState.error;
  } finally {
    polymarketState.inFlight = false;
    renderPolymarketPanel();
    renderBotStatus();
    scheduleBotDecision();
  }
}

function resetPolymarketSession() {
  if (polymarketSwarmEngine) {
    polymarketSwarmEngine.reset();
    return;
  }
  polymarketState.running = false;
  polymarketState.startedAt = null;
  polymarketState.stopAt = null;
  polymarketState.cash = 100;
  polymarketState.capital = 100;
  polymarketState.realized = 0;
  polymarketState.position = null;
  polymarketState.trades = [];
  polymarketState.history = [];
  polymarketState.latest = null;
  polymarketState.lastDecision = null;
  polymarketState.error = "";
  polymarketState.audit = [];
  polymarketState.modelSide = null;
  polymarketState.modelSideCount = 0;
  polymarketState.lastExitAt = 0;
  renderPolymarketPanel();
}

function startPolymarketMode() {
  if (polymarketSwarmEngine) {
    polymarketSwarmEngine.start(botConfig);
    appendTerminalLine(`[BOT] Polymarket BTC ${polymarketState.interval} · Calm / Normal / Aggressive swarms started`, "ok");
    runPolymarketTick();
    return;
  }
  polymarketState.interval = botConfig.polymarketInterval || "15m";
  polymarketState.capital = Math.max(1, Number(botConfig.polymarketCapital || 100));
  polymarketState.cash = polymarketState.capital;
  polymarketState.running = true;
  polymarketState.startedAt = Date.now();
  polymarketState.stopAt = botState.stopAt;
  polymarketState.position = null;
  polymarketState.trades = [];
  polymarketState.history = [];
  polymarketState.lastDecision = "Starting live Polymarket paper watcher";
  polymarketRecordAudit("START", `BTC ${polymarketState.interval} paper mode · warm-up blocks entries`);
  appendTerminalLine(`[BOT] Polymarket BTC ${polymarketState.interval} paper mode started`, "ok");
  renderPolymarketPanel();
  runPolymarketTick();
}

function stopPolymarketMode(reason = "stopped") {
  if (polymarketSwarmEngine) {
    polymarketSwarmEngine.stop(reason);
    appendTerminalLine(`[BOT] Polymarket swarms stopped · ${reason}`, "ok");
    renderPolymarketPanel();
    return;
  }
  if (polymarketState.position) polymarketClosePosition(reason === "run duration completed" ? "run safety close before deadline" : reason, polymarketState.position.lastMark);
  polymarketState.running = false;
  polymarketState.stopAt = null;
  polymarketRecordAudit("STOP", reason);
  appendTerminalLine(`[BOT] Polymarket paper mode stopped · ${reason}`, "ok");
  renderPolymarketPanel();
}

const tradingBots = window.tradingBots || {
  calm: new CalmBot(),
  normal: new NormalBot(),
  aggressive: new AggressiveBot()
};

async function enhancedRunBotDecision() {
if (!botState.running) return;
if (Date.now() >= botState.stopAt) {
stopBot("run duration completed");
return;
}
const symbols = botUniverseSymbols();
if (!symbols.length) {
enabledBotModeIds().forEach(mode => {
const row = { action: "HOLD", reason: `${botUniverseLabel()} empty` };
logBotDecision(mode, row, { key: "empty-universe", throttleMs: 5000 });
botAppendRunAudit(mode, row, null);
});
renderBotStatus();
scheduleBotDecision();
return;
}
try {
const universe = symbols
.map(symbol => quotes.find(quote => quote.symbol === symbol))
.filter(quote => quote && Number(quote.price || 0) > 0);
if (!universe.length) {
enabledBotModeIds().forEach(mode => {
const row = { action: "HOLD", reason: `waiting for live ${botUniverseLabel()} prices` };
logBotDecision(mode, row, { key: "no-prices", throttleMs: 5000 });
botAppendRunAudit(mode, row, null);
});
renderBotStatus();
scheduleBotDecision();
return;
}
  for (const mode of enabledBotModeIds()) {
  const bot = tradingBots[mode];
  if (!bot || !bot.worker) continue;
  const results = await Promise.all(universe.map(quote => bot.worker.evaluate(quote).catch(() => null)));
  const ranked = botRankAnalyses(results);
  if (ranked.length) {
    bot.runModeDecision(ranked);
  } else {
    const heldRows = Object.entries(botState.modes[mode].positions || {})
      .filter(([, position]) => Number(position.qty || 0) > 0)
      .map(([symbol, position]) => {
        const watcher = position.lastSwarm || {};
        const quote = botQuoteFor(symbol);
        const price = Number(quote?.price || position.lastMarkPrice || position.avgPrice || 0);
        const entry = Number(position.avgPrice || price);
        return {
          symbol,
          price,
          heldQty: Number(position.qty || 0),
          pnlPct: entry ? ((price - entry) / entry) * 100 : 0,
          openedAt: position.openedAt || 0,
          drawdownFromHighPct: 0,
          feedStale: true,
          staleTickCount: Number(watcher.staleTickCount || 0),
          momZ: Number(watcher.momentumZ ?? position.entryMomentumZ ?? 0),
          moveZ: Number(watcher.moveZ ?? position.entryMoveZ ?? 0),
          shortMomentumPct: Number(watcher.shortMomentumPct || 0),
          signalAction: watcher.signalAction || position.entrySignal || "Hold",
          verdict: { direction: watcher.direction || "neutral", confidence: Number(watcher.confidence || 0) },
          setupType: position.setupType || watcher.setupType || "unknown",
          liveVolPct: 0,
          volatilityPct: 0,
        };
      });
    const held = heldRows.length > 0;
    if (heldRows.length) bot.runModeDecision(heldRows);
    const reason = held
      ? "No fresh swarm samples; existing position remains under risk watch"
      : "No fresh swarm samples; waiting for live price movement";
    const row = { action: "WATCH", blockedBy: "feed-stale", reason };
    logBotDecision(mode, row, { key: `feed-stale:${mode}`, throttleMs: 5000 });
    botAppendRunAudit(mode, row, null);
  }
}
} catch (err) {
enabledBotModeIds().forEach(mode => {
const row = { action: "HOLD", reason: err.message || "bot decision failed" };
logBotDecision(mode, row, { key: "decision-error", throttleMs: 5000 });
botAppendRunAudit(mode, row, null);
});
}
renderBotStatus();
botPersistState();
scheduleBotDecision();
}

window.editWalletBalance = function() {
const newBalance = prompt("Enter new starting balance ($). WARNING: This will reset your portfolio and trade history!", startingBalance);
  if (newBalance !== null && !isNaN(parseFloat(newBalance))) {
    startingBalance = parseFloat(newBalance);
walletCash = startingBalance;
savedPortfolio = [];
tradeHistory = [];
pendingOrders = [];
updateStorage();
    renderWallet();
    renderPortfolio();
    renderHistory();
  }
};

// Removed broken duplicate setActiveButtons

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
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const candidates = [];
  if (window.location.port === "8000") candidates.push("");
  candidates.push(`${protocol}//${host}:8000`, `${protocol}//localhost:8000`, `${protocol}//127.0.0.1:8000`);
  return [...new Set(candidates)];
}

function websocketUrl(path) {
  const url = new URL(apiBase || API_CANDIDATES.find(Boolean) || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
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

async function postToApi(path, body) {
  let lastError;
  for (const candidate of API_CANDIDATES) {
    try {
      const response = await fetch(`${candidate}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `${response.status} ${response.statusText}`);
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

function enhanceInteractiveRows(root, selector) {
  if (!root) return;
  root.querySelectorAll(selector).forEach((row) => {
    if (row.dataset.keyboardReady === "true") return;
    row.dataset.keyboardReady = "true";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      row.click();
    });
  });
}

function renderWatchlist() {
  els.watchlist.classList.remove("loading");
  els.watchlist.innerHTML = quotes
    .filter((quote) => savedWatchlist.includes(quote.symbol))
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
  enhanceInteractiveRows(els.watchlist, ".watch-row");
}

const LOT_COLORS = ["#00ffff", "#ff00ff", "#ffff00", "#ffa500", "#0088ff", "#8a2be2", "#ff1493", "#00fa9a", "#ff6347"];

function renderPortfolio() {
  if (savedPortfolio.length === 0) {
    els.portfolioList.innerHTML = `<div class="empty-state">No positions yet. Buy something!</div>`;
    return;
  }
  
  els.portfolioList.innerHTML = savedPortfolio.map(pos => {
    const q = quotes.find(quote => quote.symbol === pos.symbol);
    const currentPrice = q ? q.price : pos.avgPrice;
    const pnl = (currentPrice - pos.avgPrice) * pos.qty;
    const pnlPercent = ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100;
    
    // determine flash if quote updated
    const prior = previousPrices.get(pos.symbol);
    const flash = prior !== undefined && currentPrice !== prior ? (currentPrice > prior ? "flash-up" : "flash-down") : "";
    
    return `
      <div class="portfolio-item ${pos.symbol === activeSymbol ? "active" : ""} ${flash}" onclick="selectSymbol('${pos.symbol}')">
        <div class="port-row main">
          <strong><span class="lot-dot" style="--lot-color:${pos.color}"></span>${pos.symbol}</strong>
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
  enhanceInteractiveRows(els.portfolioList, ".portfolio-item");
}

function renderHistory() {
  if (!els.historyList) return;
  const filteredHistory = tradeHistory.slice().reverse().slice(0, 50); // limit to last 50 for ui performance
  if (!filteredHistory.length) {
    els.historyList.innerHTML = `<div class="empty-state">No recent history.</div>`;
    if (lwHistorySeries) lwHistorySeries.setData([]);
    return;
  }
  
els.historyList.innerHTML = filteredHistory.map(row => {
const sym = row.symbol;
const isActive = sym === activeSymbol ? "active" : "";
const q = quotes.find(quote => quote.symbol === sym);
const p = q ? Number(q.price) : Number(row.price || 0);
let flash = "";

if (q) {
const prior = previousPrices.get(sym);
flash = prior !== undefined && p !== prior ? (p > prior ? "flash-up" : "flash-down") : "";
}
    
    return `
      <div class="watch-row ${isActive} ${flash}" onclick="selectSymbol('${sym}')">
        <div class="watch-left">
          <strong>${sym}</strong>
        </div>
<div class="watch-right">
<strong>${p !== "--" ? "$" + formatPrice(p) : "--"}</strong>
          <button class="add-btn" onclick="event.stopPropagation(); toggleWatchlist('${sym}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
    `;
}).join("");
enhanceInteractiveRows(els.historyList, ".watch-row");
}

function executeTrade(symbol, side, qty, price, id = null) {
  const timestamp = new Date().toLocaleTimeString();
  const tradeValue = qty * price;
  
if (side === "buy") {
if (walletCash < tradeValue) {
alert("Not enough cash in wallet!");
return false;
}
    walletCash -= tradeValue;
    // Determine the next color based on the number of existing lots for this symbol
    const existingLots = savedPortfolio.filter(p => p.symbol === symbol).length;
    const color = LOT_COLORS[existingLots % LOT_COLORS.length];
    const newId = Date.now().toString() + Math.floor(Math.random() * 1000);
    
    savedPortfolio.push({ id: newId, symbol, qty, avgPrice: price, color });
    tradeHistory.push({ type: "BUY", symbol, qty, price, timestamp });
    if (tradeHistory.length > 500) tradeHistory.splice(0, tradeHistory.length - 500);
} else if (side === "sell") {
    let pnl = 0;
    const totalHeld = heldQuantity(symbol);
    if (totalHeld <= 0 || qty > totalHeld + 0.000001) {
      alert(`Not enough ${symbol} position to sell.`);
      return false;
    }
    let soldQty = 0;
    if (id) {
      const existingIdx = savedPortfolio.findIndex(p => p.id === id);
      if (existingIdx === -1) {
        return false;
      }
      const existing = savedPortfolio[existingIdx];
      const sellQty = Math.min(qty, existing.qty);
      if (sellQty <= 0) {
        return false;
      }
      soldQty = sellQty;
      pnl = (price - existing.avgPrice) * sellQty;
      existing.qty -= sellQty;
      if (existing.qty <= 0) {
        savedPortfolio.splice(existingIdx, 1);
      }
    } else {
      // If no ID provided (e.g. from general sell button without tooltip), sell FIFO from all lots
      let qtyToSell = qty;
      const matchingLots = savedPortfolio.filter(p => p.symbol === symbol);
      for (const lot of matchingLots) {
        if (qtyToSell <= 0) break;
        const sellQty = Math.min(lot.qty, qtyToSell);
        pnl += (price - lot.avgPrice) * sellQty;
        soldQty += sellQty;
        if (lot.qty <= qtyToSell) {
          qtyToSell -= lot.qty;
          savedPortfolio = savedPortfolio.filter(p => p.id !== lot.id);
        } else {
          lot.qty -= qtyToSell;
          qtyToSell = 0;
        }
      }
    }
    if (soldQty <= 0) {
      return false;
    }
    walletCash += soldQty * price;
    tradeHistory.push({ type: "SELL", symbol, qty: soldQty, price, timestamp, pnl });
    if (tradeHistory.length > 500) tradeHistory.splice(0, tradeHistory.length - 500);
  }
  updateStorage();
  renderPortfolio();
  renderHistory();
renderChart(); // Redraw chart to update order markers
renderWallet();
renderTradeTicket();
return true;
}

function renderTicker() {
  els.ticker.innerHTML = quotes
    .map((quote) => {
      const sign = quote.change > 0 ? "+" : "";
      return `<span class="${toneClass(quote.change)}">${quote.symbol} ${formatPrice(quote.price)} ${sign}${(quote.changePercent || 0).toFixed(2)}%</span>`;
    })
    .join("");
}

function renderSignals() {
  const elsSignals = document.getElementById("signals-list");
  if (!elsSignals) return;
  
  const activeSignals = detail?.signals || signals.find((item) => item.symbol === activeSymbol);
  
  if (!activeSignals) {
    elsSignals.innerHTML = `<div class="signal-row neutral"><span>Waiting signal data</span></div>`;
    return;
  }
  
  const dirClass = activeSignals.action === "Buy" ? "positive" : activeSignals.action === "Sell" ? "negative" : "neutral";
  
  elsSignals.innerHTML = `
    <div class="signal-tile ${dirClass}">
      <span>Action</span><strong>${activeSignals.action.toUpperCase()} ${activeSignals.confidence}%</strong>
    </div>
    <div class="signal-row"><span>Target</span><strong>${activeSignals.targetPrice ? formatPrice(activeSignals.targetPrice) : 'N/A'}</strong></div>
    <div class="signal-row"><span>EMA 9 / 21</span><strong>${formatPrice(activeSignals.ema9)} / ${formatPrice(activeSignals.ema21)}</strong></div>
    <div class="signal-row"><span>RSI 14</span><strong>${formatPrice(activeSignals.rsi14)}</strong></div>
    <div class="signal-row"><span>VWAP</span><strong>${formatPrice(activeSignals.vwap)}</strong></div>
    <div class="signal-row"><span>Realized vol</span><strong>${formatPrice(activeSignals.realizedVolatilityPct)}%</strong></div>
  `;
  
  if (els.headerSignal) {
    els.headerSignal.textContent = activeSignals.action.toUpperCase();
    els.headerSignal.className = `signal-badge ${dirClass}`;
    els.headerSignal.style.backgroundColor = "";
    els.headerSignal.style.color = "";
    if (els.headerTarget) els.headerTarget.textContent = activeSignals.targetPrice ? `Target: ${formatPrice(activeSignals.targetPrice)}` : '';
  }
}

function renderPulse() {
  if (!pulse) return;
  const pulseValue = (value, fallback = "--") => value == null || value === "" ? fallback : value;
  els.pulse.innerHTML = `
    <div><span>Up</span><strong>${pulseValue(pulse.advancers)}</strong></div>
    <div><span>Down</span><strong>${pulseValue(pulse.decliners)}</strong></div>
    <div><span>Feeds</span><strong>${pulseValue(pulse.liveFeeds)} LIVE</strong></div>
    <div><span>Notional</span><strong>${pulse.notionalVolume == null ? "--" : formatVolume(pulse.notionalVolume)}</strong></div>
  `;

  const movers = [...quotes].sort((a, b) => Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0)).slice(0, 5);
  els.movers.innerHTML = movers
    .map((quote) => {
      const width = Math.min(100, Math.abs(quote.changePercent || 0) * 14);
      return `
        <div class="mover-row" onclick="selectSymbol('${quote.symbol}')">
          <span class="clickable-ticker">${quote.symbol}</span>
          <div class="mover-bar"><i class="${toneClass(quote.change)}" style="--mover-width:${width}%"></i></div>
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
  enhanceInteractiveRows(els.movers, ".mover-row");
  enhanceInteractiveRows(els.alerts, ".clickable-ticker");
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
  renderSignals();
  renderTradeTicket();
  processPendingOrders();
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
    processPendingOrders();
    scheduleFocusRender();
  } else {
    processPendingOrders();
    renderChart();
  }
}

function renderChart() {
  const container = els.chart;
  if (!lwChart) {
    container.innerHTML = "";
    lwChart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 900,
      height: container.clientHeight || 430,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#9aa697',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: '#26332b' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
    });
    
    lwSeries = lwChart.addCandlestickSeries({
      upColor: '#2eff88',
      downColor: '#ff4c56',
      borderVisible: false,
      wickUpColor: '#2eff88',
      wickDownColor: '#ff4c56'
    });
    
    lwLineSeries = lwChart.addLineSeries({
      color: 'cyan',
      lineWidth: 2,
    });

    lwEma9 = lwChart.addLineSeries({
      color: '#f9a826', // Orange
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      visible: emaVisible,
    });

    lwEma21 = lwChart.addLineSeries({
      color: '#00b4d8', // Electric Blue
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      visible: emaVisible,
    });

    lwVolumeSeries = lwChart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    lwChart.priceScale('').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
  }

  // Ensure resizing works
  lwChart.applyOptions({ width: container.clientWidth || 900, height: container.clientHeight || 450 });

  if (chartCandles.length === 0) {
     return;
  }

  // Format data for Lightweight Charts (requires time in seconds)
  const tzOffset = new Date().getTimezoneOffset();
  const lwData = chartCandles.map(c => {
    let t = c.timestamp;
    if (!t && c.time) t = toTimestamp(c.time);
    return {
      time: Math.floor(t / 1000) - (tzOffset * 60),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      value: c.close, // for line series
      volume: c.volume || 0 // for volume
    };
  });

  // Remove duplicates by time (Lightweight charts requires unique ascending times)
  const uniqueData = [];
  const seenTimes = new Set();
  for (const item of lwData) {
     if (!seenTimes.has(item.time) && !Number.isNaN(item.time)) {
         seenTimes.add(item.time);
         uniqueData.push(item);
     }
  }
  
  uniqueData.sort((a, b) => a.time - b.time);

  if (uniqueData.length === 0) {
      console.error("CRITICAL: uniqueData is empty despite chartCandles length:", chartCandles.length);
  }

  // Extract Volume Data
  const volumeData = uniqueData.map(d => ({
    time: d.time,
    value: d.volume,
    color: d.close >= d.open ? 'rgba(46, 255, 136, 0.4)' : 'rgba(255, 76, 86, 0.4)'
  }));

  // Calculate EMA helper
  const calculateEMA = (data, period) => {
    if (data.length < period) return [];
    let emaData = [];
    let k = 2 / (period + 1);
    
    // Simple moving average for the first point
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i].close;
    let ema = sum / period;
    
    // Fill initial nulls
    for (let i = 0; i < period - 1; i++) {
        // Option to just not plot, but we must align times. 
        // We will just not include them in the array, lightweight charts handles missing data gaps gracefully.
    }
    emaData.push({ time: data[period - 1].time, value: ema });
    
    // Calculate exponential moving average for the rest
    for (let i = period; i < data.length; i++) {
        ema = (data[i].close * k) + (ema * (1 - k));
        emaData.push({ time: data[i].time, value: ema });
    }
    return emaData;
  };

  const ema9Data = calculateEMA(uniqueData, 9);
  const ema21Data = calculateEMA(uniqueData, 21);

  // Clear existing price lines
  if (lwSeries.priceLines) {
     lwSeries.priceLines.forEach(pl => lwSeries.removePriceLine(pl));
  }
  lwSeries.priceLines = [];
  
  if (lwLineSeries.priceLines) {
     lwLineSeries.priceLines.forEach(pl => lwLineSeries.removePriceLine(pl));
  }
  lwLineSeries.priceLines = [];

  const activeSeries = chartMode === "line" ? lwLineSeries : lwSeries;
  const inactiveSeries = chartMode === "line" ? lwSeries : lwLineSeries;
  
  inactiveSeries.setData([]);
  activeSeries.setData(uniqueData);
  if (lwVolumeSeries) lwVolumeSeries.setData(volumeData);
  if (lwEma9) lwEma9.setData(ema9Data);
  if (lwEma21) lwEma21.setData(ema21Data);

  const existingLots = savedPortfolio.filter(p => p.symbol === activeSymbol);
  existingLots.forEach(lot => {
     const pl = activeSeries.createPriceLine({
         price: lot.avgPrice,
         color: lot.color || 'cyan',
         lineWidth: 2,
         lineStyle: LightweightCharts.LineStyle.Dashed,
         axisLabelVisible: true,
         title: `${lot.qty} @ ${lot.avgPrice}`
     });
     activeSeries.priceLines.push(pl);
  });

  const activePendingOrders = pendingOrders.filter(order => order.symbol === activeSymbol);
  activePendingOrders.forEach(order => {
     const pl = activeSeries.createPriceLine({
        price: order.triggerPrice,
        color: order.side === "buy" ? '#22c55e' : '#ef4444',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${order.side.toUpperCase()} trigger ${order.direction === "above" ? ">=" : "<="}`,
     });
     activeSeries.priceLines.push(pl);
  });
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
    const maxSize = Math.max(...rows.map(r => r.size || 0), 10);
    rows.slice(0, 10).forEach((row) => {
      const sizePct = Math.min(100, Math.max(5, (row.size / maxSize) * 100));
      const div = document.createElement("div");
      div.className = `book-row ${className}`;
      div.innerHTML = `<div class="book-row-bg" style="--depth-width:${sizePct}%"></div><span>${formatPrice(row.price)}</span><span>${formatPrice(row.size)}</span><small>${row.orders || ""}</small>`;
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
  if (deskLoadInFlight) return;
  deskLoadInFlight = true;
  try {
  let symbols = [];
  if (activeTab === "watchlist") symbols = savedWatchlist;
  else if (activeTab === "portfolio") symbols = Array.from(new Set(savedPortfolio.map(p => p.symbol)));
  else if (activeTab === "history") symbols = savedHistory;
  if (botState.running || botConfig.universeMode === "crypto") {
    symbols = Array.from(new Set([...symbols, ...botUniverseSymbols()]));
  }
  
  if (!symbols.length) {
    quotes = [];
    if (activeTab === "watchlist") renderWatchlist();
    else if (activeTab === "portfolio") renderPortfolio();
    else if (activeTab === "history") renderHistory();
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
  else if (activeTab === "history") renderHistory();
  
  renderTicker();
  renderPulse();
  renderSignals();
  renderWallet();
  renderTradeTicket();
  processPendingOrders();
  } finally {
    deskLoadInFlight = false;
  }
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
        tickerBadge = `<span class="news-ticker-badge" onclick="selectSymbol('${item.ticker}')">${item.ticker} <span class="${changeClass}">${changeStr}</span></span>`;
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
    enhanceInteractiveRows(list, ".news-ticker-badge");
  } catch (err) {
    console.error("News error", err);
  }
}

async function refreshAll() {
  let hadError = false;
  const showDeskError = (error) => {
    const message = error?.message || "Backend unavailable";
    const target = activeTab === "watchlist" ? els.watchlist : activeTab === "portfolio" ? els.portfolioList : els.historyList;
    if (target) {
      target.classList.remove("loading");
      target.innerHTML = `<div class="empty-state"><strong>Market data unavailable</strong><span>${message}</span><button type="button" onclick="refreshAll()">Try again</button></div>`;
    }
    hadError = true;
    setStatus(`Backend unavailable: ${message}`, "error");
  };
  try {
    try { await loadDesk(); } catch (e) { console.error("loadDesk failed", e); showDeskError(e); }
    try { await loadDetail(activeSymbol); } catch (e) { hadError = true; console.error("loadDetail failed", e); }
    try { await loadCandles(); } catch (e) { hadError = true; console.error("loadCandles failed", e); }
    try { await loadFlow(activeSymbol); } catch (e) { hadError = true; console.error("loadFlow failed", e); }
    try { await loadNews(); } catch (e) { hadError = true; console.error("loadNews failed", e); }
    if (!hadError) setStatus(`API ${apiBase || "same-origin"} ${new Date().toLocaleTimeString([], { hour12: false })}`, "ok");
  } catch (error) {
    setStatus(`Backend unavailable: ${error.message}`, "error");
  }
}


function applyQuoteToDOM(quote) {
  if (!quote || !quote.symbol) return;
  const existingQuoteIdx = quotes.findIndex(q => q.symbol === quote.symbol);
  if (existingQuoteIdx > -1) {
    quotes[existingQuoteIdx] = { symbol: quote.symbol, price: quote.price, change: quote.change, changePercent: quote.changePercent };
  } else {
    quotes.push({ symbol: quote.symbol, price: quote.price, change: quote.change, changePercent: quote.changePercent });
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
    try {
      const tick = JSON.parse(event.data);
      
      // Handle L2 Order Book updates
      if (tick.type === "l2update" || tick.type === "snapshot") {
         if (!window.activeOrderBook) window.activeOrderBook = { bids: [], asks: [] };
         if (tick.bids) window.activeOrderBook.bids = tick.bids;
         if (tick.asks) window.activeOrderBook.asks = tick.asks;
         return;
      }
      
      applyTickToCandle(tick);
      setStatus(`STREAM ${symbol} ${shortTime(tick.time || tick.fetchedAt)}`, "ok");
    } catch (e) {
      console.error("Stream parse error", e);
    }
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
  
  if (els.btnToggleEma) {
    els.btnToggleEma.addEventListener("click", () => {
      emaVisible = !emaVisible;
      els.btnToggleEma.classList.toggle("active", emaVisible);
      els.btnToggleEma.textContent = emaVisible ? "EMA On" : "EMA Off";
      if (lwEma9) lwEma9.applyOptions({ visible: emaVisible });
      if (lwEma21) lwEma21.applyOptions({ visible: emaVisible });
    });
  }

  els.railTabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      setActiveButtons(els.railTabs, "tab", activeTab);
      
      els.watchlist.classList.add("hidden");
      if (els.historyTab) els.historyTab.classList.add("hidden");
      els.portfolioList.classList.add("hidden");
      
      const target = activeTab === "watchlist" ? els.watchlist : activeTab === "portfolio" ? els.portfolioList : els.historyTab;
      if (target) {
        target.classList.remove("hidden", "fade-in");
        void target.offsetWidth; // force reflow for animation
        target.classList.add("fade-in");
      }
      
      if (activeTab === "watchlist") {
        renderWatchlist();
      } else if (activeTab === "portfolio") {
        renderPortfolio();
      } else if (activeTab === "history") {
        renderHistory();
      }
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

  // Trade Modal Listeners
  let currentTradeSide = "buy";

  function updateOrderTotal() {
    const q = quotes.find(quote => quote.symbol === activeSymbol);
    const price = q ? q.price : (detail ? (detail.lastTradePrice || detail.regularMarketPrice) : 0);
    const qty = parseFloat(els.orderQty.value) || 0;
    els.orderTotal.textContent = `$${formatPrice(price * qty)}`;
  }

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
    updateOrderTotal();
  }

  function focusTradeTicket(side) {
    activeTicketSide = side;
    renderTradeTicket();
    els.ticketSize?.focus();
    els.ticketSize?.select();
  }

els.btnBuy.addEventListener("click", () => focusTradeTicket("buy"));
els.btnSell.addEventListener("click", () => focusTradeTicket("sell"));

function openBotPage() {
  hydrateBotForm();
  updateFeesLabel();
  updateMultiplierLabel();
  renderBotStatus();
  renderBotLog();
  document.querySelector(".desk-shell")?.classList.add("hidden");
  els.botModal?.classList.remove("hidden");
  document.documentElement.classList.add("bot-workspace-open");
  document.body.classList.add("bot-workspace-open");
}

function closeBotPage() {
  if (!botState.running) readBotConfig();
  els.botModal?.classList.add("hidden");
  document.querySelector(".desk-shell")?.classList.remove("hidden");
  document.documentElement.classList.remove("bot-workspace-open");
  document.body.classList.remove("bot-workspace-open");
}

els.btnBot?.addEventListener("click", () => {
  openBotPage();
});
els.botClose?.addEventListener("click", closeBotPage);
els.botHome?.addEventListener("click", closeBotPage);
els.botStart?.addEventListener("click", startBot);
  els.botStop?.addEventListener("click", () => stopBot("stopped by user"));
els.botClearLog?.addEventListener("click", () => {
  botModeIds().forEach(mode => {
    botState.modes[mode].logs = [];
    renderBotLog(mode);
  });
  botPersistState();
  appendTerminalLine("[BOT] audit logs cleared", "ok");
});
document.querySelector("#polymarket-clear-audit")?.addEventListener("click", clearPolymarketAudit);
document.querySelector("#polymarket-reset")?.addEventListener("click", () => {
  resetBots();
  appendTerminalLine("[BOT] Polymarket paper state reset", "ok");
});
[els.botUniverseMode, document.querySelector("#bot-duration"), document.querySelector("#bot-observe"), document.querySelector("#bot-strategy-mode"), document.querySelector("#polymarket-interval"), ...botModeIds().flatMap(mode => [document.querySelector(`#polymarket-capital-${mode}`), document.querySelector(`#polymarket-enabled-${mode}`), document.querySelector(`#bot-enabled-${mode}`)]), ...botModeIds().map(mode => botInputFor(mode))].forEach(input => {
  input?.addEventListener("change", () => {
    if (!botState.running) {
      readBotConfig();
      syncBotEnableInputs();
      loadDesk();
    }
    renderBotStatus();
  });
});
els.botReset?.addEventListener("click", () => {
  resetBots();
  appendTerminalLine("[BOT] bots reset", "ok");
});
document.querySelectorAll(".bot-view-switch [data-view]").forEach(button => {
  button.addEventListener("click", () => {
    if (botState.running) return;
    const strategy = document.querySelector("#bot-strategy-mode");
    if (!strategy) return;
    strategy.value = button.dataset.view === "polymarket" ? "polymarket" : "swarm";
    strategy.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
});

function updateFeesLabel() {
  const toggle = document.querySelector("#bot-fees-enabled");
  const label = document.querySelector("#bot-fees-label");
  if (!toggle || !label) return;
  label.textContent = toggle.checked ? "On" : "Off";
  label.className = toggle.checked ? "on" : "off";
}
document.querySelector("#bot-fees-enabled")?.addEventListener("change", () => {
  updateFeesLabel();
  if (!botState.running) {
    readBotConfig();
    loadDesk();
  }
  appendTerminalLine("[BOT] trading fees " + (botConfig.feesEnabled ? "enabled" : "disabled") + " (fee-edge gate " + (botConfig.feesEnabled ? "active" : "bypassed") + ")", "ok");
  renderBotStatus();
});
function updateMultiplierLabel() {
  const toggle = document.querySelector("#bot-multiplier-enabled");
  const label = document.querySelector("#bot-multiplier-label");
  if (!toggle || !label) return;
  label.textContent = toggle.checked ? "On" : "Off";
  label.className = toggle.checked ? "on" : "off";
}
document.querySelector("#bot-multiplier-enabled")?.addEventListener("change", () => {
  updateMultiplierLabel();
  if (!botState.running) {
    readBotConfig();
    loadDesk();
  }
  appendTerminalLine("[BOT] free-hand momentum " + (botConfig.multiplierEnabled ? "enabled" : "disabled") + " (adaptive cash allocation; no fixed target; paper only)", botConfig.multiplierEnabled ? "warn" : "ok");
  renderBotStatus();
});
els.botModal?.addEventListener("click", (event) => {
  const expand = event.target.closest?.(".swarm-expand");
  if (expand && els.botModal.contains(expand)) {
    const cot = expand.closest(".swarm-card")?.querySelector(".swarm-cot");
    if (cot) {
      const open = !cot.classList.toggle("hidden");
      expand.textContent = open ? "⌃" : "⌄";
    }
    return;
  }
  const tab = event.target.closest?.("[data-tab]");
  if (!tab || !els.botModal.contains(tab)) return;
  const card = tab.closest("[data-bot-mode]");
  if (!card) return;
  card.querySelectorAll(".bot-tabs [data-tab]").forEach(btn => btn.classList.toggle("active", btn === tab));
  card.querySelectorAll(".bot-tab-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab));
});

setInterval(() => {
  if (els.botModal && !els.botModal.classList.contains("hidden")) {
    updateBotClock();
    botTimelineSeg();
  }
}, 1000);
els.ticketBuy?.addEventListener("click", () => focusTradeTicket("buy"));
  els.ticketSell?.addEventListener("click", () => focusTradeTicket("sell"));

  els.ticketModeAmount?.addEventListener("click", () => {
    ticketSizeMode = "amount";
    renderTradeTicket();
  });
  els.ticketModeShares?.addEventListener("click", () => {
    ticketSizeMode = "shares";
    renderTradeTicket();
  });

  els.ticketMarket?.addEventListener("click", () => {
    ticketOrderType = "market";
    renderTradeTicket();
  });
  els.ticketTrigger?.addEventListener("click", () => {
    ticketOrderType = "trigger";
    const price = activeMarketPrice();
    if (els.ticketTriggerPrice && !els.ticketTriggerPrice.value && price) {
      els.ticketTriggerPrice.value = price.toFixed(price >= 100 ? 2 : 4);
    }
    renderTradeTicket();
    els.ticketTriggerPrice?.focus();
    els.ticketTriggerPrice?.select();
  });

  els.ticketSize?.addEventListener("input", renderTradeTicket);
  els.ticketTriggerPrice?.addEventListener("input", renderTradeTicket);
  els.ticketSubmit?.addEventListener("click", placeTicketOrder);
  [els.ticketSize, els.ticketTriggerPrice].forEach(input => {
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") placeTicketOrder();
    });
  });

  els.orderQty.addEventListener("input", updateOrderTotal);
  els.modalPrice.addEventListener("input", updateOrderTotal);

  if (els.lightningBuy) {
    els.lightningBuy.addEventListener("click", () => {
      const q = quotes.find(q => q.symbol === activeSymbol);
      const price = q ? q.price : (detail ? (detail.lastTradePrice || detail.regularMarketPrice) : 0);
      if (!price) return;
      const qty = Math.floor((walletCash * 0.1) / price) || 1; // 10% of wallet or 1 share
      executeTrade(activeSymbol, "buy", qty, price);
    });
  }

  if (els.lightningSell) {
    els.lightningSell.addEventListener("click", () => {
      const q = quotes.find(q => q.symbol === activeSymbol);
      const price = q ? q.price : (detail ? (detail.lastTradePrice || detail.regularMarketPrice) : 0);
      if (!price) return;
      const qty = Math.floor((walletCash * 0.1) / price) || 1; // 10% of wallet or 1 share
      executeTrade(activeSymbol, "sell", qty, price);
    });
  }

  if (els.lightningFlatten) {
    els.lightningFlatten.addEventListener("click", () => {
      const q = quotes.find(q => q.symbol === activeSymbol);
      const price = q ? q.price : (detail ? (detail.lastTradePrice || detail.regularMarketPrice) : 0);
      if (!price) return;
      
      const existingLots = savedPortfolio.filter(p => p.symbol === activeSymbol);
      existingLots.forEach(lot => {
         executeTrade(activeSymbol, "sell", lot.qty, price, lot.id);
      });
    });
  }

  els.modalClose.addEventListener("click", () => {
    els.orderModal.classList.add("hidden");
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
  refreshTimer = setInterval(() => { loadDesk().catch(e => console.error("loadDesk failed", e)); }, DESK_INTERVAL_MS);
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
  enhanceInteractiveRows(searchDropdown, ".search-item");
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
if ("ResizeObserver" in window && els.chart) {
  const chartResizeObserver = new ResizeObserver(() => renderChart());
  chartResizeObserver.observe(els.chart);
}


document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    els.command.focus();
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

function appendTerminalLine(text, tone = "") {
  if (!els.terminalOutput) return;
  const line = document.createElement("div");
  line.className = `terminal-line ${tone}`.trim();
  line.textContent = text;
  els.terminalOutput.appendChild(line);
  while (els.terminalOutput.children.length > TERMINAL_MAX_LINES) {
    els.terminalOutput.removeChild(els.terminalOutput.firstChild);
  }
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
}

function rememberTerminalCommand(cmdStr) {
  if (!cmdStr || terminalHistory[terminalHistory.length - 1] === cmdStr) {
    terminalHistoryIndex = terminalHistory.length;
    return;
  }
  terminalHistory.push(cmdStr);
  terminalHistory = terminalHistory.slice(-50);
  localStorage.setItem(TERMINAL_HISTORY_KEY, JSON.stringify(terminalHistory));
  terminalHistoryIndex = terminalHistory.length;
}

function terminalHelpText() {
  return [
    "/help",
    "/quote SYMBOL",
    "/chart SYMBOL [1m|5m|15m|1h|6h|1d]",
    "/watch add|remove|list [SYMBOL]",
    "/buy QTY [SYMBOL]",
    "/sell QTY [SYMBOL]",
    "/flatten [SYMBOL]",
    "/portfolio",
    "/cash AMOUNT",
    "/sync",
    "/clear"
  ].join(" | ");
}

async function focusTerminalSymbol(symbol) {
  const upperSym = symbolAlias(symbol).toUpperCase();
  await fetchFromApi(`/api/quotes/${encodeURIComponent(upperSym)}`);
  addToHistory(upperSym);
  await selectSymbol(upperSym);
  return upperSym;
}

function currentTerminalPrice(symbol = activeSymbol) {
  const quote = quotes.find(q => q.symbol === symbol);
  return quote ? quote.price : (detail ? (detail.lastTradePrice || detail.regularMarketPrice) : 0);
}

async function runTerminalCommand(cmdStr) {
  const parts = cmdStr.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  appendTerminalLine(`> ${cmdStr}`, "command");

  try {
    if (cmd === "/help") {
      appendTerminalLine(terminalHelpText(), "ok");
      return;
    }

    if (cmd === "/quote" || cmd === "/q") {
      const sym = parts[1] || activeSymbol;
      if (!sym) {
        appendTerminalLine("Usage: /quote SYMBOL", "warn");
        return;
      }
      const upperSym = await focusTerminalSymbol(sym);
      const price = currentTerminalPrice(upperSym);
      appendTerminalLine(`${upperSym} ${price ? "$" + formatPrice(price) : "selected"}`, "ok");
      return;
    }

    if (cmd === "/chart" || cmd === "/c") {
      const sym = parts[1];
      const intv = parts[2];
      if (sym) await focusTerminalSymbol(sym);
      if (intv && INTERVAL_SECONDS[intv]) {
        activeInterval = intv;
        setActiveButtons(els.timeframeControls, "interval", activeInterval);
        await refreshAll();
      }
      appendTerminalLine(`Chart ${activeSymbol || "--"} ${activeInterval}`, "ok");
      return;
    }

    if (cmd === "/watch") {
      const action = (parts[1] || "list").toLowerCase();
      const sym = parts[2] ? symbolAlias(parts[2]).toUpperCase() : activeSymbol;
      if (action === "list") {
        appendTerminalLine(savedWatchlist.join(", ") || "Watchlist is empty.", "ok");
        return;
      }
      if (!sym) {
        appendTerminalLine("Usage: /watch add|remove SYMBOL", "warn");
        return;
      }
      if (action === "add") {
        if (!savedWatchlist.includes(sym)) savedWatchlist.push(sym);
        updateStorage();
        await loadDesk();
        appendTerminalLine(`Added ${sym} to watchlist '${activeWatchlistName}'.`, "ok");
        return;
      }
      if (action === "remove") {
        savedWatchlist = savedWatchlist.filter(item => item !== sym);
        updateStorage();
        await loadDesk();
        appendTerminalLine(`Removed ${sym} from watchlist '${activeWatchlistName}'.`, "ok");
        return;
      }
      appendTerminalLine("Usage: /watch add|remove|list [SYMBOL]", "warn");
      return;
    }

    if (cmd === "/buy" || cmd === "/sell") {
      const qty = Number(parts[1]);
      const sym = parts[2] ? await focusTerminalSymbol(parts[2]) : activeSymbol;
      if (!sym || !Number.isFinite(qty) || qty <= 0) {
        appendTerminalLine(`Usage: ${cmd} QTY [SYMBOL]`, "warn");
        return;
      }
      const price = currentTerminalPrice(sym);
      if (!price) {
        appendTerminalLine(`No live price for ${sym}.`, "error");
        return;
      }
      const ok = executeTrade(sym, cmd === "/buy" ? "buy" : "sell", qty, price);
      if (ok) appendTerminalLine(`${cmd.slice(1).toUpperCase()} ${qty} ${sym} @ $${formatPrice(price)}`, "ok");
      return;
    }

    if (cmd === "/flatten") {
      const sym = parts[1] ? await focusTerminalSymbol(parts[1]) : activeSymbol;
      const price = currentTerminalPrice(sym);
      const lots = savedPortfolio.filter(pos => pos.symbol === sym);
      if (!sym || !price || lots.length === 0) {
        appendTerminalLine(`No open ${sym || "symbol"} position to flatten.`, "warn");
        return;
      }
      lots.forEach(lot => executeTrade(sym, "sell", lot.qty, price, lot.id));
      appendTerminalLine(`Flattened ${sym} @ $${formatPrice(price)}`, "ok");
      return;
    }

    if (cmd === "/portfolio") {
      if (!savedPortfolio.length) {
        appendTerminalLine(`Cash $${formatPrice(walletCash)} | no open positions`, "ok");
        return;
      }
      const positions = savedPortfolio.map(pos => `${pos.symbol} ${pos.qty} @ $${formatPrice(pos.avgPrice)}`).join(" | ");
      appendTerminalLine(`Cash $${formatPrice(walletCash)} | ${positions}`, "ok");
      return;
    }

    if (cmd === "/cash") {
      const amount = Number(parts[1]);
      if (!Number.isFinite(amount) || amount < 0) {
        appendTerminalLine("Usage: /cash AMOUNT", "warn");
        return;
      }
      walletCash = amount;
      updateStorage();
      renderWallet();
      appendTerminalLine(`Cash set to $${formatPrice(walletCash)}.`, "ok");
      return;
    }

    if (cmd === "/sync") {
      await loadDesk();
      if (activeSymbol) await refreshAll();
      appendTerminalLine("Desk synced.", "ok");
      return;
    }

    if (cmd === "/clear") {
      if (els.terminalOutput) els.terminalOutput.innerHTML = "";
      appendTerminalLine("Terminal cleared.", "ok");
      return;
    }

    appendTerminalLine(`Unknown command: ${cmd}. Type /help.`, "warn");
  } catch (err) {
    appendTerminalLine(err.message || "Command failed.", "error");
    setStatus(err.message || "Command failed", "error");
  }
}

async function handleCommand(cmdStr) {
  await runTerminalCommand(cmdStr);
}

els.command.addEventListener("keydown", async (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!searchDropdown.classList.contains("hidden") && searchSelectedIndex < searchResults.length - 1) {
      searchSelectedIndex++;
      updateSearchSelection();
    } else if (searchDropdown.classList.contains("hidden") && terminalHistory.length) {
      terminalHistoryIndex = Math.min(terminalHistory.length, terminalHistoryIndex + 1);
      els.command.value = terminalHistory[terminalHistoryIndex] || "";
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!searchDropdown.classList.contains("hidden") && searchSelectedIndex > 0) {
      searchSelectedIndex--;
      updateSearchSelection();
    } else if (searchDropdown.classList.contains("hidden") && terminalHistory.length) {
      terminalHistoryIndex = Math.max(0, terminalHistoryIndex - 1);
      els.command.value = terminalHistory[terminalHistoryIndex] || "";
      requestAnimationFrame(() => els.command.setSelectionRange(els.command.value.length, els.command.value.length));
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
      rememberTerminalCommand(requested);
      await handleCommand(requested);
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

if (els.terminalClear) {
  els.terminalClear.addEventListener("click", () => {
    if (els.terminalOutput) els.terminalOutput.innerHTML = "";
    appendTerminalLine("Terminal cleared.", "ok");
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
  event.preventDefault();
  els.command.focus();
});

// --- Watchlist Manager ---
function updateWatchlistUI() {
  const customNames = Object.keys(watchlists);
  const globalMarkets = getMarketWatchlists();
  const globalNames = Object.keys(globalMarkets);
  
  if (els.watchlistSelector) {
    els.watchlistSelector.innerHTML = '';
    
    const customGroup = document.createElement("optgroup");
    customGroup.label = "My Watchlists";
    for (const name of customNames) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      customGroup.appendChild(option);
    }
    els.watchlistSelector.appendChild(customGroup);
    
    const globalGroup = document.createElement("optgroup");
    globalGroup.label = "Global Markets";
    for (const name of globalNames) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      globalGroup.appendChild(option);
    }
    els.watchlistSelector.appendChild(globalGroup);
    
    els.watchlistSelector.value = activeWatchlistName;
  }
  
  if (els.botUniverseMode) {
    const currentVal = els.botUniverseMode.value;
    els.botUniverseMode.innerHTML = '';
    
    const customGroup = document.createElement("optgroup");
    customGroup.label = "My Watchlists";
    for (const name of customNames) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      customGroup.appendChild(option);
    }
    els.botUniverseMode.appendChild(customGroup);
    
    const globalGroup = document.createElement("optgroup");
    globalGroup.label = "Global Markets";
    for (const name of globalNames) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      globalGroup.appendChild(option);
    }
    els.botUniverseMode.appendChild(globalGroup);
    
    const otherGroup = document.createElement("optgroup");
    otherGroup.label = "Other";
    const cryptoOpt = document.createElement("option");
    cryptoOpt.value = "crypto";
    cryptoOpt.textContent = "Crypto only";
    otherGroup.appendChild(cryptoOpt);
    els.botUniverseMode.appendChild(otherGroup);
    
    if (currentVal && Array.from(els.botUniverseMode.options).some(o => o.value === currentVal)) {
       els.botUniverseMode.value = currentVal;
    } else {
       els.botUniverseMode.value = activeWatchlistName;
    }
  }
}

function switchWatchlist(name) {
  const globalMarkets = getMarketWatchlists();
  activeWatchlistName = name;
  if (globalMarkets[name]) {
    // Treat global watchlists as read-only presets but we copy them over if missing?
    // Actually, just set savedWatchlist to the global symbols
    savedWatchlist = [...globalMarkets[name]];
  } else {
    savedWatchlist = watchlists[name] || [];
  }
  updateWatchlistUI();
  updateStorage();
  renderWatchlist();
  if (activeTab === "watchlist") loadDesk();
}

if (els.watchlistSelector) {
  els.watchlistSelector.addEventListener("change", (e) => {
    switchWatchlist(e.target.value);
  });
}

if (els.watchlistAdd) {
  els.watchlistAdd.addEventListener("click", () => {
    const name = prompt("Enter new watchlist name:");
    if (name && name.trim()) {
      const cleanName = name.trim();
      if (!watchlists[cleanName]) {
        watchlists[cleanName] = [];
        switchWatchlist(cleanName);
      } else {
        alert("Watchlist already exists!");
      }
    }
  });
}

if (els.watchlistRename) {
  els.watchlistRename.addEventListener("click", () => {
    if (getMarketWatchlists()[activeWatchlistName]) {
      alert("Cannot rename global market watchlists.");
      return;
    }
    const newName = prompt("Enter new name for " + activeWatchlistName + ":", activeWatchlistName);
    if (newName && newName.trim() && newName.trim() !== activeWatchlistName) {
      const cleanName = newName.trim();
      if (!watchlists[cleanName]) {
        watchlists[cleanName] = watchlists[activeWatchlistName];
        delete watchlists[activeWatchlistName];
        switchWatchlist(cleanName);
      } else {
        alert("Watchlist with that name already exists!");
      }
    }
  });
}

if (els.watchlistDelete) {
  els.watchlistDelete.addEventListener("click", () => {
    if (getMarketWatchlists()[activeWatchlistName]) {
      alert("Cannot delete global market watchlists.");
      return;
    }
    if (Object.keys(watchlists).length <= 1) {
      alert("Cannot delete your only custom watchlist.");
      return;
    }
    if (confirm("Delete watchlist '" + activeWatchlistName + "'?")) {
      delete watchlists[activeWatchlistName];
      switchWatchlist(Object.keys(watchlists)[0]);
    }
  });
}

updateWatchlistUI();

bindControls();
hydrateBotForm();
renderBotStatus();
renderBotLog();
connectStream(activeSymbol);
refreshAll();
startTimers();


// Explicit Window Exports for OOP Bots
window.BOT_STALE_TICK_LIMIT = BOT_STALE_TICK_LIMIT;
window.BOT_MIN_SWARM_SAMPLES = 5;
window.renderBotStatus = renderBotStatus;
window.botPortfolioSnapshot = botPortfolioSnapshot;
window.botHeldQuantity = botHeldQuantity;
window.executeBotSell = executeBotSell;
window.executeBotBuy = executeBotBuy;
window.logBotDecision = logBotDecision;
window.botCapital = botCapital;
window.botAverageEntry = botAverageEntry;
window.botSignalFor = botSignalFor;
window.botAppendRunAudit = botAppendRunAudit;
window.botHistoryStats = botHistoryStats;
window.botMarketAgreement = botMarketAgreement;
window.clamp = clamp;
window.rememberBotPrice = rememberBotPrice;
window.botRunTiming = botRunTiming;
