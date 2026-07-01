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
  { name: "Crypto 24/7", tz: "UTC", open: "00:00", close: "23:59", symbols: ["BTC-USD", "ETH-USD", "SOL-USD"] }
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
    return Array.isArray(data) ? data : [];
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
  signals: document.querySelector("#signal-list"),
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
  botLog: document.querySelector("#bot-log"),
  botClearLog: document.querySelector("#bot-clear-log"),
  botReset: document.querySelector("#bot-reset"),
  botUniverseMode: document.querySelector("#bot-universe-mode"),
  botHome: document.querySelector("#bot-home"),
  botCapital: document.querySelector("#bot-capital"),
  botUniverse: document.querySelector("#bot-universe"),
  botValue: document.querySelector("#bot-value"),
  botPnl: document.querySelector("#bot-pnl"),
  botDeployed: document.querySelector("#bot-deployed"),
  botCashRoom: document.querySelector("#bot-cash-room"),
  botRealized: document.querySelector("#bot-realized"),
  botDecisions: document.querySelector("#bot-decisions"),
  botRankings: document.querySelector("#bot-rankings"),
  botPositions: document.querySelector("#bot-positions"),
  botTrades: document.querySelector("#bot-trades"),
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
const BOT_MIN_TRADE_NOTIONAL = 10;  // $10 minimum trade
const BOT_TICK_MS = 500;
const BOT_FEE_RATE = 0.001; // 0.1% per side (maker/taker average)
const BOT_STALE_TICK_LIMIT = 20; // Skip symbols with no price change for 20+ ticks
const BOT_FULLY_DEPLOYED_LOG_MS = 10000;
const BOT_RUN_HISTORY_LIMIT = 20;
const BOT_RUN_AUDIT_LIMIT = 12000;
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
  universeMode: "watchlist",
  modes: Object.fromEntries(Object.entries(BOT_MODES).map(([mode, def]) => [mode, { capital: def.capital }])),
};
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
    return { ...defaultBotConfig, ...(stored || {}), modes: { ...defaultBotConfig.modes, ...((stored && stored.modes) || {}) } };
  } catch (e) {
    return { ...defaultBotConfig };
  }
})();
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
let botRuns = (() => {
try {
const stored = JSON.parse(localStorage.getItem(BOT_RUNS_KEY));
return Array.isArray(stored) ? stored : [];
} catch (e) {
return [];
}
})();
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
  const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
  
  els.posTracker.innerHTML = `<span>${totalQty.toFixed(2)} @ $${avgEntry.toFixed(2)}</span> | P&L: <span style="color: ${pnlColor}">$${pnl.toFixed(2)}</span>`;
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

function botModeEl(mode, name) {
  return document.querySelector(`#bot-${name}-${mode}`);
}

function botInputFor(mode) {
  return document.querySelector(`#bot-capital-${mode}`);
}

function readBotConfig() {
  const duration = Number(document.querySelector("#bot-duration")?.value);
  const universeMode = els.botUniverseMode?.value || "crypto";
  const modes = {};
  botModeIds().forEach(mode => {
    const input = botInputFor(mode);
    const capital = Number(input?.value);
    modes[mode] = { capital: Number.isFinite(capital) ? Math.max(0, capital) : BOT_MODES[mode].capital };
  });
  botConfig = {
    durationMin: Number.isFinite(duration) ? clamp(Math.max(1, duration), 1, 1440) : defaultBotConfig.durationMin,
    universeMode,
    modes,
  };
  localStorage.setItem(BOT_CONFIG_KEY, JSON.stringify(botConfig));
  return botConfig;
}

function hydrateBotForm() {
const duration = document.querySelector("#bot-duration");
if (duration) duration.value = botConfig.durationMin || defaultBotConfig.durationMin;
if (els.botUniverseMode) {
  // Ensure the option exists before setting it, handled mostly in updateWatchlistUI, but safe to assign
  els.botUniverseMode.value = botConfig.universeMode || "crypto";
}
botModeIds().forEach(mode => {
const input = botInputFor(mode);
if (input) input.value = botConfig.modes?.[mode]?.capital ?? BOT_MODES[mode].capital;
});
}

function botPersistRuns() {
  localStorage.setItem(BOT_RUNS_KEY, JSON.stringify(botRuns.slice(0, BOT_RUN_HISTORY_LIMIT)));
}

function botPersistRunFile(run) {
  const payload = JSON.parse(JSON.stringify(run));
  postToApi("/api/bot-runs", payload).catch(() => {});
}

function botSnapshotForAudit(mode, ranked = null) {
  const snap = botPortfolioSnapshot(mode, ranked);
  return {
cash: Number(snap.cash || 0),
deployed: Number(snap.openValue || 0),
totalValue: Number(snap.totalValue || 0),
pnl: Number(snap.pnl || 0),
capital: Number(snap.capital || 0),
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
symbols,
modes: Object.fromEntries(botModeIds().map(mode => [mode, {
capital: botCapital(mode),
start: botSnapshotForAudit(mode),
final: null,
}])),
audit: Object.fromEntries(botModeIds().map(mode => [mode, []])),
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
}

function resetBotSession() {
  const wasRunning = botState.running;
  if (botState.timer) clearTimeout(botState.timer);
  botState = createBotState();
  botState.running = wasRunning;
  botState.startedAt = Date.now();
  botState.stopAt = Date.now() + Math.max(1, Number(botConfig.durationMin || 30)) * 60000;
  botPersistState();
}

function resetBots() {
if (botState.timer) clearTimeout(botState.timer);
botState = createBotState();
activeBotRun = null;
botRuns = [];
botPersistState();
botPersistRuns();
renderBotStatus();
renderBotLog();
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
  return ranked.find(item => item.symbol === symbol) || quotes.find(item => item.symbol === symbol);
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
  const minTrade = Math.max(BOT_MIN_TRADE_NOTIONAL, snapshot.capital * 0.02);
  const cleanNotional = Math.min(notional, snapshot.cash);
  if (cleanNotional < minTrade || candidate.price <= 0) return false;
  // Apply fee: fee is added to cost basis
  const fee = cleanNotional * BOT_FEE_RATE;
  const qty = cleanNotional / candidate.price;
  const position = state.positions[candidate.symbol] || { qty: 0, avgPrice: 0, costBasis: 0, realized: 0, openedAt: Date.now() };
  position.qty = Number(position.qty || 0) + qty;
  position.costBasis = Number(position.costBasis || 0) + cleanNotional + fee; // Fee baked into cost
  position.avgPrice = position.qty > 0 ? position.costBasis / position.qty : 0;
  position.openedAt = position.openedAt || Date.now();
  position.updatedAt = Date.now();
  state.positions[candidate.symbol] = position;
  state.lastTradeAt[candidate.symbol] = Date.now();
  botRecordTrade(mode, { side: "BUY", symbol: candidate.symbol, qty, price: candidate.price, notional: cleanNotional, fee, reason });
  logBotDecision(mode, { action: "BUY", symbol: candidate.symbol, qty, price: candidate.price, notional: cleanNotional, fee, score: candidate.score, reason });
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
  const fee = notional * BOT_FEE_RATE;
  const costRemoved = sellQty * avgPrice;
  const realized = notional - costRemoved - fee; // Fee subtracted from realized P&L
  position.qty = Math.max(0, Number(position.qty || 0) - sellQty);
  position.costBasis = Math.max(0, Number(position.costBasis || 0) - costRemoved);
  position.realized = Number(position.realized || 0) + realized;
  position.updatedAt = Date.now();
  state.realized = Number(state.realized || 0) + realized;
  if (position.qty <= 0.000001) delete state.positions[candidate.symbol];
  else state.positions[candidate.symbol] = position;
  state.lastTradeAt[candidate.symbol] = Date.now();
  botRecordTrade(mode, { side: "SELL", symbol: candidate.symbol, qty: sellQty, price: candidate.price, notional, fee, pnl: realized, reason });
  logBotDecision(mode, { action: "SELL", symbol: candidate.symbol, qty: sellQty, price: candidate.price, notional, fee, pnl: realized, score: candidate.score, reason });
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

function renderBotStatus() {
const snapshots = Object.fromEntries(botModeIds().map(mode => [mode, botPortfolioSnapshot(mode)]));
const totalCapital = Object.values(snapshots).reduce((sum, snap) => sum + snap.capital, 0);
const totalValue = Object.values(snapshots).reduce((sum, snap) => sum + snap.totalValue, 0);
  const totalPnl = totalValue - totalCapital;
  if (els.botState) {
    els.botState.textContent = botState.running ? "Running" : "Stopped";
    els.botState.className = botState.running ? "running" : "";
  }
  if (els.botSummary) {
    const secondsLeft = botState.running ? Math.max(0, Math.round((botState.stopAt - Date.now()) / 1000)) : 0;
    els.botSummary.textContent = botState.running
      ? `$${formatPrice(totalValue)} live value | ${totalPnl >= 0 ? "+" : ""}$${formatPrice(totalPnl)} combined P&L | ${secondsLeft}s left`
      : `$${formatPrice(totalValue)} combined value | ${totalPnl >= 0 ? "+" : ""}$${formatPrice(totalPnl)} paper P&L`;
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
  els.botUniverseMode?.toggleAttribute("disabled", botState.running);
  botModeIds().forEach(mode => {
    const snap = snapshots[mode];
    const stateEl = botModeEl(mode, "state");
    const valueEl = botModeEl(mode, "value");
    const pnlEl = botModeEl(mode, "pnl");
    const cashEl = botModeEl(mode, "cash");
    const deployedEl = botModeEl(mode, "deployed");
    botInputFor(mode)?.toggleAttribute("disabled", botState.running);
    if (stateEl) stateEl.textContent = botState.running ? "Live" : "Idle";
    if (valueEl) valueEl.textContent = `$${formatPrice(snap.totalValue)}`;
    if (pnlEl) {
      pnlEl.textContent = `${snap.pnl >= 0 ? "+" : ""}$${formatPrice(snap.pnl)}`;
      pnlEl.className = snap.pnl >= 0 ? "positive" : "negative";
    }
    if (cashEl) cashEl.textContent = `$${formatPrice(snap.cash)}`;
    if (deployedEl) deployedEl.textContent = `$${formatPrice(snap.openValue)}`;
renderBotPositions(mode);
});
}

function botCloseOpenPositions(reason) {
botModeIds().forEach(mode => {
Object.keys(botState.modes[mode].positions).forEach(symbol => {
const position = botState.modes[mode].positions[symbol];
const qty = Number(position?.qty || 0);
if (qty <= 0) return;
const quote = botQuoteFor(symbol);
const price = Number(quote?.price || position.avgPrice || 0);
if (price <= 0) return;
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
};
if (executeBotSell(mode, candidate, qty, reason)) {
botAppendRunAudit(mode, { action: "SELL", symbol, price, reason }, null);
}
});
});
}

function stopBot(reason = "stopped") {
  if (botState.timer) clearTimeout(botState.timer);
  botState.timer = null;
  if (window.botL2Timer) clearTimeout(window.botL2Timer);
  window.botL2Timer = null;
  if (botState.running) {
    if (window.tradingBots) {
        Object.values(window.tradingBots).forEach(bot => bot.stop());
    }
    botCloseOpenPositions(reason === "run duration completed" ? "window complete; flattened open paper positions" : reason);
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
  botState.timer = setTimeout(scheduleBotDecision, 1000);
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
botStartRunRecord();
botModeIds().forEach(mode => {
logBotDecision(mode, { action: "START", reason: `$${formatPrice(botCapital(mode))} capital; ${botConfig.durationMin} minute run; scanning ${botUniverseSymbols().length} ${botUniverseLabel()} symbols` });
});
  renderBotStatus();
  scheduleBotDecision();

    botModeIds().forEach(mode => {
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
  const minTrade = Math.min(BOT_MIN_TRADE_NOTIONAL, Math.max(0.25, snapshot.capital * 0.01));
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
const modeSpeed = mode === "calm" ? 1.15 : mode === "aggressive" ? 0.34 : 0.72;
const observeMs = clamp(durationMs * (0.045 * modeSpeed), mode === "aggressive" ? 1500 : mode === "calm" ? 3500 : 2500, mode === "calm" ? 12000 : mode === "aggressive" ? 4500 : 8000);
const exitMs = clamp(durationMs * (mode === "calm" ? 0.12 : mode === "aggressive" ? 0.08 : 0.1), mode === "aggressive" ? 6000 : 8000, 30000);
let phase = "build";
if (elapsedMs < observeMs) phase = "observe";
else if (remainingMs <= exitMs) phase = "exit";
else if (progress > 0.62) phase = "manage";
const activeWindow = Math.max(1, durationMs - observeMs - exitMs);
const activeProgress = clamp((elapsedMs - observeMs) / activeWindow, 0, 1);
return { now, startedAt, stopAt, durationMs, elapsedMs, remainingMs, progress, activeProgress, observeMs, exitMs, phase };
}

const tradingBots = {
  calm: new CalmBot(),
  normal: new NormalBot(),
  aggressive: new AggressiveBot()
};

function enhancedRunBotDecision() {
if (!botState.running) return;
if (Date.now() >= botState.stopAt) {
stopBot("run duration completed");
return;
}
const symbols = botUniverseSymbols();
if (!symbols.length) {
botModeIds().forEach(mode => {
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
botModeIds().forEach(mode => {
const row = { action: "HOLD", reason: `waiting for live ${botUniverseLabel()} prices` };
logBotDecision(mode, row, { key: "no-prices", throttleMs: 5000 });
botAppendRunAudit(mode, row, null);
});
renderBotStatus();
scheduleBotDecision();
return;
}
botModeIds().forEach(mode => {
const ranked = botRankAnalyses(universe.map(quote => analyzeBotSymbol(mode, quote)));
if (ranked.length) tradingBots[mode].runModeDecision(ranked);
});
} catch (err) {
botModeIds().forEach(mode => {
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
    
    // determine flash if quote updated
    const prior = previousPrices.get(pos.symbol);
    const flash = prior !== undefined && currentPrice !== prior ? (currentPrice > prior ? "flash-up" : "flash-down") : "";
    
    return `
      <div class="portfolio-item ${pos.symbol === activeSymbol ? "active" : ""} ${flash}" onclick="selectSymbol('${pos.symbol}')">
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
  if (!els.historyList) return;
  const filteredHistory = tradeHistory.slice().reverse().slice(0, 50); // limit to last 50 for ui performance
  if (!filteredHistory.length) {
    els.historyList.innerHTML = `<div style="padding:16px; color:var(--muted); text-align:center;">No recent history.</div>`;
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
} else if (side === "sell") {
let pnl = 0;
const totalHeld = heldQuantity(symbol);
if (totalHeld <= 0 || qty > totalHeld + 0.000001) {
alert(`Not enough ${symbol} position to sell.`);
return false;
}
walletCash += tradeValue; // Add full sale amount to cash
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
    els.headerSignal.className = dirClass === "positive" ? "bg-green text-black" : dirClass === "negative" ? "bg-red text-black" : "bg-panel text-white";
    els.headerSignal.style.backgroundColor = dirClass === "positive" ? "var(--green)" : dirClass === "negative" ? "var(--red)" : "var(--panel)";
    els.headerSignal.style.color = dirClass !== "neutral" ? "var(--bg)" : "inherit";
    if (els.headerTarget) els.headerTarget.textContent = activeSignals.targetPrice ? `Target: ${formatPrice(activeSignals.targetPrice)}` : '';
  }
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
  renderBotStatus();
  renderBotLog();
  document.querySelector(".desk-shell")?.classList.add("hidden");
  els.botModal?.classList.remove("hidden");
}

function closeBotPage() {
  if (!botState.running) readBotConfig();
  els.botModal?.classList.add("hidden");
  document.querySelector(".desk-shell")?.classList.remove("hidden");
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
[els.botUniverseMode, document.querySelector("#bot-duration"), ...botModeIds().map(mode => botInputFor(mode))].forEach(input => {
  input?.addEventListener("change", () => {
    if (!botState.running) {
      readBotConfig();
      loadDesk();
    }
    renderBotStatus();
  });
});
els.botReset?.addEventListener("click", () => {
  resetBots();
  appendTerminalLine("[BOT] bots reset", "ok");
});
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

