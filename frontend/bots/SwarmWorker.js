// =====================================================================
// SwarmWorker — the deep-research layer of the trading bot system.
//
// Each bot boss owns a SwarmWorker that spawns one independent research
// agent per symbol it watches. Every agent behaves like a junior analyst:
// it maintains its own price memory, computes microstructure + technical
// indicators (EMA/MACD/Bollinger/RSI/z-score/day-range/L2 imbalance),
// classifies the setup and market regime, and accumulates a "watch
// verdict" during the observe phase. The boss only trades symbols whose
// verdict passes its personality's bar — and only after the watch phase.
// =====================================================================

function botIndicators(prices) {
  // ---- Exponential moving average ----
  function ema(values, period) {
    if (!values.length) return null;
    const multiplier = 2 / (period + 1);
    const start = Math.min(period, values.length);
    let result = values.slice(0, start).reduce((sum, v) => sum + v, 0) / start;
    for (let i = start; i < values.length; i += 1) {
      result = (values[i] - result) * multiplier + result;
    }
    return result;
  }

  // ---- Simple moving average (VWAP proxy without volume data) ----
  function sma(values, period) {
    if (!values.length) return null;
    const slice = values.slice(-period);
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  }

  function stdDev(values, period) {
    const slice = values.slice(-period);
    if (slice.length < 2) return 0;
    const mean = slice.reduce((sum, v) => sum + v, 0) / slice.length;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / slice.length;
    return Math.sqrt(variance);
  }

  const last = prices[prices.length - 1];
  const emaFast = ema(prices, 8);
  const emaSlow = ema(prices, 21);
  const macdLine = emaFast !== null && emaSlow !== null ? emaFast - emaSlow : null;
  const bbMid = sma(prices, 20);
  const bbDev = stdDev(prices, 20);
  const bbUpper = bbMid !== null ? bbMid + 2 * bbDev : null;
  const bbLower = bbMid !== null ? bbMid - 2 * bbDev : null;
  const bbWidthPct = bbMid && bbMid > 0 ? (2 * bbDev / bbMid) * 100 : 0;

  return {
    ema8: emaFast,
    ema21: emaSlow,
    emaRise: emaFast !== null && emaSlow !== null ? emaFast > emaSlow : false,
    macdLine,
    macdHist: macdLine,
    bbUpper,
    bbLower,
    bbMid,
    bbWidthPct,
    bbZ: bbMid && bbDev > 0 ? (last - bbMid) / bbDev : 0,
  };
}

// Unclamped realized volatility of the live tick stream: std of per-tick
// returns over a SHORT window (last ~10 live ticks). This is the local noise
// floor every decision is measured against (HFT-style: judge the move against
// the tape's own recent noise, not against a fixed percentage). A short window
// keeps it responsive to the current regime and avoids a slow-drifting market
// (e.g. a gentle sine) inflating the "noise" with its own trend.
function botLiveVolatility(memory) {
  const prices = [];
  for (let i = 0; i < memory.length; i += 1) {
    if (memory[i] && memory[i].ticked) prices.push(Number(memory[i].price) || 0);
  }
  if (prices.length < 6) return null;
  const returns = [];
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i - 1] > 0) returns.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  }
  if (returns.length < 6) return null;
  const recent = returns.slice(-10);
  const mean = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const variance = recent.reduce((sum, v) => sum + ((v - mean) ** 2), 0) / recent.length;
  return Math.sqrt(variance);
}

// How many "noise sigmas" the recent 4-tick move spans. shortMomentumPct is
// measured over 4 ticks, so a random-walk 1-sigma move is liveVol * sqrt(4).
function botMoveZ(context) {
  const shortMom = Number(context.shortMomentumPct || 0);
  const liveVol = Number(context.liveVolPct || 0.05);
  return shortMom / Math.max(0.01, liveVol * 2);
}

function botClassifySetup(context) {
  const zScore = Number(context.zScore || 0);
  const rsiProxy = Number(context.rsiProxy || 50);
  const moveZ = Number(context.moveZ || 0);
  const momZ = Number(context.momZ || 0);
  const volatilityPct = Number(context.volatilityPct || 0);
  const noisePct = Number(context.noisePct || 0);
  const resistanceDistancePct = Number(context.resistanceDistancePct || 99);
  const agreement = Number(context.agreement || 0);
  const dayRangePos = Number(context.dayRangePos || 0.5);
  const emaRise = !!context.emaRise;

  // DEMO-MODE thresholds (relaxed so the bots trade a quiet tape). Revert to
  // the tighter bars for production: breakout moveZ>2.0, momentum moveZ>1.1,
  // reversion z<-1.5/momZ<-1.2/rsi<45, trend momZ>1.0, chop |moveZ|<0.5.
  // Breakout: violent move through resistance near the day high.
  if (moveZ > 1.2 && rsiProxy > 52 && (dayRangePos > 0.7 || resistanceDistancePct < 2.5)) return "breakout";
  // Momentum: accelerating push with rising EMAs.
  if (moveZ > 0.65 && emaRise && rsiProxy > 45) return "momentum";
  // Reversion: genuine oversold dislocation (beyond ~1 sigma of the window)
  // with a real window drawdown relative to noise. The micro-direction/turn
  // is enforced by the personality conviction, not here.
  if (zScore < -0.95 && momZ < -0.65 && rsiProxy < 54) return "reversion";
  // Pullback: dip inside an uptrend (window up, short-term soft, not dislocated).
  if (emaRise && momZ > 0.5 && zScore > -1.0 && zScore < 0.5 && moveZ < 1.0) return "pullback";
  // Trend: steady directional drift above the noise floor.
  if (momZ > 0.45 && changePercentSane(context) && emaRise) return "trend";
  // Alt-breakout: pinned at the day high with a strong short-term push.
  if (dayRangePos > 0.8 && moveZ > 1.0) return "breakout";
  // Chop: the recent move is inside the noise floor, or pure chaos.
  if (Math.abs(moveZ) < 0.3 || (volatilityPct > 6 && noisePct > 4)) return "chop";
  return "unknown";
}

function changePercentSane(context) {
  const value = Number(context.changePercent || 0);
  return value > -0.5 && value < 12;
}

function botRegimeLabel(context) {
  const volatilityPct = Number(context.volatilityPct || 0);
  const noisePct = Number(context.noisePct || 0);
  const moveZ = Number(context.moveZ || 0);
  if (volatilityPct > 3.2 && noisePct > 2.2) return "chaotic";
  if (Math.abs(moveZ) > 1.5 && noisePct < volatilityPct * 0.85) return "trending";
  if (Math.abs(moveZ) < 0.6) return "ranging";
  return "transitional";
}

// Watch verdict direction from accumulated micro-evidence + technicals.
// All thresholds are expressed in noise sigmas (moveZ/momZ) so a quiet tape
// with a real relative move registers the same as a wild tape.
function botVerdictDirection(context) {
  if (Number(context.samples || 0) < Number(context.minSamples || 5)) return { direction: "neutral", confidence: 0 };

  const moveZ = Number(context.moveZ || 0);
  const momZ = Number(context.momZ || 0);
  const zScore = Number(context.zScore || 0);
  const rsiProxy = Number(context.rsiProxy || 50);
  const agreement = Number(context.agreement || 0);
  const l2Imbalance = Number(context.l2Imbalance || 0);
  const noisePct = Number(context.noisePct || 0);
  const setupType = context.setupType || "unknown";
  const regime = context.regime || "transitional";

  let score = 0;
  // Trend evidence (sigma-normalized).
  if (moveZ > 0.8) score += 1; else if (moveZ < -0.8) score -= 1;
  if (momZ > 0.6) score += 1; else if (momZ < -0.6) score -= 1;
  if (context.emaRise) score += 1; else if (context.ema8 !== null && context.ema21 !== null) score -= 1;
  // Mean-reversion evidence (fade oversold / overbought).
  if (zScore < -1.5 && rsiProxy < 45) score += 1.5;
  if (zScore > 1.5 && rsiProxy > 65) score -= 1.5;
  // Microstructure agreement.
  score += clampAgree(agreement) * 1.2;
  if (l2Imbalance > 5) score += 1; else if (l2Imbalance < -5) score -= 1;
  // Only extreme chaos is discounted now; ordinary noise is already priced in
  // via the sigma normalization.
  if (noisePct > 4) score *= 0.6;

  if (regime === "chaotic") score *= 0.4;

  let direction = "neutral";
  if (score >= 2) direction = "bullish";
  else if (score <= -2) direction = "bearish";

  const confidence = Math.min(95, Math.round(Math.abs(score) * 18 + (setupType !== "unknown" && setupType !== "chop" ? 12 : 0)));
  return { direction, confidence, rawScore: score };
}

function clampAgree(value) {
  return Math.min(1, Math.max(-1, Number(value) || 0));
}

// CoT/rCoT-style reasoning trail. Deterministic evidence composition that
// reads like an analyst's notes: what was observed -> classification ->
// verdict -> what would falsify it. Kept cheap (no LLM), used in audit logs.
function botReasoningChain(context) {
  const liveVolPct = Number(context.liveVolPct || 0).toFixed(3);
  const moveZ = Number(context.moveZ || 0);
  const momZ = Number(context.momZ || 0);
  const zScore = Number(context.zScore || 0);
  const rsi = Number(context.rsiProxy || 50);
  const chain = [];
  chain.push(`tape vol ${liveVolPct}%/tick`);
  chain.push(`move ${moveZ >= 0 ? "+" : ""}${moveZ.toFixed(1)}σ (${Number(context.shortMomentumPct || 0) >= 0 ? "+" : ""}${Number(context.shortMomentumPct || 0).toFixed(2)}%/4t)`);
  chain.push(`window ${momZ >= 0 ? "+" : ""}${momZ.toFixed(1)}σ (${Number(context.momentumPct || 0) >= 0 ? "+" : ""}${Number(context.momentumPct || 0).toFixed(2)}%)`);
  chain.push(`z ${zScore.toFixed(2)} | rsi ${rsi.toFixed(0)} | ${context.emaRise ? "EMA↑" : "EMA↓"}`);
  if (context.signalAction && context.signalAction !== "Hold") chain.push(`signal ${context.signalAction} ${Number(context.signalConfidence || 0).toFixed(0)}%`);
  if (Number(context.l2Imbalance || 0)) chain.push(`book ${Number(context.l2Imbalance || 0) >= 0 ? "+" : ""}${Number(context.l2Imbalance || 0).toFixed(0)}`);
  chain.push(`=> ${context.setupType}/${context.regime}`);
  chain.push(`verdict ${context.verdict ? context.verdict.direction + "/" + context.verdict.confidence : "neutral"}`);

  // rCoT: adversarial scenario that would break the thesis.
  let reverse = "none";
  const dir = context.verdict ? context.verdict.direction : "neutral";
  if (dir === "bullish") reverse = "breaks if moveZ drops <0.5σ or book flips sell";
  else if (dir === "bearish") reverse = "breaks if moveZ rebounds >0.5σ or book flips buy";
  else if (context.setupType === "reversion") reverse = "breaks if price keeps breaking below the dip low";
  else if (context.setupType === "chop" || context.setupType === "unknown") reverse = "no thesis — no trade";
  else reverse = "breaks if momentum stalls and EMAs flatten";

  return { chain, reverseCheck: reverse, summary: chain.join(" | ") };
}

// One independent research agent for a single symbol.
class SymbolResearchAgent {
  constructor(mode, symbol) {
    this.mode = mode;
    this.symbol = symbol;
    this.memory = [];
    this.verdict = { direction: "neutral", confidence: 0, reason: "accumulating", sampleCount: 0 };
    this.upTicks = 0;
    this.downTicks = 0;
    this.observedAt = 0;
  }

  push(price) {
    if (this.memory.length && this.memory[this.memory.length - 1].price === price) {
      // Track same-price ticks for staleness filtering; still keep count.
      this.memory.push({ price, time: Date.now(), ticked: false });
    } else {
      const last = this.memory[this.memory.length - 1];
      if (last) {
        if (price > last.price) this.upTicks += 1;
        else if (price < last.price) this.downTicks += 1;
      }
      this.memory.push({ price, time: Date.now(), ticked: true });
    }
    if (this.memory.length > 500) this.memory.shift();
    this.observedAt = Date.now();
  }

  sampleCount() {
    return this.memory.length;
  }

  // Count of consecutive ticks with no price change (frozen-feed guard).
  staleTickCount() {
    let count = 0;
    for (let i = this.memory.length - 1; i >= 0; i -= 1) {
      if (!this.memory[i].ticked) count += 1;
      else break;
    }
    return count;
  }
}

class SwarmWorker {
  constructor(mode) {
    this.mode = mode;
    this.swarms = {}; // symbol -> SymbolResearchAgent
  }

  swarmCount() {
    return Object.keys(this.swarms).length;
  }

  // Each symbol gets its own independent analyst.
  agentFor(symbol) {
    if (!this.swarms[symbol]) this.swarms[symbol] = new SymbolResearchAgent(this.mode, symbol);
    return this.swarms[symbol];
  }

  research(symbol) {
    const agent = this.swarms[symbol];
    return agent ? { ...agent.verdict, symbol } : { direction: "neutral", confidence: 0, symbol };
  }

  reset(symbol) {
    if (symbol) delete this.swarms[symbol];
    else this.swarms = {};
  }

  async evaluate(quote) {
    // HFT-style simulated think time: tiny, bounded, non-blocking.
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 2)));

    const price = Number(quote.price || 0);
    if (!price || price < 0.001) return null;

    const agent = this.agentFor(quote.symbol);
    agent.push(price);

    const staleLimit = Number(window.BOT_STALE_TICK_LIMIT || 20);
    const staleTickCount = agent.staleTickCount();
    const heldQty = window.botHeldQuantity(this.mode, quote.symbol);
    const feedStale = staleTickCount > staleLimit;
    // Do not open new positions on a frozen quote, but keep an existing
    // position alive in the risk manager so time stops and last-price stops
    // still run while the feed recovers.
    if (feedStale && heldQty <= 0) return null;

    if (window.rememberBotPrice) window.rememberBotPrice(this.mode, quote.symbol, price);
    const history = window.botState.modes[this.mode].priceMemory[quote.symbol] || [];
    const stats = window.botHistoryStats(history, price);
    const indicators = botIndicators(history.map(item => Number(item.price || 0)).filter(Boolean));
    const signal = window.botSignalFor(quote.symbol);
    const entry = window.botAverageEntry(this.mode, quote.symbol);
    const changePercent = Number(quote.changePercent ?? quote.change_percent ?? 0);
    const dayHigh = Number(quote.high || price);
    const dayLow = Number(quote.low || price);
    const dayRange = dayHigh > dayLow ? dayHigh - dayLow : 0;
    const dayRangePos = dayRange > 0 ? (price - dayLow) / dayRange : 0.5;
    const dayRangePct = dayHigh > price ? ((dayHigh - dayLow) / price) * 100 : 0;
    const pnlPct = heldQty && entry ? ((price - entry) / entry) * 100 : 0;

    let highWaterPrice = 0;
    let drawdownFromHighPct = 0;
    if (heldQty > 0) {
      const pos = window.botState.modes[this.mode].positions[quote.symbol];
      if (pos) {
        if (!pos.highWaterPrice || price > pos.highWaterPrice) pos.highWaterPrice = price;
        highWaterPrice = pos.highWaterPrice;
        drawdownFromHighPct = ((highWaterPrice - price) / highWaterPrice) * 100;
      }
    }

    const signalConfidence = Number(signal?.confidence || 50);
    const signalAction = signal?.action || "Hold";
    const l2Data = window.botAnalyzeOrderBook ? window.botAnalyzeOrderBook(quote.symbol) : { bidVol: 0, askVol: 0, imbalance: 0 };

    const context = {
      symbol: quote.symbol,
      price,
      changePercent,
      dayHigh,
      dayLow,
      dayRangePct,
      dayRangePos,
      dayHighDistancePct: dayHigh > price ? ((dayHigh - price) / price) * 100 : 0,
      dayLowDistancePct: price > dayLow ? ((price - dayLow) / price) * 100 : 0,
      signalAction,
      signalConfidence,
      heldQty,
      entry,
      pnlPct,
      highWaterPrice,
      drawdownFromHighPct,
      openedAt: window.botState.modes[this.mode].positions[quote.symbol]?.openedAt || 0,
      l2Imbalance: l2Data.imbalance,
      l2BidVol: l2Data.bidVol,
      l2AskVol: l2Data.askVol,
      spreadPct: quote.bid && quote.ask ? ((quote.ask - quote.bid) / price) * 100 : 0,
      feedStale,
      staleTickCount,
      ...stats,
      ...indicators,
      minSamples: window.BOT_MIN_SWARM_SAMPLES || 5,
    };

    // Live noise floor (unclamped) + sigma-normalized moves. This is the
    // volatility-relative core that lets bots trade quiet tapes with real
    // relative edge and ignore wild-tape noise.
    const liveVolPct = botLiveVolatility(agent.memory) || Math.max(0.02, Number(context.volatilityPct || 0.05));
    context.liveVolPct = liveVolPct;
    context.moveZ = botMoveZ(context);
    const windowBars = Math.max(1, Math.min(30, Math.max(1, Number(context.samples || 1) - 1)));
    context.momZ = Number(context.momentumPct || 0) / Math.max(0.01, liveVolPct * Math.sqrt(windowBars));

    // Local low / high tracking for reversion bounce confirmation and
    // breakout strength: how many ticks since price last set its recent low.
    const recentTicked = agent.memory.filter(m => m && m.ticked).slice(-12);
    let localLow = Infinity;
    let localLowIdx = 0;
    recentTicked.forEach((m, i) => {
      const p = Number(m.price || 0);
      if (p < localLow) { localLow = p; localLowIdx = i; }
    });
    context.localLow = Number.isFinite(localLow) ? localLow : price;
    context.ticksSinceLow = recentTicked.length ? recentTicked.length - 1 - localLowIdx : 0;
    context.localLowDistancePct = context.localLow > 0 ? ((price - context.localLow) / context.localLow) * 100 : 0;

    context.agreement = window.botMarketAgreement(context);
    context.regime = botRegimeLabel(context);
    context.setupType = botClassifySetup(context);

    const verdict = botVerdictDirection(context);
    if (verdict.direction !== "neutral") {
      agent.verdict = { direction: verdict.direction, confidence: verdict.confidence, reason: `${context.setupType}/${context.regime}`, sampleCount: agent.sampleCount() };
    } else {
      agent.verdict = { ...agent.verdict, sampleCount: agent.sampleCount() };
    }
    context.verdict = agent.verdict;

    // CoT reasoning trail: ordered evidence chain + adversarial reverse-check,
    // surfaced in the audit logs so every decision shows its "why".
    context.reasoning = botReasoningChain(context);

    if (heldQty > 0) {
      const position = window.botState.modes[this.mode].positions[quote.symbol];
      if (position) {
        position.lastSwarm = {
          direction: context.verdict?.direction || "neutral",
          confidence: Number(context.verdict?.confidence || 0),
          setupType: context.setupType,
          regime: context.regime,
          feedStale,
          staleTickCount,
          momentumZ: Number(context.momZ || 0),
          moveZ: Number(context.moveZ || 0),
          shortMomentumPct: Number(context.shortMomentumPct || 0),
          signalAction: context.signalAction || "Hold",
          summary: context.reasoning.summary,
          reverseCheck: context.reasoning.reverseCheck,
          updatedAt: Date.now(),
        };
      }
    }

    return this.applyModeWeights(context);
  }

  applyModeWeights(context) {
    const clamp = window.clamp;
    const momentumPct = Number(context.momentumPct || 0);
    const shortMomentumPct = Number(context.shortMomentumPct || 0);
    const changePercent = Number(context.changePercent || 0);
    const agreement = Number(context.agreement || 0);
    const l2Imbalance = Number(context.l2Imbalance || 0);
    const noisePct = Number(context.noisePct || 0);
    const dayRangePos = Number(context.dayRangePos || 0.5);
    const rsiProxy = Number(context.rsiProxy || 50);
    const zScore = Number(context.zScore || 0);
    const bbWidthPct = Number(context.bbWidthPct || 0);

    // Personality-tuned composite quality. Each mode weights evidence its
    // own way, so the three bosses genuinely disagree about what is good.
    let trendQuality;
    if (this.mode === "calm") {
      trendQuality = clamp(
        (shortMomentumPct * 6) + (changePercent * 2) + (agreement * 22) + (l2Imbalance * 5) - (noisePct * 8) - (bbWidthPct * 2.2),
        -45, 55);
    } else if (this.mode === "aggressive") {
      trendQuality = clamp(
        (shortMomentumPct * 16) + (momentumPct * 10) + (changePercent * 4) + (agreement * 10) + (l2Imbalance * 4) + (dayRangePos > 0.8 ? 8 : 0) - (noisePct * 1.5),
        -45, 55);
    } else {
      trendQuality = clamp(
        (shortMomentumPct * 10) + (momentumPct * 6) + (changePercent * 2) + (agreement * 16) + (l2Imbalance * 4) - (noisePct * 5),
        -45, 55);
    }

    // Risk load — same core, but personality multipliers differ.
    let riskLoad;
    if (this.mode === "calm") {
      // Wide bands / big range are reversion OPPORTUNITY, not risk, for calm.
      riskLoad = clamp((Number(context.volatilityPct || 0) * 11) + (Number(context.dayRangePct || 0) * 0.8) + Math.max(0, -shortMomentumPct) * 10 + (bbWidthPct * 1.2), 0, 100);
    } else if (this.mode === "aggressive") {
      riskLoad = clamp((Number(context.volatilityPct || 0) * 6) + (Number(context.dayRangePct || 0) * 1.1) + (noisePct * 2), 0, 100);
    } else {
      riskLoad = clamp((Number(context.volatilityPct || 0) * 8.5) + (Number(context.dayRangePct || 0) * 1.4) + Math.max(0, -shortMomentumPct) * 7, 0, 100);
    }

    const opportunity = clamp(50 + trendQuality - (riskLoad * 0.35), 0, 100);
    context.trendQuality = trendQuality;
    context.riskLoad = riskLoad;
    context.opportunity = opportunity;
    context.score = Math.round(opportunity);

    // Rank: personality-specific opportunity + momentum/liquidity tilt.
    if (this.mode === "calm") {
      context.rankScore = opportunity + (l2Imbalance * 8) - riskLoad - (Math.abs(zScore) < 1.5 ? 0 : 10);
    } else if (this.mode === "aggressive") {
      context.rankScore = opportunity + Math.max(0, shortMomentumPct) * 15 + Math.max(0, Number(context.volatilityPct || 0)) * 6 + (dayRangePos > 0.8 ? 12 : 0);
    } else {
      context.rankScore = opportunity + Math.max(0, shortMomentumPct) * 6 + Math.max(0, Number(context.resistanceDistancePct || 0)) * 0.5 + (context.emaRise ? 6 : 0);
    }

    return context;
  }
}

window.SwarmWorker = SwarmWorker;
window.botClassifySetup = botClassifySetup;
window.botRegimeLabel = botRegimeLabel;
window.botIndicators = botIndicators;
window.botVerdictDirection = botVerdictDirection;
window.botLiveVolatility = botLiveVolatility;
window.botMoveZ = botMoveZ;
window.botReasoningChain = botReasoningChain;
