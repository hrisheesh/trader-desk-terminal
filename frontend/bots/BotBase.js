class TraderBot {
  constructor(mode) {
    this.mode = mode;
  }
  
  getTempo() {
    if (this.mode === "calm") return { globalCooldown: 12000, symbolCooldown: 26000, firstEntryScale: 0.22, deploymentCurve: 1.7 };
    if (this.mode === "aggressive") return { globalCooldown: 1800, symbolCooldown: 3500, firstEntryScale: 0.72, deploymentCurve: 0.5 };
    return { globalCooldown: 5000, symbolCooldown: 9000, firstEntryScale: 0.46, deploymentCurve: 1.02 };
  }

  recentPerformance() {
    const trades = botState.modes[this.mode].trades.filter(trade => trade.side === "SELL").slice(0, 12);
    if (!trades.length) return { realizedBias: 0, winRate: 0.5 };
    const wins = trades.filter(trade => Number(trade.pnl || 0) > 0).length;
    const pnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const capital = Math.max(1, botCapital(this.mode));
    return { realizedBias: clamp((pnl / capital) * 100, -10, 10), winRate: wins / trades.length };
  }

  strategyProfile(snapshot) {
    const def = BOT_MODES[this.mode];
    const timing = botRunTiming(this.mode);
    const drawdownPct = snapshot.capital ? Math.max(0, ((snapshot.capital - snapshot.totalValue) / snapshot.capital) * 100) : 0;
    const performance = this.recentPerformance();
    const pressure = clamp(drawdownPct / 8, 0, 1);
    const learningBias = ((performance.winRate - 0.5) * 0.12) + (performance.realizedBias / 80);
    const lateCaution = timing.phase === "exit" ? 0.18 : timing.phase === "manage" ? 0.06 : 0;
    
    // Professional Trader Upgrade: Drawdown Exponential Risk Scaling
    // If the bot is in a drawdown, exponentially decay maxPosition and riskTolerance
    const drawdownPenalty = drawdownPct > 0 ? Math.pow(drawdownPct, 1.25) / 100 : 0;
    
    const tempo = this.getTempo();
    const deploymentAllowance = timing.phase === "observe" || timing.phase === "exit"
    ? (timing.phase === "exit" ? 0 : clamp(tempo.firstEntryScale * 0.45, 0.08, 0.32))
    : clamp(tempo.firstEntryScale + Math.pow(timing.activeProgress, tempo.deploymentCurve) * (1 - tempo.firstEntryScale), tempo.firstEntryScale, 1);
    
    return {
      ...def,
      mode: this.mode,
      timing,
      drawdownPct,
      performance,
      deploymentAllowance,
      maxPosition: clamp(def.maxPosition - drawdownPenalty * 0.5, 0.02, 1.0),
      convictionDemand: clamp(def.convictionBias + pressure * 0.14 - learningBias + lateCaution + drawdownPenalty, 0.24, 0.95),
      riskTolerance: clamp(def.riskAppetite - pressure * 0.16 + learningBias * 1.5 - drawdownPenalty * 1.5, 0.05, 0.95),
      patienceLevel: clamp(def.patience + pressure * 0.18 + lateCaution - timing.activeProgress * def.riskAppetite * 0.08, 0.14, 0.94),
    };
  }

  observationNeed(profile) {
    const timingPenalty = profile.timing.phase === "observe" && this.mode !== "aggressive" ? 1 : 0;
    const modeAdjustment = this.mode === "aggressive" ? -1.6 : this.mode === "calm" ? 1.2 : 0;
    return Math.round(clamp(3 + profile.patienceLevel * 4 + profile.convictionDemand * 1.2 - profile.riskTolerance + modeAdjustment, this.mode === "aggressive" ? 2 : 3, this.mode === "calm" ? 8 : 6) + timingPenalty);
  }

  minimumEdge(profile, context, snapshot) {
    const exposurePct = snapshot.capital ? snapshot.openValue / snapshot.capital : 0;
    const uncertainty = context.noisePct * 1.35 + Math.max(0, -context.agreement) * 8 + exposurePct * 7;
    const performanceAdjustment = profile.performance.realizedBias * 0.22 + (profile.performance.winRate - 0.5) * 5;
    const phaseAdjustment = profile.timing.phase === "observe" ? (this.mode === "aggressive" ? 2 : this.mode === "calm" ? 10 : 6) : profile.timing.phase === "exit" ? 100 : profile.timing.phase === "manage" ? 2 : 0;
    const personalityAdjustment = this.mode === "aggressive" ? -5 : this.mode === "calm" ? 5 : 0;
    return clamp(5 + profile.patienceLevel * 12 + profile.convictionDemand * 14 - profile.riskTolerance * 8 + uncertainty + phaseAdjustment + personalityAdjustment - performanceAdjustment, 3, 120);
  }

  buildDecision(action, context, profile, confidence, risk, notional = 0, sellFraction = 0, meta = {}) {
    const volatility = Math.max(0.25, context.volatilityPct);
    
    // High-Frequency Scalping Upgrade: Micro targets
    // We only have 30 minutes, so we must hunt for tiny scalps (0.2% - 0.4%)
    const stopBase = (this.mode === "calm" ? 0.3 : this.mode === "aggressive" ? 0.6 : 0.4) + volatility * (0.2 + profile.riskTolerance * 0.2);
    const targetBase = (this.mode === "calm" ? 0.2 : this.mode === "aggressive" ? 0.4 : 0.3) + volatility * (0.2 + profile.riskTolerance * 0.2) + Math.max(0, confidence - 64) * 0.01;
    
    return {
      action,
      symbol: context.symbol,
      price: context.price,
      score: Math.round(confidence),
      confidence: clamp(confidence, 0, 100),
      risk: clamp(risk, 0, 100),
      style: profile.label,
      phase: profile.timing.phase,
      patience: profile.patienceLevel,
      conviction: profile.convictionDemand,
      notional,
      sellFraction,
      stopLossPct: clamp(stopBase, this.mode === "calm" ? 0.25 : 0.4, this.mode === "aggressive" ? 1.0 : 0.8),
      takeProfitPct: clamp(targetBase, this.mode === "calm" ? 0.15 : 0.2, this.mode === "calm" ? 0.5 : this.mode === "aggressive" ? 1.5 : 1.0),
      ...meta,
    };
  }

  decisionReason(decision, context) {
    const actionText = decision.action === "BUY" ? `buy $${formatPrice(decision.notional || 0)}` : decision.action.toLowerCase();
    const edgeText = Number.isFinite(decision.edge) ? `; edge ${decision.edge.toFixed(1)}/${decision.requiredEdge.toFixed(1)}` : "";
    const exitText = decision.exitCause ? `; ${decision.exitCause}` : "";
    const blockText = decision.blockedBy ? `; blocked by ${decision.blockedBy}` : "";
    return `${actionText}; ${decision.style} ${decision.phase}; confidence ${Math.round(decision.confidence)}; risk ${Math.round(decision.risk)}${edgeText}${exitText}${blockText}; samples ${context.samples}; pnl ${context.pnlPct >= 0 ? "+" : ""}${context.pnlPct.toFixed(2)}%; momentum ${context.shortMomentumPct >= 0 ? "+" : ""}${context.shortMomentumPct.toFixed(2)}%; noise ${context.noisePct.toFixed(2)}%; ${context.signalAction} signal ${context.signalConfidence}%`;
  }

  tradeCooldownReady(symbol, profile) {
    const state = botState.modes[this.mode];
    const tempo = this.getTempo();
    const now = Date.now();
    const globalReady = !state.lastActionAt || now - state.lastActionAt >= tempo.globalCooldown;
    const symbolReady = !state.lastTradeAt[symbol] || now - state.lastTradeAt[symbol] >= tempo.symbolCooldown;
    return globalReady && symbolReady;
  }

  pacedNotional(context, profile, snapshot, edge, requiredEdge) {
    const timing = profile.timing;
    if (timing.phase === "exit") return 0;
    if (!this.tradeCooldownReady(context.symbol, profile)) return 0;
    
    // Professional Trader Upgrade: Simplified Half-Kelly Criterion
    // f* = (Edge / Odds). We proxy odds with volatility, and scale by winRate.
    const winRate = clamp(profile.performance.winRate, 0.3, 0.7);
    const winEdge = Math.max(0, edge - requiredEdge + 5); 
    const kellyFraction = clamp((winRate * winEdge) / Math.max(1.0, context.volatilityPct * 100), 0.01, 1.0) * 0.5; // Half-Kelly
    
    const conviction = clamp(kellyFraction * (this.mode === "aggressive" ? 2.5 : this.mode === "calm" ? 0.8 : 1.5), 0, this.mode === "aggressive" ? 1.25 : 1.0);
    const exposureCap = snapshot.capital * profile.maxExposure * profile.deploymentAllowance;
    const currentValue = botHeldQuantity(this.mode, context.symbol) * context.price;
    const positionCap = snapshot.capital * profile.maxPosition * profile.deploymentAllowance;
    const exposureRoom = Math.max(0, exposureCap - snapshot.openValue);
    const positionRoom = Math.max(0, positionCap - currentValue);
    const reservePct = this.mode === "calm" ? 0.24 + profile.drawdownPct / 52 : this.mode === "aggressive" ? 0.015 + profile.drawdownPct / 150 : 0.1 + profile.drawdownPct / 88;
    const spendable = Math.max(0, snapshot.cash - snapshot.capital * reservePct);
    const phaseSlice = snapshot.capital * profile.maxPosition * conviction * (this.mode === "aggressive" ? 0.82 : this.mode === "calm" ? 0.34 : 0.56);
    return Math.min(spendable, exposureRoom, positionRoom, phaseSlice);
  }

  brainFor(context, profile, snapshot) {
    const ready = context.samples >= this.observationNeed(profile);
    const acceleration = context.shortMomentumPct - context.noisePct * (this.mode === "aggressive" ? 0.08 : this.mode === "calm" ? 0.28 : 0.18);
    const personalityLift = this.mode === "aggressive" ? 6 : this.mode === "calm" ? -2 : 2;
    const liveTape = context.shortMomentumPct - context.noisePct * (this.mode === "aggressive" ? 0.04 : this.mode === "calm" ? 0.22 : 0.12);
    const tapePenalty = liveTape < 0 ? Math.abs(liveTape) * (this.mode === "calm" ? 28 : this.mode === "aggressive" ? 14 : 20) : 0;
    const reversalPenalty = context.shortMomentumPct < -context.noisePct ? 8 : 0;
    
    // Professional Trader Upgrade: Mean Reversion vs Trend Following
    let rsiAdjustment = 0;
    if (this.mode === "calm") {
      // Mean Reversion: Buy when oversold (RSI < 40) and avoid overbought
      if (context.rsiProxy < 40) rsiAdjustment = (40 - context.rsiProxy) * 0.6;
      else if (context.rsiProxy > 70) rsiAdjustment = (70 - context.rsiProxy) * 0.8;
    } else if (this.mode === "aggressive") {
      // Trend Following: Buy breakouts (RSI > 55) and avoid weak momentum
      if (context.rsiProxy > 55) rsiAdjustment = (context.rsiProxy - 55) * 0.5;
      else if (context.rsiProxy < 45) rsiAdjustment = (context.rsiProxy - 45) * 0.7;
    }

    const confidence = clamp(
      40 + personalityLift
      + context.trendQuality * (this.mode === "aggressive" ? 1.28 : this.mode === "calm" ? 0.68 : 0.94)
      + context.agreement * (this.mode === "calm" ? 20 : this.mode === "aggressive" ? 10 : 14)
      + Math.max(0, acceleration) * (this.mode === "aggressive" ? 18 : this.mode === "calm" ? 5 : 9)
      + profile.performance.realizedBias * 0.7
      + rsiAdjustment
      - profile.convictionDemand * (this.mode === "calm" ? 9 : 3.5)
      - tapePenalty,
      0,
      100,
    );
    const risk = clamp(
      context.riskLoad * (this.mode === "calm" ? 1.2 : this.mode === "aggressive" ? 0.58 : 0.86)
      + reversalPenalty
      + profile.drawdownPct * (this.mode === "aggressive" ? 1.65 : 1)
      + Math.max(0, -context.agreement) * (this.mode === "calm" ? 7 : 4),
      0,
      100,
    );
    const edge = confidence - risk * (this.mode === "aggressive" ? 0.2 : this.mode === "calm" ? 0.5 : 0.34) - profile.patienceLevel * 4.5 - profile.convictionDemand * 3.5;
    const requiredEdge = this.minimumEdge(profile, context, snapshot);
    const meta = { edge, requiredEdge, tape: liveTape };
    const holdDecision = this.buildDecision("HOLD", context, profile, confidence, risk, 0, 0, meta);

    if (!ready) return this.buildDecision("WAIT", context, profile, confidence, risk, 0, 0, meta);

    if (context.heldQty > 0) {
      const heldMs = Date.now() - (context.openedAt || Date.now());
      // Give trades some breathing room (e.g. at least 15s-45s)
      const minHoldMs = this.mode === "calm" ? 45000 : this.mode === "aggressive" ? 15000 : 30000;
      const thesisFailed = context.shortMomentumPct < -Math.max(0.4, context.noisePct * (this.mode === "aggressive" ? 1.8 : 2.8)) && context.agreement < (this.mode === "calm" ? -0.2 : -0.4);
      const lateFailure = context.pnlPct < 0 && thesisFailed && heldMs >= minHoldMs;
      
      // High-Frequency Scalping Upgrade: Micro scalp targets
      const scalpTarget = this.mode === "calm" ? 0.20 : this.mode === "aggressive" ? 0.40 : 0.25;
      const scalpFade = context.pnlPct >= (scalpTarget * 0.8) && heldMs >= minHoldMs && context.shortMomentumPct < context.noisePct * (this.mode === "aggressive" ? 0.16 : 0.08);
      
      // Micro hold times: 1 min, 2 mins, 3 mins max
      const maxHoldMs = this.mode === "aggressive" ? 60000 : this.mode === "calm" ? 180000 : 120000;
      // Only trigger a time stop if the position is not in profit
      const timeStop = heldMs >= maxHoldMs && context.pnlPct <= 0;
      // Realistic soft loss thresholds
      const softLoss = this.mode === "calm" ? -0.6 : this.mode === "aggressive" ? -1.5 : -1.0;
      const profitEnough = context.pnlPct >= scalpTarget && (profile.timing.phase === "manage" || edge < requiredEdge + 3 || heldMs >= maxHoldMs * 0.55);

      // High-Frequency Scalping Upgrade: Hair-trigger dynamic trailing stops
      const trailTriggerPct = this.mode === "aggressive" ? 0.25 : this.mode === "calm" ? 0.15 : 0.20;
      const trailDistancePct = this.mode === "aggressive" ? 0.10 : this.mode === "calm" ? 0.05 : 0.08;
      const trailingStopHit = context.highWaterPrice > 0 && ((context.highWaterPrice - context.entry) / context.entry) * 100 >= trailTriggerPct && context.drawdownFromHighPct >= trailDistancePct;

      if (profile.timing.phase === "exit") {
        const urgency = clamp(1 - (profile.timing.remainingMs / Math.max(1, profile.timing.exitMs)), 0, 1);
        return this.buildDecision("EXIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "window closing" });
      }
      
      // Changed to fully EXIT position for these terminal states to prevent fractional selling loops
      if (trailingStopHit) return this.buildDecision("LOCK PROFIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "trailing stop hit" });
      if (context.pnlPct <= -holdDecision.stopLossPct) return this.buildDecision("EXIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "stop loss" });
      if (context.pnlPct <= softLoss && edge < requiredEdge) return this.buildDecision("EXIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "loss not recovering" });
      if (lateFailure) return this.buildDecision("EXIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "thesis failed" });
      if (profitEnough) return this.buildDecision("LOCK PROFIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "scalp captured" });
      if (context.pnlPct >= holdDecision.takeProfitPct && heldMs >= minHoldMs) return this.buildDecision("LOCK PROFIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "target reached" });
      if (scalpFade) return this.buildDecision("LOCK PROFIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "scalp fade" });
      if (timeStop) return this.buildDecision("EXIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "time stop" });
      if (heldMs >= minHoldMs && context.pnlPct > 0.08 && context.shortMomentumPct < -context.noisePct * 0.12) return this.buildDecision("EXIT", context, profile, confidence, risk, 0, 1, { ...meta, exitCause: "momentum rolled" });
      return holdDecision;
    }

    if (profile.timing.phase === "exit") return this.buildDecision("WATCH", context, profile, confidence, risk, 0, 0, meta);
    
    const notional = this.pacedNotional(context, profile, snapshot, edge, requiredEdge);
    if (notional >= Math.max(0.25, snapshot.capital * 0.01) && edge >= requiredEdge) return this.buildDecision("BUY", context, profile, confidence, risk, notional, 0, meta);
    return this.buildDecision(profile.timing.phase === "observe" ? "WAIT" : "WATCH", context, profile, confidence, risk, 0, 0, meta);
  }

  orderNotional(candidate, cash) {
    const profile = this.strategyProfile(botPortfolioSnapshot(this.mode));
    const currentValue = botHeldQuantity(this.mode, candidate.symbol) * candidate.price;
    const positionRoom = Math.max(0, (botCapital(this.mode) * profile.maxPosition) - currentValue);
    return Math.min(cash, positionRoom, Number(candidate.notional || 0));
  }

  runModeDecision(ranked) {
    const state = botState.modes[this.mode];
    state.rankings = ranked;
    state.decisions += 1;
    const snapshot = botPortfolioSnapshot(this.mode, ranked);
    const profile = this.strategyProfile(snapshot);
    const held = ranked.filter(item => botHeldQuantity(this.mode, item.symbol) > 0);
    let auditRow = null;

    for (const item of held) {
      const decision = this.brainFor(item, profile, snapshot);
      if ((decision.action === "EXIT" || decision.action === "REDUCE" || decision.action === "LOCK PROFIT") && item.heldQty > 0) {
        const qty = item.heldQty * (decision.sellFraction || 1);
        executeBotSell(this.mode, item, qty, this.decisionReason(decision, item));
        state.lastActionAt = Date.now();
        auditRow = { ...decision, action: "SELL", reason: this.decisionReason(decision, item) };
        botAppendRunAudit(this.mode, auditRow, ranked);
        return;
      }
    }

    const openSymbols = new Set(held.map(item => item.symbol));
    const candidates = ranked.filter(item => !openSymbols.has(item.symbol));
    const decisions = candidates.map(item => ({ context: item, decision: this.brainFor(item, profile, snapshot) }));
    const buy = decisions
      .filter(item => item.decision.action === "BUY")
      .sort((a, b) => (b.decision.confidence - b.decision.risk * 0.35) - (a.decision.confidence - a.decision.risk * 0.35))[0];

    if (buy) {
      const notional = this.orderNotional(buy.decision, snapshot.cash);
      if (notional >= Math.max(0.25, snapshot.capital * 0.01)) {
        executeBotBuy(this.mode, buy.context, notional, this.decisionReason({ ...buy.decision, notional }, buy.context));
        state.lastActionAt = Date.now();
        auditRow = { ...buy.decision, action: "BUY", notional, reason: this.decisionReason({ ...buy.decision, notional }, buy.context) };
        botAppendRunAudit(this.mode, auditRow, ranked);
        return;
      }
    }

    const top = [...decisions, ...held.map(context => ({ context, decision: this.brainFor(context, profile, snapshot) }))]
      .sort((a, b) => (b.decision.confidence - b.decision.risk * 0.25) - (a.decision.confidence - a.decision.risk * 0.25))[0];
    if (top) {
      const reason = this.decisionReason(top.decision, top.context);
      logBotDecision(this.mode, { action: top.decision.action, symbol: top.context.symbol, score: top.decision.score, confidence: top.decision.confidence, risk: top.decision.risk, reason }, { key: `${profile.timing.phase}:${top.decision.action}:${top.context.symbol}:${state.decisions}`, throttleMs: 0 });
      botAppendRunAudit(this.mode, { ...top.decision, reason }, ranked);
    }
  }
}
window.TraderBot = TraderBot;
