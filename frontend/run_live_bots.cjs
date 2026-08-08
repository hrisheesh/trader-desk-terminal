// run_live_bots.cjs — headless live run of all 3 bots against the real
// backend (:8000), $1000 each, crypto 24/7 universe.
// Writes a full report (state, trades, logs, learning, run audit, market
// snapshots) to /tmp/opencode/botrun/ and POSTs the run record to the backend.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const OUT_DIR = "/tmp/opencode/botrun";
// Keep ad-hoc validation runs short by default. Set BOT_DURATION_MIN
// explicitly for a longer paper session; the normal UI runtime is unchanged.
const DURATION_MIN = Number(process.env.BOT_DURATION_MIN) || 5;
const OBSERVE_MIN = Number(process.env.BOT_OBSERVE_MIN) || 2;
const RUN_CAPITAL = Math.max(1, Number(process.env.BOT_CAPITAL) || 1000);
const MULTIPLIER_ENABLED = String(process.env.BOT_MULTIPLIER || "false").toLowerCase() === "true";
const STRATEGY_MODE = process.env.BOT_STRATEGY_MODE === "polymarket" ? "polymarket" : "swarm";
const POLY_INTERVAL = process.env.BOT_POLY_INTERVAL === "5m" ? "5m" : "15m";
const RUN_WINDOW_MS = (Number(process.env.BOT_RUN_SECONDS) || DURATION_MIN * 60 + 20) * 1000;
const SAMPLE_MS = 10000;
const QUOTE_SNAPSHOT_MS = 30000;
const API = "http://127.0.0.1:8000";

fs.mkdirSync(OUT_DIR, { recursive: true });

const html = fs.readFileSync("index.html", "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost:8080/" });
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

// ---- real fetch -> local backend ----
window.fetch = (url, opts) => {
  let u = String(url);
  if (u.startsWith("/")) u = API + u;
  return global.fetch(u, opts);
};

// ---- seed: clean slate, configurable paper capital, crypto universe ----
window.localStorage.setItem("trader-desk-bot-config-v3", JSON.stringify({
  durationMin: DURATION_MIN,
  observeMinutes: OBSERVE_MIN,
  strategyMode: STRATEGY_MODE,
  polymarketInterval: POLY_INTERVAL,
  polymarketCapital: RUN_CAPITAL,
  polymarketModes: { calm: RUN_CAPITAL, normal: RUN_CAPITAL, aggressive: RUN_CAPITAL },
  universeMode: "crypto",
  multiplierEnabled: MULTIPLIER_ENABLED,
  modes: { calm: { capital: RUN_CAPITAL }, normal: { capital: RUN_CAPITAL }, aggressive: { capital: RUN_CAPITAL } },
}));
window.localStorage.removeItem("trader-desk-bot-learning-v1");
window.localStorage.removeItem("trader-desk-bot-state-v4");
window.localStorage.removeItem("trader-desk-bot-runs-v1");

// ---- load real scripts in index.html order ----
for (const file of ["bots/LearningEngine.js", "bots/SwarmWorker.js", "bots/BotBase.js", "bots/CalmBot.js", "bots/NormalBot.js", "bots/AggressiveBot.js", "bots/PolymarketSwarmEngine.js", "app.js"]) {
  try {
    window.eval(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`EVAL FAIL ${file}:`, e.message);
    process.exit(1);
  }
}

// ---- configure the DOM form (startBot -> readBotConfig reads these) ----
const setVal = (sel, v) => { const el = doc.querySelector(sel); if (el) el.value = String(v); };
setVal("#bot-duration", DURATION_MIN);
setVal("#bot-observe", OBSERVE_MIN);
setVal("#bot-capital-calm", RUN_CAPITAL);
setVal("#bot-capital-normal", RUN_CAPITAL);
setVal("#bot-capital-aggressive", RUN_CAPITAL);
const uni = doc.querySelector("#bot-universe-mode");
if (uni) uni.value = "crypto";
const multiplierToggle = doc.querySelector("#bot-multiplier-enabled");
if (multiplierToggle) multiplierToggle.checked = MULTIPLIER_ENABLED;
const strategyMode = doc.querySelector("#bot-strategy-mode");
if (strategyMode) strategyMode.value = STRATEGY_MODE;
const polyInterval = doc.querySelector("#polymarket-interval");
if (polyInterval) polyInterval.value = POLY_INTERVAL;
const polyCapital = doc.querySelector("#polymarket-capital");
if (polyCapital) polyCapital.value = RUN_CAPITAL;
for (const mode of ["calm", "normal", "aggressive"]) setVal(`#polymarket-capital-${mode}`, RUN_CAPITAL);

const errors = [];
window.addEventListener("error", (e) => errors.push(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => errors.push("unhandledrejection: " + (e.reason && e.reason.message || String(e.reason))));

const modes = ["calm", "normal", "aggressive"];
function snapshot(ts) {
  const s = { ts: new Date().toISOString(), elapsedSec: Math.round(ts / 1000) };
  s.modes = {};
  for (const mode of modes) {
    const st = window.botState.modes[mode];
    const pos = Object.entries(st.positions).filter(([, p]) => Number(p.qty || 0) > 0).length;
    s.modes[mode] = {
      decisions: st.decisions,
      trades: st.trades.length,
      buys: st.trades.filter(t => t.side === "BUY").length,
      sells: st.trades.filter(t => t.side === "SELL").length,
      openPositions: pos,
      realized: Number(st.realized || 0).toFixed(2),
      totalValue: Number((window.botPortfolioSnapshot ? window.botPortfolioSnapshot(mode, null) : {}).totalValue || 0).toFixed(2),
    };
  }
  s.reasons = {};
  for (const mode of modes) {
    const logs = window.botState.modes[mode].logs || [];
    s.reasons[mode] = logs.length ? String(logs[logs.length - 1].reason || "").slice(0, 80) : "";
  }
  if (STRATEGY_MODE === "polymarket" && window.polymarketState) {
    const swarms = Object.fromEntries(Object.entries(window.polymarketState.swarms || {}).map(([mode, st]) => [mode, {
      decisions: st.decisions,
      trades: st.trades.length,
      buys: st.trades.filter(t => t.action === "BUY").length,
      sells: st.trades.filter(t => t.action === "SELL" || t.action === "SETTLE").length,
      realized: Number(st.realized || 0).toFixed(4),
      open: Boolean(st.position),
      decision: st.lastDecision || "",
    }]));
    s.polymarket = {
      trades: window.polymarketState.trades.length,
      realized: Number(window.polymarketState.realized || 0).toFixed(4),
      open: Boolean(window.polymarketState.position),
      decision: window.polymarketState.lastDecision || "",
      swarms,
    };
  }
  return s;
}

async function fetchUniverseQuotes() {
  // Reuse the app's latest desk snapshot. Fetching the full crypto universe a
  // second time for reporting only adds upstream pressure during a long run.
  return (window.getBotUniverseQuotes ? window.getBotUniverseQuotes() : [])
    .filter(q => Number(q.price || 0) > 0);
}

(async () => {
  await new Promise(r => setTimeout(r, 3000));
  const startBtn = doc.querySelector("#bot-start");
  if (!startBtn) { console.error("FAIL: no #bot-start button"); process.exit(1); }
  startBtn.click();
  console.log("STARTED", new Date().toISOString(), "running:", window.botState.running);
  fs.writeFileSync(path.join(OUT_DIR, "started.json"), JSON.stringify({
    startedAt: new Date().toISOString(),
    config: window.botConfig,
    universeCount: (window.botUniverseSymbols ? window.botUniverseSymbols().length : 0),
  }, null, 2));

  const startedAt = Date.now();
  const samples = [];
  let nextSample = SAMPLE_MS;
  let nextQuote = QUOTE_SNAPSHOT_MS;
  let quoteIdx = 0;

  while (Date.now() - startedAt < RUN_WINDOW_MS) {
    await new Promise(r => setTimeout(r, 5000));
    const ts = Date.now() - startedAt;
    if (ts >= nextSample) {
      samples.push(snapshot(ts));
      nextSample += SAMPLE_MS;
    }
    if (ts >= nextQuote) {
      quoteIdx += 1;
      const q = await fetchUniverseQuotes();
      const live = q.filter(x => Number(x.price || 0) > 0);
      fs.writeFileSync(path.join(OUT_DIR, `quotes_${quoteIdx}.json`), JSON.stringify({ ts: new Date().toISOString(), elapsedSec: Math.round(ts / 1000), count: live.length, quotes: live }, null, 0));
      nextQuote += QUOTE_SNAPSHOT_MS;
    }
  }

  // End the headless paper session before taking the final report snapshot so
  // the report reflects the real stopped/flat state instead of a still-running
  // in-memory engine that is about to be stopped a few lines later.
  try { if (window.botState.running && window.stopBot) window.stopBot("run complete"); } catch (e) { console.log("stop error", e.message); }

  // ---- final capture ----
  const final = {
    endedAt: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    errors,
    config: window.botConfig,
    states: Object.fromEntries(modes.map(mode => [mode, window.botState.modes[mode]])),
    polymarket: window.polymarketState || null,
    learning: STRATEGY_MODE === "polymarket"
      ? (window.polymarketState?.learning || null)
      : (window.botLearning ? window.botLearning.serialize() : null),
    activeRun: window.activeBotRun || null,
    samples,
  };
  const flatAtDeadline = modes.every(mode => Object.values(window.botState.modes[mode].positions || {})
    .every(position => Number(position.qty || 0) <= 0))
    && !window.polymarketState?.position;
  fs.writeFileSync(path.join(OUT_DIR, "final.json"), JSON.stringify(final, null, 2));

  // pretty summary
  console.log("\n===== FINAL SNAPSHOT =====");
  for (const mode of modes) {
    const st = window.botState.modes[mode];
    const buy = st.trades.filter(t => t.side === "BUY");
    const sell = st.trades.filter(t => t.side === "SELL");
    console.log(`[${mode}] decisions=${st.decisions} buys=${buy.length} sells=${sell.length} realized=$${Number(st.realized || 0).toFixed(2)} open=${Object.keys(st.positions).filter(s => Number(st.positions[s].qty || 0) > 0).length}`);
  }
  const learned = STRATEGY_MODE === "polymarket"
    ? Object.fromEntries(Object.entries(window.polymarketState?.swarms || {}).map(([mode, state]) => [mode, state.learning || {}]))
    : (window.botLearning ? window.botLearning.serialize().modes : {});
  for (const mode of modes) {
    const l = learned[mode] || {};
    console.log(`[${mode}] learning: trades=${l.trades} win=${l.winRate != null ? (l.winRate * 100).toFixed(0) + "%" : "n/a"} kelly=${l.kelly != null ? (l.kelly * 100).toFixed(0) + "%" : "n/a"} minEdge=${l.minEdge}`);
  }
  if (STRATEGY_MODE === "polymarket" && window.polymarketState) {
    const p = window.polymarketState;
    console.log(`[polymarket] interval=${p.interval} trades=${p.trades.length} realized=$${Number(p.realized || 0).toFixed(2)} open=${p.position ? "yes" : "no"}`);
    console.log(`[polymarket] last decision: ${p.lastDecision || "n/a"}`);
  }
  console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
  console.log("flat at deadline:", flatAtDeadline ? "yes" : "NO — residual positions remain");

  console.log("REPORT written to", OUT_DIR);
  process.exit(errors.length === 0 && flatAtDeadline ? 0 : 1);
})().catch(e => { console.error("RUNNER ERROR", e); process.exit(1); });
