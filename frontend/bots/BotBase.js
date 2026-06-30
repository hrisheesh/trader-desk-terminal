// =============================================================================
// HFT Bot Engine — Z-Score Mean Reversion + Signal Gating
// =============================================================================
// Core principles (from real HFT research):
// 1. Z-Score mean reversion: Buy when price is statistically cheap (Z < -1.0)
// 2. Signal respect: NEVER buy when external signal says "Sell" with >70% conf
// 3. Fixed fractional sizing: Risk 2% of capital per trade
// 4. Selective entry: Only the BEST opportunity per decision cycle
// 5. Realistic timing: Hold 30s-5min, not 6 seconds
// =============================================================================

class TraderBot {
  constructor(mode) {
    this.mode = mode;
  }

  // ─── Mode Configuration ───────────────────────────────────────────────
  traits() {
    const traits = {
      calm: {
        label: "Calm micro-scalper",
        zBuyThreshold: -2.5,        // Extreme dip
        zSellThreshold: 0.5,        
        signalBlockConfidence: 65,   
        signalBoostConfidence: 70,   
        tradeSizePct: 0.10,          // 10% per trade
        maxPositionPct: 0.20,        // Max 20% in one coin
        maxExposurePct: 0.50,        // Max 50% deployed
        reservePct: 0.25,            // Keep 25% cash
        minHoldMs: 20000,            
        scratchTimeoutMs: 300000,    // 5 minutes
        maxHoldMs: 600000,           // 10 minutes
        hardStopPct: 0.30,           
        profitTargetPct: 0.04,       // Micro target
        trailTriggerPct: 0.02,       // Early trail
        trailDistancePct: 0.01,      // Extremely tight trail
        globalCooldownMs: 3000,      
        symbolCooldownMs: 15000,     
        minSamples: 10,              
      },
      normal: {
        label: "Normal micro-scalper",
        zBuyThreshold: -2.0,
        zSellThreshold: 0.8,
        signalBlockConfidence: 70,
        signalBoostConfidence: 75,
        tradeSizePct: 0.20,          // 20% per trade
        maxPositionPct: 0.35,        // Max 35% in one coin
        maxExposurePct: 0.85,        // Max 85% deployed
        reservePct: 0.10,            // Keep 10% cash
        minHoldMs: 15000,
        scratchTimeoutMs: 240000,    // 4 minutes
        maxHoldMs: 480000,           // 8 minutes
        hardStopPct: 0.30,
        profitTargetPct: 0.06,
        trailTriggerPct: 0.03,
        trailDistancePct: 0.015,
        globalCooldownMs: 2000,
        symbolCooldownMs: 10000,
        minSamples: 8,
      },
      aggressive: {
        label: "Aggressive micro-scalper",
        zBuyThreshold: -1.5,         
        zSellThreshold: 1.0,
        signalBlockConfidence: 75,    
        signalBoostConfidence: 60,
        tradeSizePct: 0.35,          // 35% per trade (FULL DEGEN)
        maxPositionPct: 0.50,        // Max 50% in one coin
        maxExposurePct: 1.00,        // 100% deployed
        reservePct: 0.00,            // Keep $0 in reserve
        minHoldMs: 10000,
        scratchTimeoutMs: 180000,    // 3 minutes
        maxHoldMs: 360000,           // 6 minutes
        hardStopPct: 0.30,
        profitTargetPct: 0.08,
        trailTriggerPct: 0.04,
        trailDistancePct: 0.02,
        globalCooldownMs: 1000,
        symbolCooldownMs: 6000,
        minSamples: 6,
      },
    };
    return traits[this.mode] || traits.normal;
  }

  // ─── Performance Tracking (kept from original — works fine) ────────────
  recentPerformance(limit = 24) {
    const state = botState.modes[this.mode];
    const sells = state.trades.filter((trade) => trade.side === "SELL").slice(0, limit);
    const capital = Math.max(1, Number(state.capital || BOT_MODES[this.mode]?.capital || 100));
    if (!sells.length) {
      return { trades: 0, winRate: 0.5, expectancyPct: 0, avgWinPct: 0, avgLossPct: 0, lossStreak: 0, realizedPct: 0 };
    }
    const wins = sells.filter((trade) => Number(trade.pnl || 0) > 0);
    const losses = sells.filter((trade) => Number(trade.pnl || 0) <= 0);
    const winRate = wins.length / sells.length;
    const avgWinPct = wins.length ? wins.reduce((sum, trade) => sum + (Number(trade.pnl || 0) / capital) * 100, 0) / wins.length : 0;
    const avgLossPct = losses.length ? Math.abs(losses.reduce((sum, trade) => sum + (Number(trade.pnl || 0) / capital) * 100, 0) / losses.length) : 0;
    let lossStreak = 0;
    for (const trade of sells) {
      if (Number(trade.pnl || 0) > 0) break;
      lossStreak += 1;
    }
    return {
      trades: sells.length,
      winRate,
      expectancyPct: winRate * avgWinPct - (1 - winRate) * avgLossPct,
      avgWinPct,
      avgLossPct,
      lossStreak,
      realizedPct: sells.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0) / capital * 100,
    };
  }

  symbolPerformance(symbol, limit = 12) {
    const sells = botState.modes[this.mode].trades
      .filter((trade) => trade.side === "SELL" && trade.symbol === symbol)
      .slice(0, limit);
    if (!sells.length) return { trades: 0, winRate: 0.5, lossStreak: 0, lastLoss: false };
    let lossStreak = 0;
    for (const trade of sells) {
      if (Number(trade.pnl || 0) > 0) break;
      lossStreak += 1;
    }
    return {
      trades: sells.length,
      winRate: sells.filter((trade) => Number(trade.pnl || 0) > 0).length / sells.length,
      lossStreak,
      lastLoss: Number(sells[0]?.pnl || 0) <= 0,
    };
  }

  // ─── Signal Gate ──────────────────────────────────────────────────────
  // Hard rule: If signal says SELL with high confidence, DO NOT BUY.
  isSignalBlocked(context) {
    const action = String(context.signalAction || "").toLowerCase();
    const confidence = Number(context.signalConfidence || 50);
    const traits = this.traits();
    
    if (action === "sell" && confidence >= traits.signalBlockConfidence) {
      return { blocked: true, reason: `signal says Sell ${confidence}%` };
    }
    return { blocked: false, reason: "" };
  }

  // Signal bonus: If signal agrees with our Z-Score buy, boost confidence
  signalBonus(context) {
    const action = String(context.signalAction || "").toLowerCase();
    const confidence = Number(context.signalConfidence || 50);
    const traits = this.traits();

    if (action === "buy" && confidence >= traits.signalBoostConfidence) {
      return (confidence - 50) * 0.3; // +0 to +15 bonus
    }
    if (action === "sell") {
      return -(confidence - 50) * 0.2; // -0 to -10 penalty
    }
    return 0;
  }

  // ─── Z-Score Entry Quality ────────────────────────────────────────────
  // The core HFT signal: Is this coin statistically cheap right now?
  entryQuality(context) {
    const traits = this.traits();
    const z = Number(context.zScore || 0);
    const momentum = Number(context.shortMomentumPct || 0);
    const noise = Math.max(0.01, Number(context.noisePct || 0));
    const rsi = Number(context.rsiProxy || 50);

    // Z-Score is the primary signal
    // Negative Z = price below mean = potential buy
    const zSignal = -z; // Flip sign: positive zSignal = good buy opportunity

    // Momentum confirmation: We want to buy when price is dipping but not crashing
    // A gentle dip (momentum slightly negative) is ideal for mean reversion
    const momentumQuality = momentum < 0 && momentum > -0.5 ? 15 : // Gentle dip — ideal
                            momentum > 0.05 ? 8 :                    // Slight uptick — recovery
                            momentum < -0.5 ? -10 : 0;               // Crash — avoid

    // RSI confirmation
    const rsiBonus = rsi < 35 ? 12 :   // Oversold — strong buy
                     rsi < 45 ? 6 :     // Leaning oversold
                     rsi > 65 ? -8 :    // Overbought — avoid buying
                     rsi > 55 ? -3 : 0; // Leaning overbought

    // Noise penalty — noisy markets are harder to scalp
    const noisePenalty = noise > 0.5 ? (noise - 0.5) * 20 : 0;

    const score = zSignal * 25 + momentumQuality + rsiBonus + this.signalBonus(context) - noisePenalty;
    
    return {
      score,
      zScore: z,
      zSignal,
      isBuyZone: z <= traits.zBuyThreshold,
      momentum,
      rsi,
      noise,
    };
  }

  // ─── Position Sizing: Fixed Fractional ────────────────────────────────
  // Simple and correct: risk a fixed % of capital per trade
  computeNotional(context, snapshot) {
    const traits = this.traits();
    const capital = Math.max(1, snapshot.capital);
    
    // Base trade size = fixed % of capital
    let notional = capital * traits.tradeSizePct;
    
    // Scale down if we're in a loss streak
    const perf = this.recentPerformance();
    if (perf.lossStreak >= 2) {
      notional *= Math.max(0.4, 1 - perf.lossStreak * 0.15);
    }
    
    // Enforce caps
    const currentValue = botHeldQuantity(this.mode, context.symbol) * context.price;
    const positionRoom = Math.max(0, capital * traits.maxPositionPct - currentValue);
    const exposureRoom = Math.max(0, capital * traits.maxExposurePct - snapshot.openValue);
    const cashRoom = Math.max(0, snapshot.cash - capital * (1 - traits.reservePct));
    
    notional = Math.min(notional, positionRoom, exposureRoom, cashRoom, snapshot.cash);
    
    return Math.max(0, notional);
  }

  // ─── Cooldown Check ───────────────────────────────────────────────────
  isCooldownReady(symbol) {
    const state = botState.modes[this.mode];
    const traits = this.traits();
    const now = Date.now();
    const globalReady = !state.lastActionAt || now - state.lastActionAt >= traits.globalCooldownMs;
    const symbolReady = !state.lastTradeAt[symbol] || now - state.lastTradeAt[symbol] >= traits.symbolCooldownMs;
    return globalReady && symbolReady;
  }

  // ─── Build Decision Object ────────────────────────────────────────────
  buildDecision(action, context, meta = {}) {
    const traits = this.traits();
    return {
      action,
      symbol: context.symbol,
      price: Number(context.price || 0),
      confidence: Number(meta.confidence || 0),
      risk: Number(meta.risk || 0),
      edge: Number(meta.edge || 0),
      requiredEdge: Number(meta.requiredEdge || 0),
      setupType: meta.setupType || "z-score mean reversion",
      blockedBy: meta.blockedBy || "",
      style: traits.label,
      phase: meta.phase || "",
      notional: Number(meta.notional || 0),
      sellFraction: Number(meta.sellFraction || 0),
      stopLossPct: traits.hardStopPct,
      takeProfitPct: traits.profitTargetPct,
      exitCause: meta.exitCause || "",
      zScore: Number(meta.zScore || context.zScore || 0),
    };
  }

  // ─── Format Reason String ─────────────────────────────────────────────
  decisionReason(decision, context) {
    const actionText = decision.action === "BUY" ? `buy $${formatPrice(decision.notional || 0)}` : decision.action.toLowerCase();
    const blockText = decision.blockedBy ? `; blocked by ${decision.blockedBy}` : "";
    const exitText = decision.exitCause ? `; ${decision.exitCause}` : "";
    const zText = `; Z=${(decision.zScore || 0).toFixed(2)}`;
    return `${actionText}; ${decision.style}; setup ${decision.setupType}; confidence ${Math.round(decision.confidence)}; risk ${Math.round(decision.risk)}; edge ${(decision.edge || 0).toFixed(1)}/${(decision.requiredEdge || 0).toFixed(1)}${exitText}${blockText}${zText}; samples ${context.samples}; pnl ${context.pnlPct >= 0 ? "+" : ""}${context.pnlPct.toFixed(2)}%; momentum ${context.shortMomentumPct >= 0 ? "+" : ""}${context.shortMomentumPct.toFixed(2)}%; noise ${context.noisePct.toFixed(2)}%; ${context.signalAction} signal ${context.signalConfidence}%`;
  }

  // ─── EXIT DECISION ────────────────────────────────────────────────────
  // Determines whether to hold or exit an existing position
  exitDecision(context, snapshot) {
    const traits = this.traits();
    const heldMs = Date.now() - Number(context.openedAt || Date.now());
    const pnl = Number(context.pnlPct || 0);
    const z = Number(context.zScore || 0);
    const perf = this.recentPerformance();
    const timing = botRunTiming(this.mode);
    
    const meta = {
      phase: timing.phase,
      confidence: 50,
      risk: 0,
      edge: 0,
      requiredEdge: 0,
      zScore: z,
    };

    // 1. Window closing — dump everything
    if (timing.phase === "exit") {
      return this.buildDecision("EXIT", context, { ...meta, exitCause: "window closing", sellFraction: 1 });
    }

    // 2. Hard stop loss — protect capital
    if (pnl <= -traits.hardStopPct) {
      return this.buildDecision("EXIT", context, { ...meta, exitCause: "hard stop", sellFraction: 1 });
    }

    // 3. Profit target hit — take the money
    if (pnl >= traits.profitTargetPct) {
      return this.buildDecision("LOCK PROFIT", context, { ...meta, exitCause: "profit target", sellFraction: 1 });
    }

    // 4. Trailing stop — protect profits
    if (pnl >= traits.trailTriggerPct && context.drawdownFromHighPct >= traits.trailDistancePct) {
      return this.buildDecision("LOCK PROFIT", context, { ...meta, exitCause: "trailing stop", sellFraction: 1 });
    }

    // 5. Z-Score reversion complete — price reverted above mean, take profit
    if (pnl > 0.02 && z >= traits.zSellThreshold) {
      return this.buildDecision("LOCK PROFIT", context, { ...meta, exitCause: "z-score reversion complete", sellFraction: 1, setupType: "z-reversion exit" });
    }

    // 6. Adverse signal while in profit — don't let winners become losers
    const signalAction = String(context.signalAction || "").toLowerCase();
    const signalConf = Number(context.signalConfidence || 50);
    if (pnl > 0.01 && signalAction === "sell" && signalConf >= 70) {
      return this.buildDecision("LOCK PROFIT", context, { ...meta, exitCause: "adverse signal while green", sellFraction: 1 });
    }

    // 7. Scratch timeout — if trade is flat after scratch period, dump it
    if (heldMs >= traits.scratchTimeoutMs && pnl < traits.profitTargetPct * 0.4) {
      return this.buildDecision("EXIT", context, { ...meta, exitCause: "scratch timeout", sellFraction: 1 });
    }

    // 8. Max hold timeout — only if not in meaningful profit
    if (heldMs >= traits.maxHoldMs && pnl < traits.profitTargetPct * 0.6) {
      return this.buildDecision("EXIT", context, { ...meta, exitCause: "max hold timeout", sellFraction: 1 });
    }

    // 9. Loss streak safety — if we're on a loss streak and this trade is underwater, cut early
    if (perf.lossStreak >= 3 && pnl < -traits.hardStopPct * 0.4 && heldMs >= traits.minHoldMs) {
      return this.buildDecision("EXIT", context, { ...meta, exitCause: "loss streak safety cut", sellFraction: 1 });
    }

    return this.buildDecision("HOLD", context, meta);
  }

  // ─── ENTRY DECISION ───────────────────────────────────────────────────
  // Determines whether to buy a coin we don't currently hold
  entryDecision(context, snapshot) {
    const traits = this.traits();
    const timing = botRunTiming(this.mode);
    const blocks = [];

    const meta = {
      phase: timing.phase,
      confidence: 0,
      risk: 0,
      edge: 0,
      requiredEdge: 10,
      zScore: Number(context.zScore || 0),
    };

    // ── Pre-checks (hard blocks) ──
    
    // Not enough data yet
    if (context.samples < traits.minSamples) {
      return this.buildDecision("WAIT", context, { ...meta, blockedBy: `warming ${context.samples}/${traits.minSamples}` });
    }

    // Window closing — no new entries
    if (timing.phase === "exit") {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: "window closing" });
    }

    // Signal gate — HARD BLOCK
    const signalCheck = this.isSignalBlocked(context);
    if (signalCheck.blocked) {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: signalCheck.reason });
    }

    // Cooldown
    if (!this.isCooldownReady(context.symbol)) {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: "cooldown" });
    }

    // Symbol on a loss streak — cool off
    const symPerf = this.symbolPerformance(context.symbol);
    if (symPerf.lossStreak >= 3) {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: `symbol ${context.symbol} cooling (${symPerf.lossStreak} losses)` });
    }

    // ── Z-Score Analysis ──
    const quality = this.entryQuality(context);

    // Compute confidence and risk
    const confidence = clamp(40 + quality.score, 0, 100);
    const risk = clamp(
      quality.noise * 18
      + Math.max(0, -quality.momentum) * 12
      + (quality.rsi > 55 ? (quality.rsi - 55) * 0.5 : 0)
      + this.recentPerformance().lossStreak * 4,
      0,
      100
    );
    const edge = confidence - risk * 0.5;
    const requiredEdge = 10 + this.recentPerformance().lossStreak * 2;

    meta.confidence = confidence;
    meta.risk = risk;
    meta.edge = edge;
    meta.requiredEdge = requiredEdge;
    meta.setupType = quality.isBuyZone ? "z-score dip buy" : "momentum scalp";

    // ── Entry gates ──
    
    // Z-Score must be in buy zone OR momentum must be strongly positive
    const zOk = quality.isBuyZone;
    const momentumOk = quality.momentum > 0.05 && quality.rsi < 55;
    
    if (!zOk && !momentumOk) {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: `Z=${quality.zScore.toFixed(2)} not in buy zone (need <${traits.zBuyThreshold})` });
    }

    // Edge must clear the bar
    if (edge < requiredEdge) {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: `edge ${edge.toFixed(1)} < required ${requiredEdge.toFixed(1)}` });
    }

    // ── Size the trade ──
    const notional = this.computeNotional(context, snapshot);
    const minTrade = Math.max(BOT_MIN_TRADE_NOTIONAL, snapshot.capital * 0.005);
    
    if (notional < minTrade) {
      return this.buildDecision("WATCH", context, { ...meta, blockedBy: "insufficient sizing room" });
    }

    meta.notional = notional;
    return this.buildDecision("BUY", context, meta);
  }

  // ─── Order Notional (caps for execution) ──────────────────────────────
  orderNotional(candidate, cash) {
    const snapshot = botPortfolioSnapshot(this.mode);
    const traits = this.traits();
    return Math.min(cash, Number(candidate.notional || 0), snapshot.capital * traits.maxPositionPct);
  }

  // ─── Rank candidates by entry quality ─────────────────────────────────
  rankDecision(item) {
    const z = Number(item.decision.zScore || 0);
    return -z * 20 + (item.decision.confidence || 0) * 0.3 - (item.decision.risk || 0) * 0.2;
  }

  // ─── MAIN DECISION LOOP ───────────────────────────────────────────────
  runModeDecision(ranked) {
    const state = botState.modes[this.mode];
    state.rankings = ranked;
    state.decisions += 1;

    const snapshot = botPortfolioSnapshot(this.mode, ranked);
    const held = ranked.filter((item) => botHeldQuantity(this.mode, item.symbol) > 0);

    // ── Step 1: Check all held positions for exits ──
    for (const item of held) {
      const decision = this.exitDecision(item, snapshot);
      if ((decision.action === "EXIT" || decision.action === "LOCK PROFIT") && item.heldQty > 0) {
        const reason = this.decisionReason(decision, item);
        executeBotSell(this.mode, item, item.heldQty * (decision.sellFraction || 1), reason);
        state.lastActionAt = Date.now();
        botAppendRunAudit(this.mode, { ...decision, reason }, ranked);
        return;
      }
    }

    // ── Step 2: Find the BEST single entry opportunity ──
    const openSymbols = new Set(held.map((item) => item.symbol));
    const decisions = ranked
      .filter((item) => !openSymbols.has(item.symbol))
      .map((context) => ({ context, decision: this.entryDecision(context, snapshot) }))
      .sort((a, b) => this.rankDecision(b) - this.rankDecision(a));
    
    // Only take the BEST buy (selectivity > volume)
    const buy = decisions.find((item) => item.decision.action === "BUY");

    if (buy) {
      const notional = this.orderNotional(buy.decision, snapshot.cash);
      if (notional > 0) {
        const decision = { ...buy.decision, notional };
        const reason = this.decisionReason(decision, buy.context);
        executeBotBuy(this.mode, buy.context, notional, reason);
        state.lastActionAt = Date.now();
        botAppendRunAudit(this.mode, { ...decision, action: "BUY", reason }, ranked);
        return;
      }
    }

    // ── Step 3: Log the top-ranked decision for audit ──
    const top = [...held.map((context) => ({ context, decision: this.exitDecision(context, snapshot) })), ...decisions]
      .sort((a, b) => this.rankDecision(b) - this.rankDecision(a))[0];
    if (!top) return;
    const reason = this.decisionReason(top.decision, top.context);
    logBotDecision(this.mode, {
      action: top.decision.action,
      symbol: top.context.symbol,
      confidence: top.decision.confidence,
      risk: top.decision.risk,
      reason,
    }, { key: `${top.decision.phase}:${top.decision.action}:${top.context.symbol}:${state.decisions}`, throttleMs: 0 });
    botAppendRunAudit(this.mode, { ...top.decision, reason }, ranked);
  }
}

window.TraderBot = TraderBot;
