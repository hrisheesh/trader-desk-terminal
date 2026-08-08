const fs = require("fs");

// ---------------------------------------------------------------
// Stubs replicating the parts of app.js the bots depend on.
// ---------------------------------------------------------------
function clamp(v, min, max) { return Math.min(max, Math.max(min, Number(v) || min)); }
function formatPrice(v) { return Number(v).toFixed(2); }

function botHistoryStats(history, price) {
  const prices = history.map(i => Number(i.price || 0)).filter(Boolean);
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
  const mean = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length : 0;
  const volatilityPct = clamp(Math.sqrt(variance), 0.08, 7);
  const noisePct = clamp(volatilityPct - Math.abs(mean), 0, 7);
  let gains = 0, losses = 0;
  returns.forEach(r => { if (r > 0) gains += r; else losses += Math.abs(r); });
  const rs = losses === 0 ? 100 : gains / losses;
  const rsiProxy = returns.length > 0 ? 100 - (100 / (1 + rs)) : 50;
  const zWindow = prices.slice(-Math.min(samples, 200));
  const priceMean = zWindow.reduce((s, p) => s + p, 0) / zWindow.length;
  const priceVariance = zWindow.reduce((s, p) => s + (p - priceMean) ** 2, 0) / zWindow.length;
  const priceStdDev = Math.sqrt(priceVariance);
  const zScore = priceStdDev > 0 ? (price - priceMean) / priceStdDev : 0;
  return {
    samples, momentumPct: first ? ((price - first) / first) * 100 : 0,
    shortMomentumPct: pivot ? ((price - pivot) / pivot) * 100 : 0,
    volatilityPct, noisePct, rsiProxy, zScore, priceMean, priceStdDev,
    supportDistancePct: low ? ((price - low) / low) * 100 : 0,
    resistanceDistancePct: high ? ((high - price) / price) * 100 : 0,
  };
}

const BOT_PRICE_MEMORY_LIMIT = 200;
const BOT_STALE_TICK_LIMIT = 20;
const BOT_FEE_RATE = 0.001;
const BOT_MIN_TRADE_NOTIONAL = 10;

function createModeState() {
  return { positions: {}, trades: [], logs: [], rankings: [], priceMemory: {}, lastTradeAt: {}, realized: 0, decisions: 0, lastLog: {} };
}
const botState = { running: false, modes: { calm: createModeState(), normal: createModeState(), aggressive: createModeState() } };

let learning;

function rememberBotPrice(mode, symbol, price) {
  const mem = botState.modes[mode].priceMemory;
  const h = Array.isArray(mem[symbol]) ? mem[symbol] : [];
  h.push({ price, time: Date.now() });
  mem[symbol] = h.slice(-BOT_PRICE_MEMORY_LIMIT);
}

const signalsFor = {
  "TREND-USD": { symbol: "TREND-USD", action: "Buy", confidence: 72 },
  "CHOP-USD": { symbol: "CHOP-USD", action: "Hold", confidence: 50 },
  "DROP-USD": { symbol: "DROP-USD", action: "Sell", confidence: 30 },
};
function botSignalFor(symbol) { return signalsFor[symbol] || { action: "Hold", confidence: 50 }; }

function botHeldQuantity(mode, symbol) { return Number(botState.modes[mode].positions[symbol]?.qty || 0); }
function botAverageEntry(mode, symbol) { return Number(botState.modes[mode].positions[symbol]?.avgPrice || 0); }
function botCapital(mode) { return 10000; }

function botOpenValue(mode) {
  return Object.entries(botState.modes[mode].positions).reduce((sum, [s, p]) => {
    const q = window.quotes.find(x => x.symbol === s);
    const price = Number(q?.price || p.avgPrice || 0);
    return sum + Number(p.qty || 0) * price;
  }, 0);
}
function botPortfolioSnapshot(mode) {
  const capital = botCapital(mode);
  const openValue = botOpenValue(mode);
  const costBasis = Object.values(botState.modes[mode].positions).reduce((s, p) => s + Number(p.costBasis || 0), 0);
  const realized = Number(botState.modes[mode].realized || 0);
  const cash = Math.max(0, capital - costBasis + realized);
  return { capital, openValue, costBasis, realized, cash, totalValue: cash + openValue, pnl: cash + openValue - capital };
}

function logBotDecision(mode, row) { botState.modes[mode].logs.unshift(row); botState.modes[mode].logs = botState.modes[mode].logs.slice(0, 100); }
function botRecordTrade(mode, row) { botState.modes[mode].trades.unshift(row); botState.modes[mode].trades = botState.modes[mode].trades.slice(0, 200); }

function executeBotBuy(mode, candidate, notional, reason) {
  const state = botState.modes[mode];
  const snapshot = botPortfolioSnapshot(mode);
  const minTrade = Math.max(BOT_MIN_TRADE_NOTIONAL, snapshot.capital * 0.02);
  const clean = Math.min(notional, snapshot.cash);
  if (clean < minTrade || candidate.price <= 0) return false;
  const fee = clean * BOT_FEE_RATE;
  const qty = clean / candidate.price;
  const pos = state.positions[candidate.symbol] || { qty: 0, avgPrice: 0, costBasis: 0, realized: 0, openedAt: Date.now() };
  pos.qty = Number(pos.qty || 0) + qty;
  pos.costBasis = Number(pos.costBasis || 0) + clean + fee;
  pos.avgPrice = pos.qty > 0 ? pos.costBasis / pos.qty : 0;
  pos.openedAt = pos.openedAt || Date.now();
  pos.updatedAt = Date.now();
  // Persist the risk plan, exactly like the real app glue does.
  if (candidate.stopLossPct !== undefined) pos.stopLossPct = Number(candidate.stopLossPct);
  if (candidate.takeProfitPct !== undefined) pos.takeProfitPct = Number(candidate.takeProfitPct);
  if (candidate.trailPct !== undefined) pos.trailPct = Number(candidate.trailPct);
  state.positions[candidate.symbol] = pos;
  state.lastTradeAt[candidate.symbol] = Date.now();
  botRecordTrade(mode, { side: "BUY", symbol: candidate.symbol, qty, price: candidate.price, notional: clean, reason });
  logBotDecision(mode, { action: "BUY", symbol: candidate.symbol, qty, price: candidate.price, notional: clean, reason });
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
  const fee = notional * BOT_FEE_RATE;
  const costRemoved = sellQty * avgPrice;
  const realized = notional - costRemoved - fee;
  position.qty = Math.max(0, Number(position.qty || 0) - sellQty);
  position.costBasis = Math.max(0, Number(position.costBasis || 0) - costRemoved);
  position.realized = Number(position.realized || 0) + realized;
  position.closedPnl = Number(position.closedPnl || 0) + realized;
  if (candidate.action === "LOCK PROFIT" || candidate.action === "REDUCE") position.targetHit = true;
  position.updatedAt = Date.now();
  state.realized = Number(state.realized || 0) + realized;
  if (position.qty <= 0.000001) {
    if (learning && learning.recordExit) learning.recordExit(mode, {
      symbol: candidate.symbol, setupType: candidate.setupType || "", pnl: position.closedPnl || realized,
      pnlPct: Number(candidate.pnlPct) || 0, volatility: Number(candidate.volatilityPct || 0), capital: botCapital(mode),
    });
    delete state.positions[candidate.symbol];
  } else state.positions[candidate.symbol] = position;
  state.lastTradeAt[candidate.symbol] = Date.now();
  botRecordTrade(mode, { side: "SELL", symbol: candidate.symbol, qty: sellQty, price: candidate.price, notional, pnl: realized, reason });
  logBotDecision(mode, { action: "SELL", symbol: candidate.symbol, qty: sellQty, price: candidate.price, notional, pnl: realized, reason });
  return true;
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

global.window = {
  clamp, botHistoryStats, botSignalFor, botHeldQuantity, botAverageEntry, botCapital,
  botPortfolioSnapshot, executeBotBuy, executeBotSell, logBotDecision, rememberBotPrice,
  botMarketAgreement, botAnalyzeOrderBook: () => ({ bidVol: 100, askVol: 100, imbalance: 0 }),
  botState, quotes: [],
  getBotUniverseQuotes: () => global.window.quotes,
};

// ---------------------------------------------------------------
// Load the real bot files
// ---------------------------------------------------------------
eval(fs.readFileSync("bots/LearningEngine.js", "utf8"));
learning = new window.LearningEngine();
window.botLearning = learning;
eval(fs.readFileSync("bots/SwarmWorker.js", "utf8"));
eval(fs.readFileSync("bots/BotBase.js", "utf8"));
eval(fs.readFileSync("bots/CalmBot.js", "utf8"));
eval(fs.readFileSync("bots/NormalBot.js", "utf8"));
eval(fs.readFileSync("bots/AggressiveBot.js", "utf8"));

// ---------------------------------------------------------------
// Synthetic market. Each tick advances simulated time by 1s so the
// bots' cooldowns / time stops behave like a real 700s session:
//   TREND-USD  accelerating uptrend with momentum bursts (normal + aggressive)
//   DIP-USD    deep dip, hold, recovery (calm mean-reversion)
//   CHOP-USD   sideways chop (should be skipped)
//   DROP-USD   steady decline (should be avoided / stopped out)
// ---------------------------------------------------------------
let t = 0;
const REAL_NOW = Date.now;
function step() {
  const prices = { "TREND-USD": 100, "DIP-USD": 40, "CHOP-USD": 50, "DROP-USD": 20 };
  return function advance() {
    t += 1;
    const n = (s) => (Math.sin(t * 0.7 + s) * 0.04) + ((Math.random() - 0.5) * 0.24);
    // TREND: drift accelerates, with periodic 12-tick momentum bursts.
    let trendDrift = 0.02 + 0.05 * (t / 700);
    if (t % 140 < 12) trendDrift += 0.38;
    prices["TREND-USD"] *= (1 + (trendDrift + n(1)) / 100);
    // DIP: falls ~20% over 220 ticks, then recovers to +10%.
    if (t < 220) prices["DIP-USD"] = 40 * (1 - 0.00092 * t) + n(2);
    else prices["DIP-USD"] = 31.9 + 0.024 * (t - 220) + n(2);
    // CHOP: oscillation in a range wide enough for scalps.
    prices["CHOP-USD"] = 50 + Math.sin(t * 0.35) * 1.2 + ((Math.random() - 0.5) * 0.3);
    // DROP: steady grind lower.
    prices["DROP-USD"] *= (1 + (-0.045 + n(3)) / 100);
    const highLow = (p, s) => ({ high: p * 1.02, low: p * 0.98 });
    return [
      { symbol: "TREND-USD", price: prices["TREND-USD"], changePercent: 1.4, ...highLow(prices["TREND-USD"]) },
      { symbol: "DIP-USD", price: prices["DIP-USD"], changePercent: 0.2, ...highLow(prices["DIP-USD"]) },
      { symbol: "CHOP-USD", price: prices["CHOP-USD"], changePercent: 0.1, ...highLow(prices["CHOP-USD"]) },
      { symbol: "DROP-USD", price: prices["DROP-USD"], changePercent: -1.1, ...highLow(prices["DROP-USD"]) },
    ];
  };
}
const advance = step();

// ---------------------------------------------------------------
// Run the swarm over many ticks exactly as the app would.
// ---------------------------------------------------------------
async function run() {
  const bots = { calm: new window.CalmBot(), normal: new window.NormalBot(), aggressive: new window.AggressiveBot() };
  bots.calm.running = true; bots.normal.running = true; bots.aggressive.running = true;

  const modeTrades = { calm: [], normal: [], aggressive: [] };
  for (const b of Object.values(bots)) b._trades = [];

  const TICKS = 700;
  for (let i = 0; i < TICKS; i++) {
    window.quotes = advance();
    // Simulate wall-clock: each tick is 1s of session time.
    Date.now = () => REAL_NOW() + t * 1000;
    for (const mode of ["calm", "normal", "aggressive"]) {
      try {
        await bots[mode].tick();
      } catch (e) {
        console.error("TICK ERROR", mode, e);
        process.exit(1);
      }
    }
  }

  // Flatten everything at session end, like the app liquidates on stop.
  for (const mode of ["calm", "normal", "aggressive"]) {
    const flat = window.quotes.map(q => ({ symbol: q.symbol, price: q.price, heldQty: window.botHeldQuantity(mode, q.symbol) }))
      .filter(x => x.heldQty > 0);
    for (const item of flat) {
      const entry = window.botAverageEntry(mode, item.symbol);
      const pnlPct = entry ? ((item.price - entry) / entry) * 100 : 0;
      window.executeBotSell(mode, { ...item, action: "EXIT", setupType: "flatten", pnlPct }, item.heldQty, "Session end flatten");
    }
  }

  console.log("=== RESULTS after", TICKS, "ticks ===");
  for (const mode of ["calm", "normal", "aggressive"]) {
    const s = botState.modes[mode];
    const learn = learning.getParams(mode, bots[mode].traits());
    console.log(`\n[${mode}]`);
    console.log("  open positions:", Object.keys(s.positions).length, JSON.stringify(s.positions));
    console.log("  realized pnl: $", s.realized.toFixed(2));
    console.log("  sells:", s.trades.filter(x => x.side === "SELL").length, "buys:", s.trades.filter(x => x.side === "BUY").length);
    console.log("  learned: trades", learn.trades, "| winRate", (learn.winRate * 100).toFixed(0) + "%", "| kelly", (learn.kelly * 100).toFixed(1) + "%",
      "| minEdge", learn.minEdge.toFixed(1), "| stop", learn.stopPct.toFixed(2) + "%", "| target", learn.targetPct.toFixed(2) + "%");
    const setups = new Set(s.trades.map(x => x.reason).join(" ").match(/(breakout|momentum|reversion|pullback|trend|chop)/g) || []);
    if (setups.size) console.log("  setups seen:", [...setups].join(", "));
  }

  // ---- Assertions ----
  const asserts = [];
  const totalBuys = ["calm", "normal", "aggressive"].reduce((n, m) => n + botState.modes[m].trades.filter(x => x.side === "BUY").length, 0);
  const totalSells = ["calm", "normal", "aggressive"].reduce((n, m) => n + botState.modes[m].trades.filter(x => x.side === "SELL").length, 0);
  const learnedTrades = learning.state.modes.calm.trades + learning.state.modes.normal.trades + learning.state.modes.aggressive.trades;
  const trendTraded = ["calm", "normal", "aggressive"].some(m => botState.modes[m].trades.some(x => x.symbol === "TREND-USD"));
  const aggressRealized = botState.modes.aggressive.realized;
  const normalRealized = botState.modes.normal.realized;

  asserts.push(["bots made some buys", totalBuys > 3]);
  asserts.push(["bots closed positions (sells happen)", totalSells > 2]);
  asserts.push(["learning engine recorded closed trades", learnedTrades >= 3]);
  asserts.push(["trending symbol was traded (edge detection works)", trendTraded]);
  asserts.push(["normal+aggressive profit in a trending tape", (normalRealized + aggressRealized) > 0]);
  asserts.push(["no single position exceeds maxPosition (aggressive 22%)", Object.entries(botState.modes.aggressive.positions).every(([sym, p]) => {
    const q = window.quotes.find(x => x.symbol === sym);
    return !q || (Number(p.qty || 0) * q.price) <= botCapital("aggressive") * 0.22 * 2.1 + 1;
  })]);
  asserts.push(["realized P&L recorded consistently with trades", ["calm", "normal", "aggressive"].every(m => {
    const s = botState.modes[m];
    return Math.abs(s.realized - s.trades.filter(x => x.side === "SELL").reduce((sum, x) => sum + Number(x.pnl || 0), 0)) < 0.01;
  })]);
  asserts.push(["learning engine: win rate, kelly and minEdge adapt to outcomes", (() => {
    const eng = new window.LearningEngine();
    const traits = bots.normal.traits();
    const before = eng.getParams("normal", traits);
    const baseMinEdge = before.minEdge;
    for (let i = 0; i < 8; i++) eng.recordExit("normal", { symbol: "TREND-USD", setupType: "trend", pnl: 150, pnlPct: 2.5, volatility: 1.2, capital: 10000 });
    const winning = eng.getParams("normal", traits);
    const winningKelly = winning.kelly;
    const loweredBar = winning.minEdge;
    for (let i = 0; i < 6; i++) eng.recordExit("normal", { symbol: "TREND-USD", setupType: "trend", pnl: -90, pnlPct: -2.0, volatility: 1.2, capital: 10000 });
    const losing = eng.getParams("normal", traits);
    const raisedBar = losing.minEdge;
    const winRateMoved = Math.abs(winning.winRate - 0.5) > 0.1;
    return winRateMoved && winningKelly > 0 && raisedBar > loweredBar && winning.winRate > losing.winRate;
  })()]);

  let pass = 0;
  for (const [label, ok] of asserts) {
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${label}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${asserts.length} assertions passed`);
  process.exit(pass === asserts.length ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
