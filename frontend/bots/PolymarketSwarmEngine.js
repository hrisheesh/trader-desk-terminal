// Independent paper-trading engine for the Polymarket BTC Up/Down windows.
// The three swarms share the same public feed, but never share capital,
// positions, decisions, or learning.
class PolymarketSwarmEngine {
  constructor(state) {
    this.state = state;
    this.defs = {
      // Polymarket contracts are binary. A large allocation can lose the
      // whole stake even when the BTC move was only briefly wrong, so the
      // swarms size the stake first and let the market decide the exit.
      calm: { label: "Calm", tone: "calm", minEdge: 0.055, confirmTicks: 2, minAllocation: 0.16, maxAllocation: 0.32, eventBufferSec: 90, lossCutPct: 8, maxEntries: 2, lossLockSec: 300 },
      normal: { label: "Normal", tone: "normal", minEdge: 0.05, confirmTicks: 2, minAllocation: 0.22, maxAllocation: 0.42, eventBufferSec: 75, lossCutPct: 9, maxEntries: 3, lossLockSec: 240 },
      aggressive: { label: "Aggressive", tone: "aggressive", minEdge: 0.045, confirmTicks: 2, minAllocation: 0.3, maxAllocation: 0.55, eventBufferSec: 60, lossCutPct: 11, maxEntries: 3, lossLockSec: 180 },
    };
    this.learningKey = "trader-desk-polymarket-learning-v2";
    this.loadLearning();
  }

  modes() { return Object.keys(this.defs); }

  configuredCapital(mode) {
    const input = document.querySelector(`#polymarket-capital-${mode}`);
    const value = Number(input?.value);
    return Number.isFinite(value) && value > 0 ? value : 100;
  }

  configuredEnabled(mode) {
    const input = document.querySelector(`#polymarket-enabled-${mode}`);
    return input ? input.checked !== false : true;
  }

  createSwarm(mode, capital, enabled = true) {
    const def = this.defs[mode];
    return {
      mode,
      label: def.label,
      tone: def.tone,
      capital,
      cash: capital,
      enabled,
      realized: 0,
      position: null,
      trades: [],
      audit: [],
      decisions: 0,
      lastAction: "WATCH",
      lastDecision: "Waiting for the active market window",
      lastModel: null,
      modelSide: null,
      modelSideCount: 0,
      lastExitAt: 0,
      entryCount: 0,
      windowSlug: null,
      lossLockSlug: null,
      lossLockUntil: 0,
      lastOpenReason: "",
      learning: this.state.learning?.swarms?.[mode] || { trades: 0, wins: 0, losses: 0, pnl: 0, bySide: {}, byEdge: {}, byWindow: {} },
    };
  }

  loadLearning() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.learningKey));
      if (saved?.swarms) this.state.learning = { ...(this.state.learning || {}), ...saved };
    } catch (error) {
      // A damaged learning record must not prevent a paper session starting.
    }
  }

  persistLearning() {
    try {
      localStorage.setItem(this.learningKey, JSON.stringify({ swarms: Object.fromEntries(this.modes().map(mode => [mode, this.state.swarms[mode].learning])) }));
    } catch (error) {}
  }

  start(config) {
    const sharedCapital = Math.max(1, Number(config.polymarketCapital || 100));
    const configured = config.polymarketModes || {};
    this.state.swarms = Object.fromEntries(this.modes().map(mode => {
      const capital = Math.max(1, Number(configured[mode] || sharedCapital));
      return [mode, this.createSwarm(mode, capital, config.enabled?.[mode] !== false)];
    }));
    this.state.running = true;
    this.state.startedAt = Date.now();
    // Polymarket owns the clock. The generic bot duration/watch controls are
    // intentionally ignored until the API gives us the active market window.
    // Use a safe sentinel while the first market snapshot is loading so a
    // stale generic deadline cannot stop the session early.
    this.state.stopAt = Number.MAX_SAFE_INTEGER;
    this.state.sessionAligned = false;
    this.state.sessionSlug = null;
    this.state.sessionEnd = null;
    botState.stopAt = this.state.stopAt;
    this.state.interval = config.polymarketInterval || "15m";
    this.state.capital = this.totalCapital();
    this.state.cash = this.totalCash();
    this.state.realized = 0;
    this.state.position = null;
    this.state.positions = {};
    this.state.trades = [];
    this.state.audit = [];
    this.state.history = [];
    this.state.latest = null;
    this.state.lastDecision = `Watching BTC ${this.state.interval} · three independent swarms warming up`;
    this.state.windowSeen = {};
    this.sync();
  }

  reset() {
    this.state.running = false;
    this.state.startedAt = null;
    this.state.stopAt = null;
    this.state.cash = 100;
    this.state.capital = 100;
    this.state.realized = 0;
    this.state.position = null;
    this.state.positions = {};
    this.state.swarms = {};
    this.state.trades = [];
    this.state.audit = [];
    this.state.history = [];
    this.state.latest = null;
    this.state.lastDecision = null;
    this.state.error = "";
    this.state.windowSeen = {};
    this.state.sessionAligned = false;
    this.state.sessionSlug = null;
    this.state.sessionEnd = null;
  }

  stop(reason = "stopped") {
    const latestMarkets = this.state.latest?.markets || [];
    this.modes().forEach(mode => {
      const swarm = this.state.swarms[mode];
      if (!swarm?.position) return;
      const market = latestMarkets.find(row => row.slug === swarm.position.slug);
      const outcome = market?.[swarm.position.side === "YES" ? "yes" : "no"] || {};
      const mark = Number(outcome.sellPrice ?? outcome.bid ?? swarm.position.lastMark ?? swarm.position.entryPrice);
      this.close(swarm, reason === "run duration completed" ? "Run safety close before deadline" : reason, mark, market);
    });
    this.state.running = false;
    this.state.stopAt = null;
    this.sync();
  }

  totalCapital() { return this.modes().reduce((sum, mode) => sum + (this.state.swarms[mode]?.enabled === false ? 0 : Number(this.state.swarms[mode]?.capital || 0)), 0); }
  totalCash() { return this.modes().reduce((sum, mode) => sum + (this.state.swarms[mode]?.enabled === false ? 0 : Number(this.state.swarms[mode]?.cash || 0)), 0); }
  totalRealized() { return this.modes().reduce((sum, mode) => sum + (this.state.swarms[mode]?.enabled === false ? 0 : Number(this.state.swarms[mode]?.realized || 0)), 0); }

  sync() {
    const swarms = this.modes().map(mode => this.state.swarms[mode]).filter(Boolean);
    const positions = {};
    swarms.forEach(swarm => { if (swarm.position) positions[swarm.mode] = swarm.position; });
    const trades = swarms.flatMap(swarm => swarm.trades.map(trade => ({ ...trade, swarm: swarm.mode })))
      .sort((a, b) => String(b.ts || b.time || "").localeCompare(String(a.ts || a.time || ""))).slice(0, 400);
    const audit = swarms.flatMap(swarm => swarm.audit.map(row => ({ ...row, swarm: swarm.mode })))
      .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, 1600);
    this.state.positions = positions;
    this.state.position = swarms.find(swarm => swarm.position)?.position || null;
    this.state.trades = trades;
    this.state.audit = audit;
    this.state.capital = this.totalCapital();
    this.state.cash = this.totalCash();
    this.state.realized = this.totalRealized();
    this.state.learning = {
      swarms: Object.fromEntries(swarms.map(swarm => [swarm.mode, swarm.learning])),
      trades: swarms.reduce((sum, swarm) => sum + swarm.learning.trades, 0),
      wins: swarms.reduce((sum, swarm) => sum + swarm.learning.wins, 0),
      losses: swarms.reduce((sum, swarm) => sum + swarm.learning.losses, 0),
      pnl: swarms.reduce((sum, swarm) => sum + swarm.learning.pnl, 0),
    };
    const latestDecision = swarms
      .slice()
      .sort((a, b) => Number(b.decisions || 0) - Number(a.decisions || 0))[0];
    if (latestDecision?.lastDecision) this.state.lastDecision = `${latestDecision.label}: ${latestDecision.lastDecision}`;
  }

  record(swarm, action, reason, market = null, extra = {}) {
    const row = {
      ts: new Date().toISOString(),
      elapsedSec: this.state.startedAt ? Math.round((Date.now() - this.state.startedAt) / 1000) : 0,
      action,
      mode: swarm.mode,
      interval: this.state.interval,
      slug: market?.slug || null,
      reason,
      ...extra,
    };
    swarm.audit.unshift(row);
    swarm.audit = swarm.audit.slice(0, 600);
    swarm.lastAction = action;
    swarm.lastDecision = reason;
  }

  edgeBucket(edge) {
    const value = Math.abs(Number(edge || 0));
    if (value >= 0.12) return "large";
    if (value >= 0.07) return "medium";
    return "small";
  }

  learnedEdge(swarm, edge) {
    const stats = swarm.learning.byEdge?.[this.edgeBucket(edge)];
    if (!stats || stats.n < 3) return 0;
    return clamp((stats.wins / stats.n - 0.5) * 2, -0.8, 0.8);
  }

  updateLearning(swarm, position, pnl, market) {
    const learning = swarm.learning;
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
    update(learning.bySide, position.side);
    update(learning.byEdge, this.edgeBucket(position.edge));
    update(learning.byWindow, market?.interval || position.interval || this.state.interval);
    this.persistLearning();
  }

  close(swarm, reason, exitPrice, market = null, action = "SELL") {
    const position = swarm.position;
    if (!position) return false;
    const price = exitPrice === null || exitPrice === undefined ? Number(position.lastMark || position.entryPrice || 0) : Number(exitPrice);
    if (!(price >= 0 && price <= 1)) return false;
    const proceeds = position.qty * price;
    const pnl = proceeds - position.cost;
    swarm.cash += proceeds;
    swarm.realized += pnl;
    this.updateLearning(swarm, position, pnl, market);
    swarm.trades.unshift({ ts: new Date().toISOString(), time: botNow(), action, side: position.side, slug: position.slug, qty: position.qty, price, notional: proceeds, pnl, reason });
    swarm.trades = swarm.trades.slice(0, 200);
    this.record(swarm, action, reason, market, { side: position.side, price, pnl });
    swarm.position = null;
    swarm.lastExitAt = Date.now();
    if (pnl < -0.000001) {
      const def = this.defs[swarm.mode];
      const windowEndMs = Number(position.windowEnd || 0) * 1000;
      swarm.lossLockSlug = position.slug;
      swarm.lossLockUntil = Math.max(windowEndMs, Date.now() + def.lossLockSec * 1000);
      swarm.lastOpenReason = `Loss lock active for this market after ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    }
    return true;
  }

  model(market, swarm) {
    const history = this.state.history;
    const feed = market.feed || this.state.latest?.spot || {};
    const price = Number(feed.price || 0);
    const lead = this.state.latest?.lead || {};
    const referencePrice = Number(market.reference?.price || 0);
    const remainingSeconds = Math.max(1, Number(market.secondsRemaining || 0));
    const spotAgeMs = Number(feed.ageMs);
    const spotSource = String(feed.source || "");
    const settlement = market.settlement || {};
    if (settlement.requiresExactTwap === true && settlement.exactFeedConnected !== true) {
      return { ready: false, reason: "Exact Chainlink 60s TWAP settlement feed is not connected — monitoring only" };
    }
    if (!(price > 0) || !(referencePrice > 0)) return { ready: false, reason: "Waiting for Chainlink price-to-beat" };
    if (market.anchorReady !== true) return { ready: false, reason: "Waiting for exact window-start price-to-beat" };
    if (settlement.requiresExactTwap === true && !spotSource.includes("Polymarket RTDS Chainlink BTC/USD")) {
      return { ready: false, reason: "Waiting for Polymarket's live Chainlink TWAP settlement report" };
    }
    if (Number.isFinite(spotAgeMs) && spotAgeMs > 5_000) return { ready: false, reason: `Chainlink stale (${Math.ceil(spotAgeMs / 1000)}s)` };
    if (history.length < 4) return { ready: false, reason: `Building live Chainlink evidence (${history.length}/4 samples)` };
    const points = history.slice(-90).filter(row => Number(row.price) > 0 && Number(row.time) > 0);
    const returns = [];
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const dt = clamp((Number(current.time) - Number(previous.time)) / 1000, 0.25, 10);
      const logReturn = Math.log(Number(current.price) / Number(previous.price));
      if (Number.isFinite(logReturn)) returns.push({ logReturn, dt });
    }
    if (returns.length < 3) return { ready: false, reason: "Waiting for live Chainlink movement" };
    const totalSeconds = returns.reduce((sum, row) => sum + row.dt, 0);
    const driftPerSecond = returns.reduce((sum, row) => sum + row.logReturn, 0) / Math.max(1, totalSeconds);
    const variancePerSecond = returns.reduce((sum, row) => sum + row.logReturn ** 2, 0) / Math.max(1, totalSeconds);
    const horizonVolFloor = 0.00055 * Math.sqrt(Math.max(60, remainingSeconds) / 300);
    const sigmaRemaining = Math.max(horizonVolFloor, Math.sqrt(variancePerSecond) * Math.sqrt(remainingSeconds));
    const moveFromReference = Math.log(price / referencePrice);
    const driftAdjustment = clamp(driftPerSecond * remainingSeconds * 0.08, -sigmaRemaining * 0.2, sigmaRemaining * 0.2);
    const leadMomentumPct = Number(lead.momentumPct10s);
    const leadFresh = lead.stale !== true && Number(lead.ageMs) <= 3_000;
    const leadBoost = leadFresh && Number.isFinite(leadMomentumPct)
      ? clamp(Math.log(Math.max(0.0001, 1 + leadMomentumPct / 100)) * 0.8, -sigmaRemaining * 0.25, sigmaRemaining * 0.25)
      : 0;
    const signalMove = moveFromReference + driftAdjustment + leadBoost;
    const rawModelUp = clamp(0.5 + 0.5 * Math.tanh((signalMove / sigmaRemaining) * 0.79788456), 0.001, 0.999);
    const marketPrior = Number(market.yes?.mid);
    if (!(marketPrior > 0 && marketPrior < 1)) return { ready: false, reason: "Waiting for executable CLOB midpoint" };
    const modelUp = clamp(marketPrior * 0.75 + rawModelUp * 0.25, 0.01, 0.99);
    const yesBuy = Number(market.yes?.buyPrice ?? market.yes?.ask ?? 0);
    const noBuy = Number(market.no?.buyPrice ?? market.no?.ask ?? 0);
    const yesEdge = yesBuy > 0 && yesBuy < 1 ? modelUp - yesBuy : -1;
    const noEdge = noBuy > 0 && noBuy < 1 ? (1 - modelUp) - noBuy : -1;
    const side = yesEdge >= noEdge ? "YES" : "NO";
    const edge = Math.max(yesEdge, noEdge);
    const buyPrice = side === "YES" ? yesBuy : noBuy;
    const spread = Number(market[side === "YES" ? "yes" : "no"]?.spread || 0);
    const def = this.defs[swarm.mode];
    // The edge must pay for crossing the CLOB spread as well as a small model
    // error buffer. Comparing fair value only with the ask made a 5–7 point
    // apparent edge look attractive while the round trip was still negative.
    const requiredEdge = clamp(Math.max(def.minEdge, spread * 1.1 + 0.018, 0.04 - this.learnedEdge(swarm, edge) * 0.01), 0.035, 0.14);
    const sideProbability = side === "YES" ? modelUp : 1 - modelUp;
    const recentPoints = points.slice(-Math.min(10, points.length));
    const recentMove = recentPoints.length > 1
      ? Math.log(Number(recentPoints[recentPoints.length - 1].price) / Number(recentPoints[0].price))
      : 0;
    const sideDirection = side === "YES" ? 1 : -1;
    const minimumMove = 0.0002;
    const momentumAligned = sideDirection * signalMove > 0
      && sideDirection * moveFromReference >= minimumMove
      && (recentMove === 0 || sideDirection * recentMove >= 0)
      && (!leadFresh || !Number.isFinite(leadMomentumPct) || sideDirection * leadMomentumPct >= 0);
    return {
      ready: true,
      side,
      edge,
      buyPrice,
      modelUp,
      marketPrior,
      requiredEdge,
      momentumZ: signalMove / sigmaRemaining,
      referenceMovePct: ((price - referencePrice) / referencePrice) * 100,
      leadPrice: Number(lead.price || 0) || null,
      leadMomentumPct,
      leadFresh,
      momentumAligned,
      confidence: clamp(0.5 + Math.abs(edge) * 3.2, 0, 0.98),
      reason: `${side} fair ${(sideProbability * 100).toFixed(1)}% vs buy ${buyPrice.toFixed(3)} · edge ${(edge * 100).toFixed(1)}% · PTB move ${((price - referencePrice) / referencePrice * 100).toFixed(3)}% · Binance lead ${leadFresh && Number.isFinite(leadMomentumPct) ? `${leadMomentumPct >= 0 ? "+" : ""}${leadMomentumPct.toFixed(3)}%/10s` : "unavailable"} · ${Math.ceil(remainingSeconds)}s left`,
    };
  }

  confirm(model, swarm) {
    if (!model.ready) {
      swarm.modelSide = null;
      swarm.modelSideCount = 0;
      return model;
    }
    if (swarm.modelSide === model.side) swarm.modelSideCount += 1;
    else { swarm.modelSide = model.side; swarm.modelSideCount = 1; }
    return { ...model, confirmed: swarm.modelSideCount >= this.defs[swarm.mode].confirmTicks };
  }

  open(swarm, model, market, timing) {
    const def = this.defs[swarm.mode];
    const eventEntryCutoff = Math.max(def.eventBufferSec, Number(timing.exitMs || 0) / 1000);
    const reject = reason => { swarm.lastOpenReason = reason; return false; };
    const now = Date.now();
    if (!model.ready) return reject(model.reason || "Waiting for model evidence");
    if (model.confirmed !== true) return reject(`Confirming ${model.side} signal (${swarm.modelSideCount}/${def.confirmTicks})`);
    if (market.secondsRemaining <= eventEntryCutoff) return reject(`Event safety window · ${Math.ceil(market.secondsRemaining)}s remain`);
    if (swarm.lossLockSlug === market.slug && now < Number(swarm.lossLockUntil || 0)) return reject("Loss lock: no re-entry after a losing exit in this window");
    if (swarm.entryCount >= def.maxEntries) return reject(`Entry limit reached for this ${market.interval} window (${def.maxEntries})`);
    if (now - swarm.lastExitAt < 15_000) return reject("Short re-entry cooldown active");
    if (model.edge < model.requiredEdge) return reject(`Edge ${(model.edge * 100).toFixed(1)}% below ${(model.requiredEdge * 100).toFixed(1)}% required after spread`);
    if (!(model.buyPrice > 0 && model.buyPrice < 1)) return reject("No executable buy quote");
    const outcome = market[model.side === "YES" ? "yes" : "no"] || {};
    const minTokens = Math.max(5, Number(outcome.minOrderSize || 5));
    const allocation = clamp(def.minAllocation + Math.max(0, model.edge - model.requiredEdge) * 4.5, def.minAllocation, def.maxAllocation);
    const minimumCost = model.buyPrice * minTokens;
    const maximumCost = Math.min(swarm.cash, swarm.capital * def.maxAllocation);
    const cost = Math.min(swarm.cash, Math.max(swarm.capital * allocation, minimumCost));
    if (cost > maximumCost + 0.000001) return reject(`CLOB minimum order needs $${minimumCost.toFixed(2)}; risk cap is $${maximumCost.toFixed(2)}`);
    const qty = cost / model.buyPrice;
    swarm.cash -= cost;
    swarm.position = {
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
      requiresExactTwap: market.settlement?.requiresExactTwap === true,
      settlementFeedVerified: market.settlement?.exactFeedConnected === true,
      edge: model.edge,
      openedAt: Date.now(),
    };
    swarm.entryCount += 1;
    swarm.lastOpenReason = "";
    swarm.trades.unshift({ ts: new Date().toISOString(), time: botNow(), action: "BUY", side: model.side, slug: market.slug, qty, price: model.buyPrice, notional: cost, reason: model.reason });
    swarm.trades = swarm.trades.slice(0, 200);
    this.record(swarm, "BUY", `Paper ${model.reason}`, market, { side: model.side, price: model.buyPrice, notional: cost, confidence: model.confidence, referencePrice: market.reference?.price });
    return true;
  }

  manage(swarm, model, market, timing) {
    const position = swarm.position;
    if (!position) return false;
    const outcome = market[position.side === "YES" ? "yes" : "no"] || {};
    const mark = Number(outcome.sellPrice ?? outcome.bid ?? outcome.mid ?? position.lastMark ?? 0);
    if (mark > 0) position.lastMark = mark;
    position.highMark = Math.max(Number(position.highMark || position.entryPrice), Number(position.lastMark || 0));
    const pnlPct = position.entryPrice ? ((position.lastMark - position.entryPrice) / position.entryPrice) * 100 : 0;
    const marketProb = Number(market.yes?.mid || 0.5);
    const modelUp = model.ready ? Number(model.modelUp) : marketProb;
    const thesisFlip = model.confirmed === true && (position.side === "YES" ? modelUp < marketProb - 0.05 : modelUp > marketProb + 0.05);
    const givebackPct = position.highMark ? ((position.highMark - position.lastMark) / position.highMark) * 100 : 0;
    const profitGiveback = pnlPct >= 8 && givebackPct >= 3;
    const lossCut = pnlPct <= -this.defs[swarm.mode].lossCutPct;
    const runtimeExitSeconds = Number(timing.exitMs || 0) / 1000;
    const eventSafety = Number(market.secondsRemaining || 0) <= Math.max(this.defs[swarm.mode].eventBufferSec, runtimeExitSeconds);
    if (thesisFlip || profitGiveback || lossCut || eventSafety) {
      const reason = eventSafety
        ? `Window safety exit · ${Math.ceil(Number(market.secondsRemaining || 0))}s remain`
        : thesisFlip
          ? `Probability thesis flipped · ${model.reason}`
          : profitGiveback
            ? `Profit protected · ${pnlPct.toFixed(1)}% gain gave back ${givebackPct.toFixed(1)}%`
            : `Loss cut · ${pnlPct.toFixed(1)}%`;
      return this.close(swarm, reason, position.lastMark, market);
    }
    swarm.lastAction = "HOLD";
    const fairSideProbability = position.side === "YES" ? modelUp : 1 - modelUp;
    swarm.lastDecision = `Holding ${position.side} · mark ${position.lastMark.toFixed(3)} · P&L ${pnlPct.toFixed(1)}% · fair ${(fairSideProbability * 100).toFixed(1)}%`;
    return false;
  }

  transition(market) {
    if (!market || this.state.windowSeen[market.interval] === market.slug) return;
    this.state.windowSeen[market.interval] = market.slug;
    this.modes().forEach(mode => {
      const swarm = this.state.swarms[mode];
      if (!swarm || swarm.enabled === false) return;
      swarm.lastDecision = `New ${market.interval} window · PTB ${formatPrice(market.reference?.price)} · building entry evidence`;
      swarm.windowSlug = market.slug;
      swarm.entryCount = 0;
      swarm.lossLockSlug = null;
      swarm.lossLockUntil = 0;
      swarm.lastOpenReason = "";
      this.record(swarm, "WINDOW", swarm.lastDecision, market, { referencePrice: market.reference?.price });
    });
  }

  alignSession(market) {
    if (this.state.sessionAligned || !market) return false;
    const endMs = Number(market.windowEnd || 0) * 1000;
    if (!(endMs > Date.now())) return false;
    this.state.sessionAligned = true;
    this.state.sessionSlug = market.slug || null;
    this.state.sessionEnd = endMs;
    this.state.stopAt = endMs;
    botState.stopAt = endMs;
    this.state.lastDecision = `Session locked to ${this.state.interval} market · ends ${new Date(endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    this.modes().forEach(mode => {
      const swarm = this.state.swarms[mode];
      if (swarm) this.record(swarm, "SESSION", this.state.lastDecision, market, { sessionEnd: endMs });
    });
    return true;
  }

  sessionTiming() {
    const now = Date.now();
    const stopAt = Number(this.state.sessionEnd || botState.stopAt || now);
    const durationMs = Math.max(1000, stopAt - Number(this.state.startedAt || now));
    const elapsedMs = clamp(now - Number(this.state.startedAt || now), 0, durationMs);
    const remainingMs = clamp(stopAt - now, 0, durationMs);
    return {
      now,
      startedAt: this.state.startedAt,
      stopAt,
      durationMs,
      elapsedMs,
      remainingMs,
      progress: durationMs ? elapsedMs / durationMs : 0,
      activeProgress: durationMs ? elapsedMs / durationMs : 0,
      // There is no user-configured warm-up or generic exit phase in a
      // Polymarket window. Risk is managed on every tick until settlement.
      observeMs: 0,
      exitMs: 0,
      phase: "trade",
    };
  }

  async tick() {
    if (!this.state.running || this.state.inFlight) return;
    // Always take one final feed snapshot after the boundary. The active
    // market may disappear from Gamma at that moment, but the held position
    // still has to settle against the final Chainlink price before the run is
    // marked stopped.
    this.state.inFlight = true;
    try {
      const data = await fetchFromApi("/api/polymarket/btc");
      this.state.latest = data;
      const focus = (data.markets || []).find(row => row.interval === this.state.interval);
      const feed = focus?.feed || data.spot || {};
      const spotPrice = Number(feed.price || 0);
      const timestamp = Number(feed.timestampMs || Date.now());
      const serverHistory = focus ? data.spotHistory?.[focus.slug] : null;
      if (Array.isArray(serverHistory) && serverHistory.length) {
        this.state.history = serverHistory
          .map(point => ({ time: Number(point.time), price: Number(point.price) }))
          .filter(point => point.time > 0 && point.price > 0)
          .slice(-1_800);
      } else {
        const previous = this.state.history[this.state.history.length - 1];
        if (spotPrice > 0 && (!previous || timestamp > Number(previous.time))) this.state.history.push({ time: timestamp, price: spotPrice });
        this.state.history = this.state.history.slice(-360);
      }
      this.alignSession(focus);
      const timing = this.sessionTiming();
      const sessionEnded = this.state.sessionAligned && Date.now() >= Number(this.state.sessionEnd || 0);
      this.transition(focus);
      for (const mode of this.modes()) {
        const swarm = this.state.swarms[mode];
        if (!swarm || swarm.enabled === false) continue;
        swarm.decisions += 1;
        const heldMarket = swarm.position ? (data.markets || []).find(row => row.slug === swarm.position.slug) : null;
        const expired = swarm.position && Number(swarm.position.windowEnd || 0) > 0 && Date.now() >= Number(swarm.position.windowEnd) * 1000;
        const settlementVerified = heldMarket?.settlement?.exactFeedConnected === true
          || swarm.position.settlementFeedVerified === true;
        if (expired && !settlementVerified) {
          this.record(swarm, "WATCH", "Settlement awaiting the exact Chainlink 60s TWAP source; paper result is not guessed", heldMarket || focus);
          continue;
        }
        if (expired && spotPrice > 0 && Number(swarm.position.referencePrice || 0) > 0) {
          const won = swarm.position.side === "YES" ? spotPrice >= Number(swarm.position.referencePrice) : spotPrice < Number(swarm.position.referencePrice);
          this.close(swarm, `Market settled ${won ? "WIN" : "LOSS"} · ${swarm.position.side} vs Chainlink PTB`, won ? 1 : 0, heldMarket || focus, "SETTLE");
          continue;
        }
        if (swarm.position && heldMarket) {
          const managedModel = this.confirm(this.model(heldMarket, swarm), swarm);
          swarm.lastModel = managedModel.ready ? managedModel : null;
          this.manage(swarm, managedModel, heldMarket, timing);
          continue;
        }
        if (swarm.position && !heldMarket) {
          this.record(swarm, "WATCH", "Held market temporarily missing; position remains pinned", focus);
          continue;
        }
        if (sessionEnded) {
          this.record(swarm, "WATCH", "Selected Polymarket session ended; no next-window entry", focus);
          continue;
        }
        if (!focus) { this.record(swarm, "WATCH", `Waiting for active BTC ${this.state.interval} market`); continue; }
        const model = this.confirm(this.model(focus, swarm), swarm);
        swarm.lastModel = model.ready ? model : null;
        const eventEntryCutoff = Math.max(this.defs[mode].eventBufferSec, Number(timing.exitMs || 0) / 1000);
        if (feed.stale || focus.stale) this.record(swarm, "WATCH", "Stale Chainlink/CLOB feed — no new entry", focus);
        else if (!focus.anchorReady) this.record(swarm, "WATCH", "Waiting for exact window-start price-to-beat", focus);
        else if (Number(focus.secondsRemaining || 0) <= eventEntryCutoff) this.record(swarm, "WATCH", `Event safety window — ${Math.ceil(Number(focus.secondsRemaining || 0))}s remain`, focus);
        else if (!model.ready) this.record(swarm, "WATCH", model.reason, focus);
        else if (!this.open(swarm, model, focus, timing)) this.record(
          swarm,
          "WATCH",
          swarm.lastOpenReason || `No executable entry for ${model.side}`,
          focus,
          model.ready ? {
            side: model.side,
            edge: model.edge,
            requiredEdge: model.requiredEdge,
            modelUp: model.modelUp,
            marketPrior: model.marketPrior,
            referenceMovePct: model.referenceMovePct,
            leadMomentumPct: model.leadMomentumPct,
            leadFresh: model.leadFresh,
            momentumAligned: model.momentumAligned,
            confirmed: model.confirmed === true,
            secondsRemaining: focus.secondsRemaining,
          } : {},
        );
      }
      this.state.error = "";
      this.sync();
      if (sessionEnded) stopBot("Polymarket session ended");
    } catch (error) {
      this.state.error = error.message || "Polymarket feed unavailable";
      this.state.lastDecision = this.state.error;
    } finally {
      this.state.inFlight = false;
      this.sync();
      renderPolymarketPanel();
      renderBotStatus();
      scheduleBotDecision();
    }
  }

  formatWindow(market) {
    if (!market) return "--";
    const start = new Date(Number(market.windowStart) * 1000);
    const end = new Date(Number(market.windowEnd) * 1000);
    const fmt = value => value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${fmt(start)}–${fmt(end)}`;
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  contractCents(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    const cents = number * 100;
    return `${cents.toFixed(cents < 1 ? 2 : cents < 10 ? 1 : 0)}¢`;
  }

  contractPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return `${(number * 100).toFixed(number * 100 < 1 ? 2 : 1)}%`;
  }

  chart(market) {
    const serverPoints = this.state.latest?.spotHistory?.[market.slug];
    const sourcePoints = Array.isArray(serverPoints) && serverPoints.length ? serverPoints : this.state.history;
    const points = sourcePoints.slice(-900);
    if (!points.length || !market) return `<div class="poly-chart-empty">Live Chainlink feed collecting market data...</div>`;

    const stride = Math.max(1, Math.ceil(points.length / 240));
    const chartPoints = points.filter((point, index) => index === points.length - 1 || index % stride === 0);
    const values = chartPoints.map(point => Number(point.price)).filter(Number.isFinite);
    const reference = Number(market.reference?.price);
    const referenceReady = market.anchorReady === true && Number.isFinite(reference) && reference > 0;
    const scaleReference = referenceReady ? reference : values[0];
    const observedMin = Math.min(...values, scaleReference);
    const observedMax = Math.max(...values, scaleReference);
    const observedSpan = Math.max(0.01, observedMax - observedMin);

    // The previous 0.18% floor flattened intraday BTC movement into a
    // near-straight line. A tighter, still stable 0.04% floor keeps the
    // price-to-beat visible without exaggerating normal movement.
    const stableSpan = Math.max(observedSpan * 1.35, Math.abs(scaleReference) * 0.0004, 1);
    let min = scaleReference - stableSpan / 2;
    let max = scaleReference + stableSpan / 2;
    if (observedMin < min) min = observedMin - stableSpan * 0.1;
    if (observedMax > max) max = observedMax + stableSpan * 0.1;
    const span = Math.max(0.01, max - min);

    const coords = chartPoints.map((point, index) => {
      const x = (index / Math.max(1, chartPoints.length - 1) * 100).toFixed(2);
      const y = (100 - ((point.price - min) / span) * 80 - 10).toFixed(2);
      return { x, y, price: point.price };
    });

    // A continuous curve is far easier to read than a jagged sparkline when
    // the browser has to compress hundreds of live ticks into one window.
    // Catmull-Rom control points retain every observed point while softening
    // only the joins between them.
    const smoothLinePath = (items) => {
      if (items.length < 3) return items.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
      const pointsForCurve = items.map(point => ({ x: Number(point.x), y: Number(point.y) }));
      let path = `M${pointsForCurve[0].x.toFixed(2)},${pointsForCurve[0].y.toFixed(2)}`;
      for (let index = 0; index < pointsForCurve.length - 1; index += 1) {
        const previous = pointsForCurve[index - 1] || pointsForCurve[index];
        const current = pointsForCurve[index];
        const next = pointsForCurve[index + 1];
        const afterNext = pointsForCurve[index + 2] || next;
        const controlOne = {
          x: current.x + (next.x - previous.x) / 6,
          y: current.y + (next.y - previous.y) / 6,
        };
        const controlTwo = {
          x: next.x - (afterNext.x - current.x) / 6,
          y: next.y - (afterNext.y - current.y) / 6,
        };
        path += ` C${controlOne.x.toFixed(2)},${controlOne.y.toFixed(2)} ${controlTwo.x.toFixed(2)},${controlTwo.y.toFixed(2)} ${next.x.toFixed(2)},${next.y.toFixed(2)}`;
      }
      return path;
    };
    const linePath = smoothLinePath(coords);
    const areaPath = `${linePath} L${coords[coords.length - 1].x},100 L0,100 Z`;

    const lastCoord = coords[coords.length - 1];
    const referenceY = referenceReady ? 100 - ((reference - min) / span) * 80 - 10 : null;

    const isExactTwap = market.settlement?.exactFeedConnected === true;
    const twapWindow = Number(market.settlement?.windowSeconds || 60);
    const feedLabel = isExactTwap ? `Polymarket Chainlink BTC/USD ${twapWindow}s TWAP` : "Chainlink spot proxy · not settlement TWAP";
    const referenceLabel = market.reference?.quality === "polymarket_price_to_beat" ? "Price to beat" : isExactTwap ? "PTB (TWAP)" : "PTB pending";
    const isAbovePTB = referenceReady ? lastCoord.price >= reference : true;
    const strokeColor = isAbovePTB ? "#10B981" : "#F43F5E";
    const gradientId = isAbovePTB ? "polyGradUp" : "polyGradDown";

    const ptbLine = referenceY == null ? "" : `
      <line x1="0" x2="100" y1="${referenceY.toFixed(2)}" y2="${referenceY.toFixed(2)}" class="poly-ptb-line"></line>
    `;

    return `
      <div class="poly-chart-topline">
        <span>${feedLabel}</span>
        <strong class="${isAbovePTB ? "positive" : "negative"}">$${formatPrice(lastCoord.price)}${referenceReady ? ` · ${isAbovePTB ? "above" : "below"} PTB` : ""}</strong>
      </div>
      <div class="poly-chart-frame">
        <div class="poly-chart-yaxis">
          <span>$${formatPrice(max)}</span>
          <span>$${formatPrice((max + min) / 2)}</span>
          <span>$${formatPrice(min)}</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="BTC Price Chart">
          <defs>
            <linearGradient id="polyGradUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#10B981" stop-opacity="0.18"/>
              <stop offset="100%" stop-color="#10B981" stop-opacity="0.0"/>
            </linearGradient>
            <linearGradient id="polyGradDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#F43F5E" stop-opacity="0.18"/>
              <stop offset="100%" stop-color="#F43F5E" stop-opacity="0.0"/>
            </linearGradient>
          </defs>
          <line x1="0" x2="100" y1="25" y2="25" class="poly-grid-line"></line>
          <line x1="0" x2="100" y1="50" y2="50" class="poly-grid-line"></line>
          <line x1="0" x2="100" y1="75" y2="75" class="poly-grid-line"></line>
          ${ptbLine}
          <path d="${areaPath}" fill="url(#${gradientId})"></path>
          <path d="${linePath}" class="poly-price-line ${isAbovePTB ? "is-up" : "is-down"}" stroke="${strokeColor}"></path>
          <circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="1.7" fill="${strokeColor}"></circle>
        </svg>
      </div>
      <div class="poly-chart-legend">
        <span>● ${feedLabel} $${formatPrice(lastCoord.price)}</span>
        <span>${referenceLabel} ${referenceReady ? `$${formatPrice(reference)}` : "Awaiting window anchor"}</span>
        <span>${this.formatWindow(market)} · ${points.length} ticks</span>
      </div>
    `;
  }

  swarmCard(swarm) {
    const position = swarm.position;
    const mark = position ? Number(position.lastMark || position.entryPrice) : 0;
    const value = swarm.cash + (position ? position.qty * mark : 0);
    const pnl = value - swarm.capital;
    const model = swarm.lastModel;
    const modelLine = swarm.enabled === false
      ? "Disabled by user · no orders or decisions"
      : model?.ready ? `Fair UP ${(Number(model.modelUp) * 100).toFixed(1)}% · ${model.side} edge ${(Number(model.edge) * 100).toFixed(1)}% · lead ${model.leadFresh && Number.isFinite(model.leadMomentumPct) ? `${model.leadMomentumPct >= 0 ? "+" : ""}${model.leadMomentumPct.toFixed(3)}%` : "off"}` : "Model is building live evidence";
    const recentRows = [];
    const recentKeys = new Set();
    for (const row of swarm.audit) {
      const key = `${row.action}:${row.reason}`;
      if (recentKeys.has(key)) continue;
      recentKeys.add(key);
      recentRows.push(row);
      if (recentRows.length === 3) break;
    }
    const recent = recentRows.map(row => `<div class="poly-decision-row"><b>${this.escape(row.action)}</b><span>${this.escape(row.reason)}</span></div>`).join("");
    const cardClass = `${swarm.tone}${swarm.enabled === false ? " disabled" : ""}`;
    const statusText = swarm.enabled === false ? "disabled · not trading" : position ? `watching ${position.side}` : "flat · scanning";
    const decision = swarm.lastDecision || (swarm.enabled === false
      ? "This strategy is disabled."
      : position
        ? `Watching the ${position.side} position as the market moves.`
        : "No position. Waiting for a verified executable edge.");
    return `<article class="poly-swarm-card ${cardClass}"><div class="poly-swarm-head"><div><span class="poly-swarm-dot"></span><strong>${swarm.label}</strong><small>${statusText}</small></div><b class="${pnl >= 0 ? "positive" : "negative"}">$${formatPrice(pnl)}</b></div><div class="poly-swarm-metrics"><span>Equity <b>$${formatPrice(value)}</b></span><span>Record <b>${swarm.learning.trades} trades · ${swarm.learning.trades ? Math.round(swarm.learning.wins / swarm.learning.trades * 100) : 0}% win</b></span></div><div class="poly-swarm-position">${position ? `<b>${position.side}</b><span>${position.qty.toFixed(2)} tokens · entry ${position.entryPrice.toFixed(3)} · mark ${mark.toFixed(3)}</span>` : `<b>${swarm.enabled === false ? "OFF" : "WATCH"}</b><span>${swarm.enabled === false ? "No new decisions" : "Scanning the active window"}</span>`}</div><p class="poly-swarm-decision">${this.escape(decision)}<small>${this.escape(modelLine)}</small></p><div class="poly-decision-feed">${recent || '<em>Decision feed starts with the next market tick.</em>'}</div></article>`;
  }

  render() {
    const panel = document.querySelector("#bot-polymarket-panel");
    if (!panel) return;
    const latest = this.state.latest;
    const focus = latest?.markets?.find(row => row.interval === this.state.interval);
    const secondary = latest?.markets?.find(row => row.interval !== this.state.interval);
    const hasSwarms = this.modes().some(mode => this.state.swarms[mode]);
    const configuredCapital = this.modes().reduce((sum, mode) => sum + (this.configuredEnabled(mode) ? this.configuredCapital(mode) : 0), 0);
    const totalCapital = hasSwarms ? this.totalCapital() : configuredCapital;
    const totalCash = hasSwarms ? this.totalCash() : configuredCapital;
    const totalRealized = hasSwarms ? this.totalRealized() : 0;
    const totalValue = totalCash + this.modes().reduce((sum, mode) => {
      const position = this.state.swarms[mode]?.position;
      return sum + (position ? position.qty * Number(position.lastMark || position.entryPrice || 0) : 0);
    }, 0);
    const summary = document.querySelector("#polymarket-summary");
    const card = document.querySelector("#polymarket-market-card");
    const secondaryCard = document.querySelector("#polymarket-secondary-card");
    const swarms = document.querySelector("#polymarket-swarms");
    const trades = document.querySelector("#polymarket-trades");
    const learning = document.querySelector("#polymarket-learning");
    const enabledCount = this.modes().filter(mode => this.state.swarms[mode] ? this.state.swarms[mode].enabled !== false : this.configuredEnabled(mode)).length;
    const openCount = this.modes().filter(mode => this.state.swarms[mode]?.position).length;

    if (summary) summary.innerHTML = `<div class="poly-sum-item"><span>Active paper equity</span><strong class="${totalValue >= totalCapital ? "positive" : "negative"}">$${formatPrice(totalValue)}</strong></div><div class="poly-sum-item"><span>Combined P&L</span><strong class="${totalRealized >= 0 ? "positive" : "negative"}">${totalRealized >= 0 ? "+" : ""}$${formatPrice(totalRealized)}</strong></div><div class="poly-sum-item"><span>Open swarm positions</span><strong>${openCount}/${enabledCount}</strong></div><div class="poly-sum-item"><span>Settlement feed</span><strong>${latest?.markets?.some(item => item.settlement?.exactFeedConnected === true) ? "Exact feed live" : "TWAP required"}</strong><small>Paper entries stay blocked until the exact Chainlink TWAP source is connected.</small></div>`;
    const contractSummary = outcome => `<div><span>${outcome === focus?.yes ? "UP / YES" : "DOWN / NO"}</span><strong>${this.contractCents(outcome?.mid)}</strong><small>implied ${this.contractPercent(outcome?.mid)} · buy ${this.contractCents(outcome?.buyPrice)} · sell ${this.contractCents(outcome?.sellPrice)}</small></div>`;
    const selectedReference = Number(focus?.reference?.price);
    const focusFeed = focus?.feed || latest?.spot || {};
    const selectedCurrent = Number(focusFeed.price || 0);
    const selectedAnchorReady = focus?.anchorReady === true && Number.isFinite(selectedReference) && selectedReference > 0;
    const selectedDelta = selectedAnchorReady && Number.isFinite(selectedCurrent) ? `${selectedCurrent >= selectedReference ? "+" : ""}$${formatPrice(selectedCurrent - selectedReference)}` : "PTB pending";
    const settlementVerified = focus?.settlement?.exactFeedConnected === true;
    const settlementStatus = settlementVerified ? "Exact TWAP live" : "TWAP connection pending";
    const settlementError = focus?.settlement?.feedError;
    const twapWindow = Number(focus?.settlement?.windowSeconds || 60);
    const feedLabel = settlementVerified ? `Polymarket Chainlink ${twapWindow}s TWAP` : "Chainlink spot proxy";
    const referenceLabel = focus?.reference?.quality === "polymarket_price_to_beat" ? "Price to beat" : settlementVerified ? "PTB (TWAP)" : "PTB pending";

    if (card) {
      card.classList.toggle("is-empty", !focus);
      card.innerHTML = focus ? `<div class="poly-market-top">
        <div class="poly-market-head-row">
          <div class="poly-market-title">
            <span class="poly-btc-icon">₿</span>
            <div>
              <strong>Selected market · BTC Up or Down ${focus.interval}</strong>
              <small>${this.formatWindow(focus)} · ${this.escape(focus.question || "")}</small>
            </div>
          </div>
          <div class="poly-market-header-stats">
            <div class="header-stat">
              <span>${referenceLabel}</span>
              <strong class="ptb-val">${selectedAnchorReady ? `$${formatPrice(selectedReference)}` : "Awaiting opening value"}</strong>
            </div>
            <div class="header-stat">
              <span>${feedLabel}</span>
              <strong>$${formatPrice(selectedCurrent)} <em class="${selectedAnchorReady ? selectedCurrent >= selectedReference ? "positive" : "negative" : "muted"}">${selectedDelta}</em></strong>
            </div>
          </div>
          <div class="poly-market-clock">
            <b>${Math.floor(Number(focus.secondsRemaining || 0) / 60)}<small>MIN</small></b>
            <b>${Math.floor(Number(focus.secondsRemaining || 0) % 60).toString().padStart(2, "0")}<small>SEC</small></b>
          </div>
        </div>

        <div class="poly-market-body-grid">
          <div class="poly-chart-container">
            <div class="poly-chart">${this.chart(focus)}</div>
            <div class="poly-price-strip">
              <div><span>${referenceLabel}</span><strong>${selectedAnchorReady ? `$${formatPrice(selectedReference)}` : "--"}</strong><small>${selectedAnchorReady ? "Polymarket opening value" : this.escape(focus?.reference?.reason || "Awaiting the opening TWAP report")}</small></div>
              <div><span>${feedLabel}</span><strong>$${formatPrice(selectedCurrent)}</strong><small>${focusFeed.stale ? "stale" : `${focusFeed.ageMs ?? "--"}ms old`}</small></div>
              <div><span>Settlement safety</span><strong>${settlementVerified ? "Verified" : "Monitoring only"}</strong><small>${settlementVerified ? settlementStatus : this.escape(settlementError || settlementStatus)}</small></div>
              <div><span>Volume / liquidity</span><strong>$${formatVolume(focus.volume)} / $${formatVolume(focus.liquidity)}</strong><small>Polymarket CLOB</small></div>
            </div>
          </div>

          <div class="poly-odds-container">
            <div class="poly-contract-heading">
              <strong>Polymarket contract book</strong>
              <span>Live CLOB odds</span>
            </div>
            <div class="poly-outcome-board">
              <div class="poly-outcome-card up">
                <div class="poly-outcome-top">
                  <div class="poly-outcome-label">
                    <span class="poly-badge up-badge">YES</span>
                    <strong>UP</strong>
                  </div>
                  <strong class="poly-cents">${this.contractCents(focus.yes?.mid)}</strong>
                </div>
                <div class="poly-outcome-sub">
                  <div class="poly-odds-bar-track">
                    <div class="poly-odds-bar-fill up-fill" style="width: ${this.contractPercent(focus.yes?.mid)}"></div>
                  </div>
                  <div class="poly-buy-sell">
                    <span>Implied ${this.contractPercent(focus.yes?.mid)}</span>
                    <span>Buy ${this.contractCents(focus.yes?.buyPrice)} · Sell ${this.contractCents(focus.yes?.sellPrice)}</span>
                  </div>
                </div>
              </div>

              <div class="poly-outcome-card down">
                <div class="poly-outcome-top">
                  <div class="poly-outcome-label">
                    <span class="poly-badge down-badge">NO</span>
                    <strong>DOWN</strong>
                  </div>
                  <strong class="poly-cents">${this.contractCents(focus.no?.mid)}</strong>
                </div>
                <div class="poly-outcome-sub">
                  <div class="poly-odds-bar-track">
                    <div class="poly-odds-bar-fill down-fill" style="width: ${this.contractPercent(focus.no?.mid)}"></div>
                  </div>
                  <div class="poly-buy-sell">
                    <span>Implied ${this.contractPercent(focus.no?.mid)}</span>
                    <span>Buy ${this.contractCents(focus.no?.buyPrice)} · Sell ${this.contractCents(focus.no?.sellPrice)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>` : `<div class="polymarket-empty">${this.escape(this.state.error || `No active BTC ${this.state.interval} market is available right now.`)}</div>`;
    }
if (secondaryCard) secondaryCard.innerHTML = secondary ? `<div class="poly-secondary-head"><strong>Other live window · BTC ${secondary.interval}</strong><span>${Math.ceil(Number(secondary.secondsRemaining || 0))}s left</span></div><div class="poly-secondary-prices"><span>PTB <b>${secondary.anchorReady ? `$${formatPrice(secondary.reference?.price)}` : "--"}</b></span><span>Current <b>$${formatPrice(secondary.feed?.price)}</b></span><span>UP / YES <b>${this.contractCents(secondary.yes?.mid)}</b><small>buy ${this.contractCents(secondary.yes?.buyPrice)} · sell ${this.contractCents(secondary.yes?.sellPrice)}</small></span><span>DOWN / NO <b>${this.contractCents(secondary.no?.mid)}</b><small>buy ${this.contractCents(secondary.no?.buyPrice)} · sell ${this.contractCents(secondary.no?.sellPrice)}</small></span></div>` : "";
    if (swarms) swarms.innerHTML = this.modes().map(mode => this.swarmCard(this.state.swarms[mode] || this.createSwarm(mode, 0))).join("");
    if (trades) trades.innerHTML = this.state.trades.length ? `<div class="poly-trade-table"><div class="poly-trade-row poly-trade-header"><span>Swarm</span><span>Action</span><span>Side</span><span>Price</span><span>P&L</span><span>Reason</span></div>${this.state.trades.slice(0, 12).map(trade => `<div class="poly-trade-row"><span>${this.escape(trade.swarm || "-")}</span><b class="${trade.action === "BUY" ? "positive" : "negative"}">${trade.action}</b><span>${trade.side || "-"}</span><span>${trade.price != null ? `${Math.round(Number(trade.price) * 100)}¢` : "-"}</span><span class="${Number(trade.pnl || 0) >= 0 ? "positive" : "negative"}">${trade.pnl == null ? "-" : `${Number(trade.pnl) >= 0 ? "+" : ""}$${formatPrice(trade.pnl)}`}</span><span>${this.escape(trade.reason || "")}</span></div>`).join("")}</div>` : `<em>No completed trades yet. Each swarm is watching the live window independently.</em>`;
    if (learning) learning.innerHTML = this.modes().map(mode => { const swarm = this.state.swarms[mode] || this.createSwarm(mode, 0); const l = swarm.learning; return `<div class="poly-learning-row"><b>${swarm.label}</b><span>${l.trades} closed</span><span>${l.trades ? Math.round(l.wins / l.trades * 100) : 0}% win</span><strong class="${l.pnl >= 0 ? "positive" : "negative"}">${l.pnl >= 0 ? "+" : ""}$${formatPrice(l.pnl)}</strong><small>${Object.entries(l.byWindow || {}).map(([window, stats]) => `${window} ${stats.wins}/${stats.n}`).join(" · ") || "learning by window starts after settlement"}</small></div>`; }).join("");
  }
}

window.PolymarketSwarmEngine = PolymarketSwarmEngine;
