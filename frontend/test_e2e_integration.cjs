const { JSDOM } = require("jsdom");
const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");
const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost:8080/",
});
const { window } = dom;
const doc = window.document;

// ---- browser API stubs ----
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.alert = () => {};
window.confirm = () => false;
window.prompt = () => null;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.LightweightCharts = {
  createChart() {
    return {
      addCandlestickSeries() { return { setData() {}, setMarkers() {} }; },
      addLineSeries() { return { setData() {} }; },
      addHistogramSeries() { return { setData() {} }; },
      applyOptions() {}, remove() {},
      timeScale() { return { fitContent() {} }; },
      priceScale() { return { applyOptions() {} }; },
      addSplineSeries() { return { setData() {} }; },
      addAreaSeries() { return { setData() {} }; },
      addHistogramSeries() { return { setData() {} }; },
      subscribeVisibleLogicalRangeChange() {},
    };
  },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 1 },
  ColorType: { Solid: 0 },
  LineWidth: { Thin: 1 },
};
class FakeWS {
  constructor() { this.readyState = 1; }
  send() {} close() {}
  addEventListener() {} removeEventListener() {}
}
window.WebSocket = FakeWS;

// ---- moving quote feed (strong rise then sharp giveback, refreshed every
// 1.5s). The ~0.3%/refresh rise classifies as trend, the ~7% cumulative rise
// passes the vol-scaled take profit, and the giveback trips the momentum-fade
// / trailing exit so the partial position fully closes and records learning.
let deskCalls = 0;
let polymarketCalls = 0;
const polyWindowStart = Math.floor(Date.now() / 1000) - 10;
const polyWindowEnd = polyWindowStart + 240;
const base = { "BTC-USD": 67000, "ETH-USD": 3500, "SOL-USD": 170, "XRP-USD": 0.62, "DOGE-USD": 0.16, "ADA-USD": 0.55, "AVAX-USD": 38, "LINK-USD": 16, "DOT-USD": 7.4, "LTC-USD": 85, "BCH-USD": 480, "UNI-USD": 9.5, "ATOM-USD": 8.2, "ETC-USD": 26, "XLM-USD": 0.11, "FIL-USD": 5.4, "ALGO-USD": 0.21, "ICP-USD": 12, "HBAR-USD": 0.09, "TRX-USD": 0.14, "NEAR-USD": 5.2, "APT-USD": 9.1, "SUI-USD": 2.4, "OP-USD": 1.9, "ARB-USD": 1.1, "INJ-USD": 22, "AAVE-USD": 260, "SHIB-USD": 0.000028, "PEPE-USD": 0.000014, "BONK-USD": 0.000033, "WIF-USD": 2.3, "FLOKI-USD": 0.00021, "TON-USD": 7.1, "POL-USD": 0.62, "CRO-USD": 0.12, "VET-USD": 0.035, "GRT-USD": 0.27, "RNDR-USD": 7.4, "RUNE-USD": 5.6, "STX-USD": 1.8, "IMX-USD": 1.9, "SEI-USD": 0.42, "TIA-USD": 6.4, "TAO-USD": 320, "FET-USD": 1.4, "JUP-USD": 0.95, "ENA-USD": 0.52, "ONDO-USD": 1.15, "CRV-USD": 0.63, "MKR-USD": 2300, "ZEC-USD": 41, NVDA: 118, AAPL: 220, TSLA: 248, MSFT: 425, SPY: 545, QQQ: 470, SOXL: 42 };
function quoteFor(symbol, t) {
  const phase = (symbol.charCodeAt(symbol.length - 1) || 0) % 7;
  const step = 0.30 + (phase % 3) * 0.05;
  const pct = Math.min(t, 15) * step - Math.max(0, t - 15) * 0.9 + Math.sin(t * 0.5 + phase) * 0.04;
  const price = base[symbol] * (1 + pct / 100);
  // Keep the synthetic leader near a fresh day high so the overextension
  // guard can exercise its confirmed-breakout exception.
  return { symbol, price, changePercent: 1.8, high: price * 1.001, low: price * 0.98 };
}
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/desk")) {
    deskCalls += 1;
    const t = deskCalls;
    const raw = (u.split("symbols=")[1] || "").split("&")[0];
    const symbols = decodeURIComponent(raw).split(",").map(s => s.trim()).filter(Boolean);
    const quotes = symbols.map(s => quoteFor(s, t)).filter(q => Number(q.price || 0) > 0);
    return { ok: true, json: async () => ({ quotes, pulse: [], alerts: [], signals: [], fetchedAt: Date.now() }) };
  }
  if (u.includes("/api/flow")) {
    return { ok: true, json: async () => ({ book: { bids: [], asks: [] }, tape: [], flow: {} }) };
  }
  if (u.includes("/api/polymarket/btc")) {
    polymarketCalls += 1;
    const spot = 67000 + polymarketCalls * 4;
    return { ok: true, json: async () => ({
      fetchedAt: Date.now(),
      source: "test",
      spot: { price: spot, timestampMs: Date.now(), ageMs: 0, source: "Polymarket RTDS Chainlink test", stale: false },
      lead: { price: spot + 2, timestampMs: Date.now(), ageMs: 0, momentumPct10s: 0.01, source: "test Binance lead", stale: false },
      markets: [{
        interval: "5m", slug: "btc-updown-5m-test", windowStart: polyWindowStart, windowEnd: polyWindowEnd, question: "BTC Up or Down test", secondsRemaining: 240, stale: false, anchorReady: true,
        reference: { price: 67000, timestampMs: Date.now(), ageMs: 0, ready: true, quality: "captured" },
        yes: { bid: 0.44, ask: 0.45, buyPrice: 0.45, sellPrice: 0.44, mid: 0.445, spread: 0.01, minOrderSize: 5 },
        no: { bid: 0.57, ask: 0.58, buyPrice: 0.58, sellPrice: 0.57, mid: 0.575, spread: 0.01, minOrderSize: 5 },
      }],
    }) };
  }
  if (u.includes("/api/candles")) {
    return { ok: true, json: async () => ({ candles: [], quote: quoteFor("BTC-USD", deskCalls) }) };
  }
  if (u.includes("/api/quotes/")) {
    return { ok: true, json: async () => ({ quote: quoteFor("BTC-USD", deskCalls) }) };
  }
  if (u.includes("/api/search")) {
    return { ok: true, json: async () => ({ results: [] }) };
  }
  return { ok: true, json: async () => ({}) };
};

// ---- seed bot config: crypto universe, short run ----
window.localStorage.setItem("trader-desk-bot-config-v3", JSON.stringify({
  durationMin: 5,
  observeMinutes: 0,
  universeMode: "crypto",
  multiplierEnabled: true,
  // Regression coverage: small paper accounts must still be able to place
  // fractional orders and manage them through the full run lifecycle.
  modes: { calm: { capital: 10 }, normal: { capital: 10 }, aggressive: { capital: 10 } },
}));
window.localStorage.removeItem("trader-desk-bot-learning-v1");
window.localStorage.removeItem("trader-desk-bot-state-v4");

// ---- load real scripts in index.html order ----
for (const file of ["bots/LearningEngine.js", "bots/SwarmWorker.js", "bots/BotBase.js", "bots/CalmBot.js", "bots/NormalBot.js", "bots/AggressiveBot.js", "bots/PolymarketSwarmEngine.js", "app.js"]) {
  const code = fs.readFileSync(file, "utf8");
  try {
    window.eval(code);
  } catch (e) {
    console.error(`EVAL FAIL ${file}:`, e.message);
    process.exit(1);
  }
}

const errors = [];
window.addEventListener("error", (e) => errors.push(e.message || String(e.error)));

(async () => {
  // Let initial loadDesk + a couple of bot ticks happen, collecting samples.
  await new Promise(r => setTimeout(r, 1500));

  const swarmPolyIsolation = doc.querySelector("#bot-polymarket-panel")?.classList.contains("hidden") === true;

  const startBtn = doc.querySelector("#bot-start");
  if (!startBtn) { console.error("FAIL: no #bot-start button"); process.exit(1); }
  startBtn.click();

  const startLog = window.botState;
  console.log("after Start: running =", window.botState.running, "startedAt set =", !!window.botState.startedAt);
  console.log("getBotUniverseQuotes() count:", window.getBotUniverseQuotes().length, "->", window.getBotUniverseQuotes().slice(0, 3).map(q => q.symbol).join(","));
  console.log("universe select value:", doc.querySelector("#bot-universe-mode") && doc.querySelector("#bot-universe-mode").value);

  // Let the 500ms bot loop run for ~30s (oscillating legs -> profit targets + stops).
  await new Promise(r => setTimeout(r, 30000));

  const states = window.botState.modes;
  let totalBuys = 0, totalSells = 0, totalDecisions = 0;
  let multiplierBuys = 0;
  let freeHandBuys = 0;
  let largestMultiplierNotional = 0;
  for (const mode of ["calm", "normal", "aggressive"]) {
    const s = states[mode];
    totalBuys += s.trades.filter(t => t.side === "BUY").length;
    totalSells += s.trades.filter(t => t.side === "SELL").length;
    const modeMultiplierBuys = s.trades.filter(t => t.side === "BUY" && t.multiplier === true);
    multiplierBuys += modeMultiplierBuys.length;
    freeHandBuys += modeMultiplierBuys.filter(t => t.freeHand === true).length;
    largestMultiplierNotional = Math.max(largestMultiplierNotional, ...modeMultiplierBuys.map(t => Number(t.notional || 0)));
    totalDecisions += s.decisions;
    console.log(`[${mode}] decisions=${s.decisions} trades=${s.trades.length} positions=${Object.keys(s.positions).length} realized=${s.realized.toFixed(2)} logs=${s.logs.length}`);
  }
  const learned = window.botLearning ? window.botLearning.state.modes : {};
  console.log("learning records:", Object.fromEntries(Object.entries(learned).map(([m, st]) => [m, st.trades])));
  console.log("run audit decision rows:", (window.botState.modes.aggressive.logs.filter(l => l.action === "BUY" || l.action === "SELL")).length);
  console.log("sample aggressive logs:", states.aggressive.logs.slice(0, 4).map(l => l.action + ":" + (l.reason || "").slice(0, 60)));

  const passes = [];
  passes.push([totalDecisions > 0, `decision loop ran (${totalDecisions} decisions)`]);
  passes.push([totalBuys > 0, `bots bought (${totalBuys} buys)`]);
  passes.push([totalSells > 0, `bots took profits (${totalSells} sells)`]);
  passes.push([window.botState.running === true, "bots still running after run window"]);
  passes.push([errors.length === 0, `no runtime errors (${errors.length})${errors.length ? ": " + errors.join(" | ") : ""}`]);
  passes.push([Object.values(learned).reduce((a, st) => a + (st ? st.trades : 0), 0) > 0, `learning recorded closed trades (${Object.values(learned).reduce((a, st) => a + (st ? st.trades : 0), 0)})`]);
  passes.push([multiplierBuys > 0 && largestMultiplierNotional > 2.5, `multiplier mode placed larger swarm-sized bets (${multiplierBuys} buys; max $${largestMultiplierNotional.toFixed(2)})`]);
  passes.push([freeHandBuys === multiplierBuys, `multiplier entries are free-hand with no fixed target (${freeHandBuys}/${multiplierBuys})`]);
  passes.push([Object.values(learned).some(st => Object.keys(st?.byMomentum || {}).length > 0), "learning records momentum buckets for adaptive exits"]);

  let ok = true;
  for (const [cond, label] of passes) {
    console.log((cond ? "PASS" : "FAIL") + "  " + label);
    if (!cond) ok = false;
  }
  console.log("quotes before stop:", window.getBotUniverseQuotes().length, JSON.stringify(window.getBotUniverseQuotes()[0] || null).slice(0, 80));
  let stopErr = null;
  let pinnedPosition = false;
  let stalePositionWatcher = false;
  try {
    // Exercise the real deadline path: it must safety-close any residual
    // positions before marking the run stopped.
    if (window.botState.running && window.stopBot) {
      const safetyQuote = window.getBotUniverseQuotes().find(q => Number(q.price || 0) > 0);
      if (safetyQuote && window.executeBotBuy) {
        window.executeBotBuy("normal", {
          symbol: safetyQuote.symbol,
          price: safetyQuote.price,
          setupType: "deadline-safety-test",
          stopLossPct: 1,
          takeProfitPct: 1,
          trailPct: 0.5,
        }, 1000, "deadline safety fixture");
        window.renderBotStatus?.();
        pinnedPosition = Boolean(doc.querySelector('#bot-swarm-normal [data-position-watch="true"]'));

        // Freeze the quote long enough to cross the stale-feed threshold. An
        // existing position must remain monitored and marked as stale instead
        // of disappearing from the swarm.
        const staleLimit = Number(window.BOT_STALE_TICK_LIMIT || 20);
        const normalWorker = window.tradingBots?.normal?.worker;
        if (normalWorker) {
          for (let i = 0; i <= staleLimit + 2; i += 1) {
            await normalWorker.evaluate({ ...safetyQuote });
          }
          const watched = window.botState.modes.normal.positions[safetyQuote.symbol];
          stalePositionWatcher = Boolean(
            watched?.lastSwarm?.feedStale
            && Number(watched.lastSwarm.staleTickCount || 0) > staleLimit,
          );
        }
      }
      window.botState.stopAt = Date.now() - 1;
      window.stopBot("run duration completed");
    }
  } catch (e) { stopErr = e; }
  const residual = Object.values(window.botState.modes)
    .reduce((count, state) => count + Object.values(state.positions || {})
      .filter(position => Number(position.qty || 0) > 0).length, 0);
  console.log("deadline stop done, err:", stopErr ? stopErr.message : "none", "residual positions:", residual);
  const safetySells = window.botState.modes.normal.trades.filter(t => t.side === "SELL" && String(t.reason || "").includes("run safety close"));
  const safetyPass = residual === 0 && safetySells.length > 0;
  console.log((safetyPass ? "PASS" : "FAIL") + "  deadline safety close leaves no positions stuck");
  console.log((pinnedPosition ? "PASS" : "FAIL") + "  open position is pinned in the swarm watcher");
  console.log((stalePositionWatcher ? "PASS" : "FAIL") + "  stale feed keeps an open position under watch");
  let polymarketWarmupClean = false;
  let polymarketBought = false;
  let polymarketFlat = false;
  let polymarketSwarmsReady = false;
  let polymarketIndependent = false;
  let polymarketSessionAligned = false;
  let polymarketChartVisible = false;
  let polymarketActionsVisible = false;
  let polymarketGenericHidden = false;
  try {
    const strategy = doc.querySelector("#bot-strategy-mode");
    const interval = doc.querySelector("#polymarket-interval");
    if (strategy && interval) {
      strategy.value = "polymarket";
      interval.value = "5m";
      strategy.dispatchEvent(new window.Event("change", { bubbles: true }));
      window.botState.stopAt = Date.now() + 60000;
      doc.querySelector("#bot-start")?.click();
      await new Promise(r => setTimeout(r, 1500));
      polymarketGenericHidden = [".bot-timeline", ".bot-run-bar", ".bot-overview", ".bot-modes-grid"]
        .every(selector => doc.querySelector(selector)?.classList.contains("hidden") === true);
      polymarketChartVisible = Boolean(
        doc.querySelector("#polymarket-market-card .poly-chart")
        && doc.querySelector("#polymarket-market-card .poly-contract-heading")
        && doc.querySelector("#polymarket-market-card .poly-outcome-board"),
      );
      polymarketActionsVisible = Boolean(
        doc.querySelector("#polymarket-clear-audit")
        && doc.querySelector("#polymarket-reset"),
      );
      polymarketWarmupClean = window.polymarketState.trades.length === 0;
      polymarketSessionAligned = window.polymarketState.sessionAligned === true
        && window.polymarketState.sessionSlug === "btc-updown-5m-test"
        && Math.abs(Number(window.botState.stopAt) - polyWindowEnd * 1000) < 1000;
      await new Promise(r => setTimeout(r, 4500));
      polymarketBought = window.polymarketState.trades.some(t => t.action === "BUY");
      const swarms = window.polymarketState.swarms || {};
      const swarmRows = ["calm", "normal", "aggressive"].map(mode => swarms[mode]).filter(Boolean);
      polymarketSwarmsReady = swarmRows.length === 3 && swarmRows.every(s => Number(s.capital) > 0 && Array.isArray(s.audit));
      polymarketIndependent = swarmRows.length === 3
        && swarmRows[0].trades !== swarmRows[1].trades
        && swarmRows[1].trades !== swarmRows[2].trades
        && swarmRows[0].audit !== swarmRows[2].audit;
      window.stopBot("polymarket test complete");
      polymarketFlat = !window.polymarketState.position;
    }
  } catch (e) { stopErr = stopErr || e; }
  console.log((polymarketWarmupClean ? "PASS" : "FAIL") + "  Polymarket warm-up blocks entries");
  console.log((polymarketSessionAligned ? "PASS" : "FAIL") + "  Polymarket session owns the stop clock");
  console.log((polymarketBought ? "PASS" : "FAIL") + "  Polymarket paper model enters on a tested probability edge");
  console.log((polymarketSwarmsReady ? "PASS" : "FAIL") + "  Polymarket has three independent swarm accounts");
  console.log((polymarketIndependent ? "PASS" : "FAIL") + "  Polymarket swarm state is not shared");
  console.log((polymarketChartVisible ? "PASS" : "FAIL") + "  Polymarket selected market renders chart and contract book");
  console.log((polymarketActionsVisible ? "PASS" : "FAIL") + "  Polymarket exposes clear-audit and reset controls");
  console.log((swarmPolyIsolation ? "PASS" : "FAIL") + "  Swarm mode keeps the Polymarket workspace hidden");
  console.log((polymarketGenericHidden ? "PASS" : "FAIL") + "  Polymarket mode hides the generic Swarm workspace");
  console.log((polymarketFlat ? "PASS" : "FAIL") + "  Polymarket paper mode closes positions cleanly");
  process.exit(ok && !stopErr && safetyPass && pinnedPosition && stalePositionWatcher && polymarketWarmupClean && polymarketSessionAligned && polymarketBought && polymarketSwarmsReady && polymarketIndependent && polymarketChartVisible && polymarketActionsVisible && swarmPolyIsolation && polymarketGenericHidden && polymarketFlat ? 0 : 1);
})().catch(e => { console.error("TEST ERROR", e); process.exit(1); });
