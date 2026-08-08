class TraderBot {
  constructor(mode, tickMs = 1000) {
    this.mode = mode;
    this.tickMs = tickMs;
    this.running = false;
    this.worker = new window.SwarmWorker(mode);
  }

  // Subclasses override this to define personality / risk params.
  traits() { return {}; }

  start() {
    this.running = true;
    if (window.botState) window.botState.running = true;
  }

  stop() {
    this.running = false;
  }

  // Feature builder used by tests / direct API calls.
  async evaluate(quote) {
    return this.worker.evaluate(quote);
  }

  // Phase from the app scheduler. Falls back to "trade" when the app
  // timing helper is absent (unit tests), so the loop still trades.
  timing() {
    if (window.botRunTiming) return window.botRunTiming(this.mode);
    return { phase: "trade", elapsedMs: 0, remainingMs: Infinity, progress: 0 };
  }

  async tick() {
    if (!this.running) return;
    const universe = typeof window.getBotUniverseQuotes === "function" ? window.getBotUniverseQuotes() : [];
    const results = await Promise.all(universe.map(q => this.worker.evaluate(q).catch(() => null)));
    const ranked = results.filter(Boolean).sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));
    if (ranked.length) this.runModeDecision(ranked);
  }

  learning() {
    return window.botLearning ? window.botLearning.getParams(this.mode, this.traits()) : this.defaultParams();
  }

  defaultParams() {
    const t = this.traits();
    return {
      winRate: 0.5, payoff: 1, kelly: 0, momentum: 0, conviction: t.convictionBias,
      minEdge: t.minEdgeBase, stopPct: t.stopLossBase + 1.5 * t.stopLossVol,
      targetPct: t.takeProfitBase + 1.5 * t.takeProfitVol, trailPct: t.stopLossBase,
      riskMultiplier: 1, setupEdge: {}, symbolEdge: {}, trades: 0, pnl: 0,
    };
  }

  runModeDecision(ranked) {
    const state = window.botState.modes[this.mode];
    state.rankings = ranked;
    state.decisions += 1;

    const timing = this.timing();
    const snapshot = window.botPortfolioSnapshot(this.mode, ranked);
    const profile = this.traits();
    const multiplier = this.multiplierProfile();
    const L = this.learning();
    const held = ranked.filter(item => window.botHeldQuantity(this.mode, item.symbol) > 0);

    // 1. Manage risk first: exits before entries, in every phase.
    for (const item of held) {
      const position = window.botState.modes[this.mode].positions[item.symbol];
      if (position) {
        position.lastMarkPrice = Number(item.price) || position.lastMarkPrice || position.avgPrice;
        position.lastMarkAt = Date.now();
      }
      const decision = this.evaluateExit(item, snapshot, L, timing);
      if ((decision.action === "EXIT" || decision.action === "REDUCE" || decision.action === "LOCK PROFIT") && item.heldQty > 0) {
        const qty = item.heldQty * (decision.sellFraction || 1);
        const candidate = { ...item, ...decision, setupType: item.setupType || profile.strategy };
        window.executeBotSell(this.mode, candidate, qty, decision.reason);
        if (window.botAppendRunAudit) {
          window.botAppendRunAudit(this.mode, { action: decision.action, symbol: item.symbol, price: item.price, reason: decision.reason, setupType: candidate.setupType, multiplier: position?.multiplier === true, freeHand: position?.freeHand === true }, ranked);
        }
        return;
      }
    }

    // Warm-up is a real evidence-building phase. It may update the swarm and
    // learn the tape, but it cannot open a position. This keeps the first
    // trade explainable instead of allowing a thin first sample or fallback
    // to look like an impulsive buy.
    if (timing.phase === "observe") {
      const lead = ranked[0];
      const reason = `Warm-up: collecting swarm evidence (${Math.max(...ranked.map(item => Number(item.samples || 0)), 0)} samples); no entry`;
      window.logBotDecision(this.mode, { action: "WATCH", symbol: lead?.symbol, score: lead?.score, reason }, { key: "warm-up", throttleMs: 2500 });
      if (window.botAppendRunAudit) window.botAppendRunAudit(this.mode, {
        action: "WATCH", blockedBy: "warm-up", symbol: lead?.symbol, score: lead?.score, reason, multiplier: multiplier.enabled,
      }, ranked);
      return;
    }

    // 2. After warm-up, entries are free to happen throughout the active
    // window. The runtime check below prevents a late entry from becoming a
    // deadline-bound position.
    const openSymbols = new Set(held.map(item => item.symbol));
    const candidates = ranked
      .filter(item => !openSymbols.has(item.symbol))
      .filter(item => this.cooldownElapsed(item))
      .filter(item => this.positionRoomRemains(snapshot))
      .filter(item => this.verdictPasses(item));

    const decisions = candidates.map(item => ({ context: item, decision: this.evaluateEntry(item, snapshot, L, timing) }));
    let buy = decisions
      .filter(item => item.decision.action === "BUY")
      .sort((a, b) => (b.decision.edgeScore || 0) - (a.decision.edgeScore || 0))
      .find(({ context, decision }) => {
        const requiredMs = this.entryRuntimeRequired(context, decision);
        const remainingMs = Number(timing.remainingMs);
        if (Number.isFinite(remainingMs) && remainingMs < requiredMs) {
          const multiplierLateShot = multiplier.enabled
            && remainingMs >= Math.max(45_000, Number(timing.durationMs || 0) * 0.1);
          if (multiplierLateShot) {
            const scale = this._clamp(remainingMs / requiredMs, 0.25, 1);
            if (Number(decision.takeProfitPct || 0) > 0) {
              decision.takeProfitPct = this._clamp(
                decision.takeProfitPct * scale,
                this.traits().tpFloor || 0.3,
                decision.takeProfitPct,
              );
            }
            decision.stopLossPct = this._clamp(
              decision.stopLossPct * scale,
              this.traits().stopFloor || 0.3,
              decision.stopLossPct,
            );
            decision.runtimeAdjusted = true;
            decision.reason = Number(decision.takeProfitPct || 0) > 0
              ? `Multiplier entry resized for ${Math.ceil(remainingMs / 1000)}s left: stop ${decision.stopLossPct.toFixed(2)}% tp ${decision.takeProfitPct.toFixed(2)}%`
              : `Free-hand entry sized for ${Math.ceil(remainingMs / 1000)}s left: stop ${decision.stopLossPct.toFixed(2)}% · momentum exit`;
            return true;
          }
          // Very short demo runs can still take a small, fast scalp. Resize
          // its plan to the time left; normal runs block the late entry.
          const shortRun = Number(timing.durationMs || 0) > 0 && timing.durationMs < requiredMs;
          const quickTradeMs = Math.max(30_000, Number(timing.durationMs || 0) * 0.2);
          if (shortRun && remainingMs >= quickTradeMs) {
            const scale = this._clamp(remainingMs / requiredMs, 0.2, 1);
            decision.takeProfitPct = this._clamp(
              decision.takeProfitPct * scale,
              this.traits().tpFloor || 0.3,
              decision.takeProfitPct,
            );
            decision.stopLossPct = this._clamp(
              decision.stopLossPct * scale,
              this.traits().stopFloor || 0.3,
              decision.stopLossPct,
            );
            decision.runtimeAdjusted = true;
            decision.reason = `Late entry resized for ${Math.ceil(remainingMs / 1000)}s left: stop ${decision.stopLossPct.toFixed(2)}% tp ${decision.takeProfitPct.toFixed(2)}%`;
            return true;
          }
          decision.action = "WATCH";
          decision.blockedBy = "runtime";
          decision.reason = `Late entry blocked: ${Math.ceil(remainingMs / 1000)}s left; needs ${Math.ceil(requiredMs / 1000)}s`;
          return false;
        }
        return true;
      });

    // Free-hand mode has one deliberate fallback: if the normal personality
    // gate finds no BUY, use the strongest fresh swarm thesis with a modest
    // confidence floor. This prevents a short run from idling while still
    // avoiding random or stale-feed entries.
    if (!buy && multiplier.enabled) {
      buy = this.multiplierFallback(ranked, snapshot, L, timing);
    }

    if (buy) {
      const notional = this.calculateOrderNotional({ ...buy.context, ...buy.decision }, snapshot, L);
      if (notional >= Math.max(0.25, snapshot.capital * 0.01)) {
        const candidate = {
          ...buy.context, ...buy.decision, notional,
          setupType: buy.context.setupType || profile.strategy,
          stopLossPct: buy.decision.stopLossPct || L.stopPct,
          takeProfitPct: buy.decision.takeProfitPct !== undefined ? buy.decision.takeProfitPct : L.targetPct,
          trailPct: buy.decision.trailPct || L.trailPct,
          runtimeAdjusted: buy.decision.runtimeAdjusted === true,
          multiplier: multiplier.enabled,
          freeHand: multiplier.enabled && buy.decision.freeHand !== false,
          multiplierSize: multiplier.sizeMultiplier,
        };
        const entryReason = multiplier.enabled
          ? `MULTIPLIER ×${multiplier.sizeMultiplier.toFixed(1)} · ${buy.decision.reason}`
          : buy.decision.reason;
        const placed = window.executeBotBuy(this.mode, candidate, notional, entryReason) !== false;
        if (window.botAppendRunAudit) {
          window.botAppendRunAudit(this.mode, {
            action: placed ? "BUY" : "WATCH",
            blockedBy: placed ? "" : "minimum-notional",
            symbol: candidate.symbol,
            price: candidate.price,
            notional,
            reason: placed ? entryReason : `Trade not placed: $${notional.toFixed(2)} is below the account minimum`,
            setupType: candidate.setupType,
            confidence: candidate.confidence,
            risk: candidate.risk || 0,
            edge: buy.decision.edgeScore,
            requiredEdge: buy.decision.requiredEdge || L.minEdge,
            stopLossPct: candidate.stopLossPct,
            takeProfitPct: candidate.takeProfitPct,
            multiplier: multiplier.enabled,
            freeHand: candidate.freeHand,
          }, ranked);
        }
        return;
      }
    }

    // 3. Log observation for the top symbol so the tape stays alive.
    const top = decisions[0] || (held[0] ? { context: held[0], decision: this.evaluateExit(held[0], snapshot, L, timing) } : null);
    if (top) {
      const action = top.decision.action === "WAIT" ? "WAIT" : "WATCH";
      const coT = top.context.reasoning && top.context.reasoning.summary ? ` | ${top.context.reasoning.summary}` : "";
      window.logBotDecision(this.mode, {
        action,
        symbol: top.context.symbol,
        score: top.decision.score,
        reason: `${top.decision.reason || "Scanning"} | learned ${L.trades} trades | win ${(L.winRate * 100).toFixed(0)}% | kelly ${(L.kelly * 100).toFixed(1)}%${coT}`,
      }, { key: `${action}:${top.context.symbol}:${Math.round((top.decision.edgeScore || 0) / 4)}`, throttleMs: action === "WAIT" ? 2500 : 4500 });
      if (window.botAppendRunAudit) {
        window.botAppendRunAudit(this.mode, {
          action,
          blockedBy: top.decision.blockedBy || (action === "WAIT" ? "observation" : "entry-filter"),
          symbol: top.context.symbol,
          price: top.context.price,
          score: top.decision.score,
          confidence: top.decision.confidence,
          risk: top.decision.risk || top.context.riskLoad || 0,
          edge: top.decision.edgeScore || 0,
          requiredEdge: top.decision.requiredEdge || L.minEdge,
          setupType: top.context.setupType,
          reason: `${top.decision.reason || "Scanning"}${coT}`,
          multiplier: multiplier.enabled,
          freeHand: top.decision.freeHand === true,
        }, ranked);
      }
    }
  }

  multiplierFallback(ranked, snapshot, L, timing) {
    const t = this.traits();
    const limits = this.multiplierProfile();
    if (!limits.enabled || !this.positionRoomRemains(snapshot)) return null;
    const minSamples = Number(limits.entry?.minSamples || t.minSamples || 5);
    const maxRisk = Number(limits.entry?.maxRiskLoad || t.maxRiskLoad || 70);
    const fallback = ranked.find(item => {
      if (window.botHeldQuantity(this.mode, item.symbol) > 0 || !this.cooldownElapsed(item)) return false;
      if (item.feedStale || Number(item.samples || 0) < minSamples) return false;
      if (Number(item.riskLoad || 0) > maxRisk) return false;
      if (t.directionalBias !== "reversion") {
        if (item.signalAction === "Sell") return false;
        const rsi = Number(item.rsiProxy || 50);
        const zScore = Number(item.zScore || 0);
        const impulse = this.isMultiplierImpulse(item, t);
        if (((t.maxEntryRsi && rsi > t.maxEntryRsi) || (t.maxEntryZ && zScore > t.maxEntryZ)) && !impulse) return false;
        const verdict = item.verdict || {};
        const setup = item.setupType || "unknown";
        const setupShot = Number(item.moveZ || 0) >= 0.45
          && Number(verdict.confidence || 0) >= 40;
        return (impulse || setupShot)
          && verdict.direction === "bullish"
          && Number(verdict.confidence || 0) >= 40
          && Number(item.shortMomentumPct || 0) >= -0.02
          && Number(item.moveZ || 0) >= 0.35;
      }
      return Number(item.zScore || 0) <= -0.9
        && Number(item.shortMomentumPct || 0) >= -0.02;
    });
    if (!fallback) return null;

    const liveVol = Math.max(0.02, Number(fallback.liveVolPct) || Number(fallback.volatilityPct) || 0.05);
    const expectedMove = Math.max(0.05, liveVol * Math.sqrt(20), Math.abs(Number(fallback.shortMomentumPct || 0)) * 1.25);
    const stopLossPct = this._clamp(
      Math.max(expectedMove * (t.stopMoveMultiple || 1), limits.minStopPct),
      t.stopFloor || 0.3,
      t.stopCap || 6,
    );
    const requiredEdge = Math.max(limits.minEdgeFloor, Number(L.minEdge || 0) - limits.edgeDiscount);
    const edgeScore = Math.max(Number(fallback.rankScore || 0), Number(fallback.score || 0));
    let decision = {
      action: "BUY",
      score: Math.round(Math.max(edgeScore, requiredEdge)),
      confidence: Number(fallback.verdict?.confidence || 0),
      edgeScore,
      requiredEdge,
      risk: Number(fallback.riskLoad || 0),
      stopLossPct,
      takeProfitPct: 0,
      trailPct: this._clamp(Math.max(stopLossPct * 0.55, limits.minTrailPct), 0.2, 4.5),
      freeHand: true,
      reason: `MULTIPLIER free-hand · swarm ${fallback.setupType || "unknown"}/${fallback.regime || "live"} · confidence ${Number(fallback.verdict?.confidence || 0)} · momentum decides the exit`,
    };
    const notional = this.calculateOrderNotional({ ...fallback, ...decision }, snapshot, L);
    const minNotional = Math.max(0.25, Number(snapshot.capital || 0) * 0.01);
    if (notional < minNotional) return null;
    const remainingMs = Number(timing.remainingMs);
    const requiredMs = this.entryRuntimeRequired(fallback, decision);
    if (Number.isFinite(remainingMs) && remainingMs < requiredMs) {
      if (remainingMs < Math.max(45_000, Number(timing.durationMs || 0) * 0.1)) return null;
      const scale = this._clamp(remainingMs / requiredMs, 0.25, 1);
      decision = {
        ...decision,
        stopLossPct: this._clamp(decision.stopLossPct * scale, t.stopFloor || 0.3, decision.stopLossPct),
        runtimeAdjusted: true,
        reason: `MULTIPLIER late free-hand entry resized for ${Math.ceil(remainingMs / 1000)}s left · ${decision.reason}`,
      };
    }
    return { context: fallback, decision: { ...decision, notional, requiredEdge } };
  }

  isFreshBreakout(item, t) {
    if (item.setupType !== "breakout") return false;
    const moveZ = Number(item.moveZ || 0);
    const dayRangePos = Number(item.dayRangePos || 0);
    const resistanceDistance = Number(item.resistanceDistancePct || item.dayHighDistancePct || 99);
    const shortMomentum = Number(item.shortMomentumPct || 0);
    const verdict = item.verdict && item.verdict.direction;
    return moveZ >= (t.freshBreakoutMoveZ || 1.5)
      && shortMomentum > 0
      && (dayRangePos >= 0.78 || resistanceDistance <= 1.0)
      && verdict === "bullish"
      && item.signalAction !== "Sell";
  }

  isMultiplierImpulse(item, t) {
    const moveZ = Number(item.moveZ || 0);
    const shortMomentum = Number(item.shortMomentumPct || 0);
    const dayRangePos = Number(item.dayRangePos || 0);
    const resistanceDistance = Number(item.resistanceDistancePct || item.dayHighDistancePct || 99);
    const verdict = item.verdict || {};
    return moveZ >= 1.8
      && shortMomentum > 0
      && Number(verdict.confidence || 0) >= 45
      && verdict.direction === "bullish"
      && (dayRangePos >= 0.7 || resistanceDistance <= 1.2)
      && item.signalAction !== "Sell";
  }

  entryRuntimeRequired(item, decision) {
    const t = this.traits();
    const maxHoldMs = Math.max(30_000, Number(t.maxHoldMs || 10 * 60 * 1000));
    const holdBuffer = maxHoldMs * this._clamp(t.entryRuntimeFraction || 0.25, 0.15, 0.5);
    const liveVol = Math.max(0.02, Number(item.liveVolPct) || Number(item.volatilityPct) || 0.05);
    const expectedMove = Math.max(0.05, liveVol * Math.sqrt(20));
    const targetPct = Math.max(0.1, Number(decision.takeProfitPct || 0));
    const targetHorizon = this._clamp(
      (targetPct / expectedMove) * 30_000,
      30_000,
      maxHoldMs * 0.75,
    );
    return Math.min(maxHoldMs, Math.max(30_000, holdBuffer, targetHorizon) + 15_000);
  }

  verdictPasses(item) {
    const verdict = item.verdict;
    if (!verdict) return true;
    const t = this.traits();
    // Reversion bosses buy oversold dips (bearish/bullish flips), so a
    // "bullish" verdict is not required for them. Everyone else needs a
    // bullish lean.
    if (t.directionalBias === "reversion") {
      return true;
    }
    if (verdict.direction === "neutral") return false;
    if (verdict.direction === "bearish") return false;
    return Number(verdict.confidence || 0) >= (t.verdictMinConfidence || 25);
  }

  cooldownElapsed(item) {
    const t = this.traits();
    const lastTradeAt = window.botState.modes[this.mode].lastTradeAt[item.symbol] || 0;
    return Date.now() - lastTradeAt >= (t.cooldownMs || 0);
  }

  positionRoomRemains(snapshot) {
    const limits = this.multiplierProfile();
    const accountValue = Math.max(0.25, Number(snapshot.totalValue || snapshot.capital || 0));
    const exposurePct = accountValue ? snapshot.openValue / accountValue : 0;
    if (exposurePct >= limits.maxExposure) return false;
    const openCount = Object.keys(window.botState.modes[this.mode].positions).length;
    return openCount < limits.maxPositions;
  }

  multiplierProfile() {
    const t = this.traits();
    const base = {
      enabled: false,
      sizeMultiplier: 1,
      maxPosition: Number(t.maxPosition || 0.5),
      maxExposure: Number(t.maxExposure || 0.5),
      maxPositions: Number(t.maxPositions || 8),
      edgeDiscount: 0,
      minEdgeFloor: Number(t.minEdgeFloor || t.minEdgeBase || 0),
      allocationMin: 0,
      allocationMax: 1,
      minStopPct: 0,
      minTrailPct: 0,
      entry: {},
    };
    const enabled = typeof window.botMultiplierEnabled === "function"
      ? window.botMultiplierEnabled()
      : false;
    if (!enabled) return base;

    // Multiplier mode is free-hand: the swarm chooses the allocation and
    // momentum/learning chooses the exit. Stops, stale-feed protection and
    // the run deadline remain hard safety rails.
    const limits = {
      calm: {
        sizeMultiplier: 4.5, maxPosition: 1.0, maxExposure: 1.0, maxPositions: 8,
        allocationMin: 0.18, allocationMax: 0.82, minStopPct: 0.75, minTrailPct: 0.5,
        edgeDiscount: 6, minEdgeFloor: 38,
        entry: { minSamples: 6, maxRiskLoad: 55, maxNoise: 2.4, minZ: -0.55, minReversionMomZ: -0.8, minMoveZ: 0.75 },
      },
      normal: {
        sizeMultiplier: 6.0, maxPosition: 1.0, maxExposure: 1.0, maxPositions: 8,
        allocationMin: 0.24, allocationMax: 0.94, minStopPct: 0.95, minTrailPct: 0.6,
        edgeDiscount: 6, minEdgeFloor: 36,
        entry: { minSamples: 5, maxRiskLoad: 72, minMomentum: 0.04, minMoveZ: 0.25 },
      },
      aggressive: {
        sizeMultiplier: 8.0, maxPosition: 1.0, maxExposure: 1.0, maxPositions: 8,
        allocationMin: 0.35, allocationMax: 1.0, minStopPct: 1.25, minTrailPct: 0.75,
        edgeDiscount: 5, minEdgeFloor: 32,
        entry: { minSamples: 4, maxRiskLoad: 90, minAcceleration: 0.18, minMomentum: 0.12, minMoveZ: 0.35 },
      },
    }[this.mode] || {};
    return { ...base, ...limits, enabled: true };
  }

  // ------------------------------------------------------------------
  // Entry brain. Each personality has a genuinely different entry bias,
  // so the three bots disagree about what "good" looks like.
  // ------------------------------------------------------------------
  evaluateEntry(item, snapshot, L, timing) {
    const baseTraits = this.traits();
    const multiplier = this.multiplierProfile();
    const t = multiplier.enabled ? { ...baseTraits, ...(multiplier.entry || {}) } : baseTraits;
    const requiredEdge = multiplier.enabled
      ? Math.max(multiplier.minEdgeFloor, Number(L.minEdge || 0) - multiplier.edgeDiscount)
      : L.minEdge;
    const samples = Number(item.samples || 0);
    if (samples < (t.minSamples || 5)) {
      return { action: "WAIT", score: 0, edgeScore: 0, reason: `Collecting data ${samples}/${t.minSamples || 5}`, risk: item.riskLoad || 0 };
    }

    const setup = item.setupType || "unknown";
    const preferred = t.preferredSetups || ["trend", "breakout", "pullback", "reversion", "momentum"];
    if (!preferred.includes(setup)) {
      return { action: "WATCH", score: 0, edgeScore: 0, reason: `Setup '${setup}' not in ${t.label} preference`, risk: item.riskLoad || 0 };
    }

    const risk = Number(item.riskLoad || 0);
    if (risk > (t.maxRiskLoad || 70)) {
      return { action: "WATCH", score: 0, edgeScore: 0, reason: `Too risky (${risk.toFixed(0)}) for ${t.label}`, risk };
    }

    // A rising EMA alone is not enough to chase a stretched tape. Normal and
    // aggressive entries must either be inside the entry envelope or be a
    // genuinely fresh breakout with new range expansion.
    if (t.directionalBias !== "reversion") {
      const rsi = Number(item.rsiProxy || 50);
      const zScore = Number(item.zScore || 0);
      const overextended = (t.maxEntryRsi && rsi > t.maxEntryRsi)
        || (t.maxEntryZ && zScore > t.maxEntryZ);
      if (overextended && !this.isFreshBreakout(item, t) && !(multiplier.enabled && this.isMultiplierImpulse(item, t))) {
        return {
          action: "WATCH",
          score: 0,
          edgeScore: 0,
          reason: `Overextended entry blocked (RSI ${rsi.toFixed(0)}, z ${zScore.toFixed(2)})`,
          risk,
          blockedBy: "overextension",
        };
      }
    }

    // Personality-specific conviction kernel.
    let conviction = this.entryConviction(item, L, t);
    if (conviction === null) {
      return { action: "WATCH", score: 0, edgeScore: 0, reason: this.lastVetoReason || "Entry conditions not met", risk };
    }

    const setupBonus = (L.setupEdge[setup] || 0) * 100;
    const symbolBonus = (L.symbolEdge[item.symbol] || 0) * 60;
    // Conviction is scored ~[0..2]; scale it so a strong setup clears the bar.
    let edgeScore = 50 + conviction * t.qualityWeight * 12 + setupBonus + symbolBonus - risk * 0.35;

    if (edgeScore < requiredEdge) {
      return { action: "WATCH", score: Math.round(edgeScore), edgeScore, requiredEdge, reason: `Edge ${edgeScore.toFixed(0)} < learned bar ${requiredEdge.toFixed(0)} (${setup})`, risk };
    }

    const notional = this.calculateOrderNotional(item, snapshot, L);
    if (notional < Math.max(0.25, snapshot.capital * 0.01)) {
      return { action: "WATCH", score: Math.round(edgeScore), edgeScore, reason: `Size room too small`, risk };
    }

    // Volatility-relative risk plan. Stops and targets use the tape's current
    // expected move instead of a fixed base target that quiet markets cannot
    // reach before the position's time stop.
    const liveVol = Math.max(0.02, Number(item.liveVolPct) || Math.max(0.25, Number(item.volatilityPct || 0.75)));
    const horizonSigma = liveVol * Math.sqrt(20); // ~20 live observations
    const observedMove = Math.abs(Number(item.shortMomentumPct || 0));
    const expectedMove = Math.max(0.05, horizonSigma, observedMove * 1.25);
    let stopLossPct = this._clamp(
      expectedMove * (t.stopMoveMultiple || 1),
      t.stopFloor || 0.3,
      t.stopCap || 6,
    );
    let takeProfitPct = this._clamp(
      expectedMove * (t.targetMoveMultiple || 1.35),
      t.tpFloor || 0.35,
      t.tpCap || 10,
    );
    let trailPct = this._clamp(stopLossPct * 0.55, 0.2, 4.5);
    if (multiplier.enabled) {
      // No fixed profit target in multiplier mode. The position is free to
      // run until the live momentum thesis weakens or a safety rail fires.
      takeProfitPct = 0;
      stopLossPct = this._clamp(Math.max(stopLossPct, multiplier.minStopPct), t.stopFloor || 0.3, t.stopCap || 6);
      trailPct = this._clamp(Math.max(trailPct, multiplier.minTrailPct), 0.2, 4.5);
    }

    // Fee-edge gate: never take a trade whose realistic target can't cover
    // the round-trip fee. Respects the bot page "Disable fees" toggle — when
    // fees are off, roundTripFeePct is 0 and the gate is a no-op.
    const feeRateValue = typeof window.botFeeRate === "function" ? window.botFeeRate() : window.BOT_FEE_RATE;
    const feeRate = Number.isFinite(Number(feeRateValue)) ? Math.max(0, Number(feeRateValue)) : 0.001;
    const roundTripFeePct = feeRate * 2 * 100;
    if (!multiplier.enabled && takeProfitPct < Math.max(t.tpFloor || 0.5, roundTripFeePct * 2.5)) {
      return { action: "WAIT", score: Math.round(edgeScore), edgeScore, reason: `Target ${takeProfitPct.toFixed(2)}% < fee edge ${(roundTripFeePct * 2.5).toFixed(2)}% — market too quiet`, risk };
    }

    const confidence = Math.round(Math.max(0, Math.min(100, edgeScore)));

    const reasoning = item.reasoning && item.reasoning.summary ? item.reasoning.summary : "";
    return {
      action: "BUY",
      edgeScore,
      score: confidence,
      confidence,
      risk,
      notional,
      stopLossPct,
      takeProfitPct,
      trailPct,
      freeHand: multiplier.enabled,
      requiredEdge,
      reasoning: item.reasoning || null,
      reason: multiplier.enabled
        ? `${setup} edge ${edgeScore.toFixed(0)}/bar ${requiredEdge.toFixed(0)} | ${reasoning} | stop ${stopLossPct.toFixed(2)}% · free-hand momentum exit | ${this.lastVetoReason || ""}`
        : `${setup} edge ${edgeScore.toFixed(0)}/bar ${requiredEdge.toFixed(0)} | ${reasoning} | stop ${stopLossPct.toFixed(2)}% tp ${takeProfitPct.toFixed(2)}% | ${this.lastVetoReason || ""}`,
    };
  }

  // Subclass entry-conviction kernels return a score in ~[-1, 2] or null
  // to veto the entry outright. Returns the "quality" measure.
  entryConviction(item, L, t) {
    const directional = t.directionalBias || "trend";
    if (directional === "reversion") return this.reversionConviction(item, L, t);
    if (directional === "momentum") return this.momentumConviction(item, L, t);
    return this.trendConviction(item, L, t);
  }

  reversionConviction(item, L, t) {
    const zScore = Number(item.zScore || 0);
    const rsi = Number(item.rsiProxy || 50);
    const noise = Number(item.noisePct || 0);
    const shortMom = Number(item.shortMomentumPct || 0);
    const bbZ = Number(item.bbZ || 99);
    const momZ = Number(item.momZ || 0);
    if (noise > (t.maxNoise || 2.2)) { this.lastVetoReason = `Too noisy (${noise.toFixed(1)}) for mean reversion`; return null; }
    if (zScore > (t.minZ || -0.6)) { this.lastVetoReason = `Not oversold yet (z ${zScore.toFixed(2)})`; return null; }
    // The dip must be a real dislocation relative to the tape's noise — a
    // sub-noise wiggle is knife-catching, not reversion.
    if (momZ > (t.minReversionMomZ || -0.55)) { this.lastVetoReason = `Dip too shallow relative to tape noise (window ${momZ.toFixed(1)}σ)`; return null; }
    // The dip must be turning: require the short tape to have stopped falling.
    // NOTE: minTurnUp may legitimately be 0, so guard against JS falsy zero.
    const turnUpBar = Number.isFinite(t.minTurnUp) ? t.minTurnUp : -1.0;
    if (shortMom < turnUpBar) { this.lastVetoReason = `Still falling (${shortMom.toFixed(2)}%)`; return null; }
    // And price must have bounced off a recent local low — a transient noise
    // bounce in a continuing decline is still a knife, not a bottom.
    if (Number(item.ticksSinceLow) < 2) { this.lastVetoReason = `Still at local low (${Number(item.ticksSinceLow)}t) — no bounce confirmed`; return null; }
    if (rsi > (t.maxRsi || 56)) { this.lastVetoReason = `RSI ${rsi.toFixed(0)} not oversold enough`; return null; }
    if (bbZ > (t.bbZEntryMax || 0.7)) { this.lastVetoReason = `Not below lower band (bb ${bbZ.toFixed(2)})`; return null; }
    const strength = Math.min(2, Math.abs(zScore) * 0.5 + (50 - rsi) * 0.04 + Math.max(0, shortMom) * 0.4 + (t.agreementWeight || 1) * Number(item.agreement || 0));
    this.lastVetoReason = `oversold z ${zScore.toFixed(2)} (${momZ.toFixed(1)}σ) rsi ${rsi.toFixed(0)}`;
    return strength;
  }

  trendConviction(item, L, t) {
    const shortMom = Number(item.shortMomentumPct || 0);
    const mom = Number(item.momentumPct || 0);
    const emaRise = !!item.emaRise;
    const agreement = Number(item.agreement || 0);
    const moveZ = Number(item.moveZ || 0);
    const signalAction = item.signalAction || "Hold";
    if (!emaRise) { this.lastVetoReason = "No rising EMA structure"; return null; }
    if (Number(item.price || 0) < Number(item.ema21 || item.price)) { this.lastVetoReason = "Below EMA21"; return null; }
    if (Number(item.macdLine || 0) < -0.02) { this.lastVetoReason = "MACD not positive"; return null; }
    // Momentum is judged against the tape's own noise (moveZ), not a fixed %.
    if (moveZ < (t.minMoveZ || 0.3)) { this.lastVetoReason = `Weak relative momentum (${moveZ.toFixed(1)}σ)`; return null; }
    if (shortMom < (t.minMomentum || 0.05)) { this.lastVetoReason = `Weak momentum (${shortMom.toFixed(2)}%)`; return null; }
    if (signalAction === "Sell") { this.lastVetoReason = "Signal flipping to Sell"; return null; }
    const strength = Math.min(2, 0.6 + moveZ * 0.25 + mom * 0.2 + agreement * (t.agreementWeight || 1) * 0.8 + (emaRise ? 0.3 : 0));
    this.lastVetoReason = `trending ${moveZ >= 0 ? "+" : ""}${moveZ.toFixed(1)}σ`;
    return strength;
  }

  momentumConviction(item, L, t) {
    const mom = Number(item.momentumPct || 0);
    const rsi = Number(item.rsiProxy || 50);
    const dayRangePos = Number(item.dayRangePos || 0.5);
    const l2 = Number(item.l2Imbalance || 0);
    const moveZ = Number(item.moveZ || 0);
    const signalAction = item.signalAction || "Hold";
    const accel = moveZ - Math.max(0, Number(item.noisePct || 0) * 0.18);
    if (accel < (t.minAcceleration || 0.25)) { this.lastVetoReason = `No acceleration (${accel.toFixed(1)}σ)`; return null; }
    if (mom < (t.minMomentum || 0.15)) { this.lastVetoReason = `Slow tape (${mom.toFixed(2)}%)`; return null; }
    if (moveZ < (t.minMoveZ || 0.6)) { this.lastVetoReason = `Push too small vs noise (${moveZ.toFixed(1)}σ)`; return null; }
    if (rsi > (t.maxRsi || 82)) { this.lastVetoReason = `Overbought (RSI ${rsi.toFixed(0)})`; return null; }
    if (l2 < (t.minL2 || -3)) { this.lastVetoReason = `Book imbalance ${l2.toFixed(0)} bearish`; return null; }
    if (signalAction === "Sell") { this.lastVetoReason = "Signal flipping to Sell"; return null; }
    const strength = Math.min(2, 0.5 + accel * 0.7 + (dayRangePos > 0.8 ? 0.5 : 0) + (l2 > 5 ? 0.4 : 0) + (rsi >= 55 ? 0.3 : 0));
    this.lastVetoReason = `accel ${accel.toFixed(1)}σ rsi ${rsi.toFixed(0)}`;
    return strength;
  }

  // ------------------------------------------------------------------
  // Exit brain — stops/targets come from learning, stored on the position.
  // ------------------------------------------------------------------
  evaluateExit(item, snapshot, L, timing) {
    const t = this.traits();
    const position = window.botState.modes[this.mode].positions[item.symbol];
    const pnl = Number(item.pnlPct || 0);
    const dd = Number(item.drawdownFromHighPct || 0);
    const heldMs = item.openedAt ? Date.now() - item.openedAt : 0;
    const shortMom = Number(item.shortMomentumPct || 0);
    const targetHit = !!(position && position.targetHit);

    const stopPct = position && Number(position.stopLossPct) ? Number(position.stopLossPct) : L.stopPct;
    const targetPct = position && Number(position.takeProfitPct) ? Number(position.takeProfitPct) : L.targetPct;
    const trailPct = position && Number(position.trailPct) ? Number(position.trailPct) : L.trailPct;
    const effectiveTrailPct = targetHit ? Math.max(1.2, trailPct * 1.6) : trailPct;

    // Hard stop.
    if (pnl <= -stopPct) {
      return { action: "EXIT", sellFraction: 1, score: 0, edgeScore: 0, reason: `Stop-loss ${pnl.toFixed(2)}% <= -${stopPct.toFixed(2)}%` };
    }

    if (Number.isFinite(Number(timing?.remainingMs)) && Number(timing.remainingMs) <= Number(timing.exitMs || 0)) {
      return {
        action: pnl > 0 ? "LOCK PROFIT" : "EXIT",
        sellFraction: 1,
        score: 0,
        edgeScore: 0,
        reason: `Early run safety exit: ${Math.ceil(Number(timing.remainingMs) / 1000)}s remain; capital released before deadline`,
      };
    }

    // Multiplier positions deliberately have no profit target. They stay
    // open while the live momentum thesis is healthy and leave when the tape
    // fades, the learned momentum bucket turns negative, or a safety timer
    // says the capital should be released.
    if (this.multiplierProfile().enabled && position?.freeHand === true) {
      return this.evaluateFreeHandExit(item, position, pnl, dd, heldMs, L, timing);
    }

    // Profit protection — once a position reaches a modest gain, arm a tight
    // trail that banks the gain when momentum stalls (giveback from the peak),
    // instead of waiting for the run-end flatten or a much wider target.
    const profitLock = Number(t.breakevenLockPct || 0);
    const profitTrail = Number(t.breakevenTrailPct || 0);
    if (profitLock > 0 && !targetHit) {
      if (position && pnl >= profitLock) position.lockArmed = true;
      if (position && position.lockArmed && dd > profitTrail) {
        return { action: "LOCK PROFIT", sellFraction: 1, score: 0, edgeScore: 0, reason: `Profit banked: gave back ${dd.toFixed(2)}% from peak` };
      }
    }

    // Trailing stop from high-water mark once in profit.
    if (pnl > 0 && dd > effectiveTrailPct) {
      return { action: "LOCK PROFIT", sellFraction: targetHit ? 1 : (t.trailingFraction || 1), score: 0, edgeScore: 0, reason: targetHit ? `Trailing exit: gave back ${dd.toFixed(2)}% from peak` : `Trailing stop: gave back ${dd.toFixed(2)}% from peak` };
    }

    // Take-profit — bank a portion once, let the rest trail.
    if (pnl >= targetPct && !targetHit) {
      return { action: t.takeProfitAction || "LOCK PROFIT", sellFraction: t.takeProfitFraction || 0.6, score: 0, edgeScore: 0, reason: `Profit target +${targetPct.toFixed(2)}%` };
    }

    // Rebalance oversized winners.
    const positionValue = Number(item.heldQty || 0) * Number(item.price || 0);
    const valuePct = snapshot.capital ? positionValue / snapshot.capital : 0;
    if (valuePct > t.maxPosition * 2.0) {
      const excess = this._clamp((valuePct - t.maxPosition) / valuePct, 0.15, 0.6);
      return { action: "REDUCE", sellFraction: excess, score: 0, edgeScore: 0, reason: `Rebalancing winner: ${(valuePct * 100).toFixed(1)}% of book` };
    }

    // Momentum fade — for momentum/breakout personalities.
    if (t.exitOnMomentumFade && pnl > (t.momentumFadePnlFloor || 0.4) && shortMom < -(t.momentumFadeThreshold || 1.2)) {
      return { action: "EXIT", sellFraction: 1, score: 0, edgeScore: 0, reason: `Momentum faded (short mom ${shortMom.toFixed(2)}%)` };
    }

    // Signal flip against the position.
    if (t.exitOnSignalFlip && pnl > 0.3 && item.signalAction === "Sell") {
      return { action: "EXIT", sellFraction: 1, score: 0, edgeScore: 0, reason: `Signal flipped to Sell` };
    }

    // Mean-reversion completion — for reversion personalities.
    if (t.exitOnReversion && pnl > 0.4 && Number(item.zScore || 0) > (t.reversionExitZ || 1.5)) {
      return { action: "EXIT", sellFraction: 1, score: 0, edgeScore: 0, reason: `Reversion complete (z ${Number(item.zScore || 0).toFixed(2)})` };
    }

    // Time stop — no progress, free up capital.
    if (t.maxHoldMs && heldMs > t.maxHoldMs) {
      return { action: "EXIT", sellFraction: 1, score: 0, edgeScore: 0, reason: `Time stop after ${(heldMs / 60000).toFixed(1)}m` };
    }

    return { action: "HOLD", sellFraction: 0, score: 0, edgeScore: 0, reason: "Riding position" };
  }

  evaluateFreeHandExit(item, position, pnl, dd, heldMs, L, timing) {
    const t = this.traits();
    const momentumZ = Number(item.momZ || 0);
    const moveZ = Number(item.moveZ || 0);
    const signalAction = item.signalAction || "Hold";
    const direction = item.verdict?.direction || "neutral";
    const bucket = typeof window.botMomentumBucket === "function" ? window.botMomentumBucket(momentumZ) : "neutral";
    const learned = L.momentumEdge?.[bucket] || {};
    const learnedEdge = Number(learned.edge || 0);
    const learnedExpectancy = Number(learned.expectancyPct || 0);
    const liveVol = Math.max(0.03, Number(item.liveVolPct) || Number(item.volatilityPct) || 0.1);
    const learnedTrailFactor = this._clamp(1 + learnedEdge * 0.55, 0.65, 1.8);
    const adaptiveTrail = this._clamp(Math.max(0.2, liveVol * 1.35) * learnedTrailFactor, 0.25, 4.5);
    const fading = signalAction === "Sell"
      || direction === "bearish"
      || momentumZ <= -0.45
      || moveZ <= -0.75;
    const stalling = Math.abs(momentumZ) < 0.18 && Math.abs(moveZ) < 0.3;
    const statisticallyWeak = Number(learned.n || 0) >= 3 && learnedEdge < -0.12;
    const enoughTimeForFeedback = heldMs >= Math.max(30_000, Number(timing?.durationMs || 0) * 0.02);

    if (pnl > 0 && dd > adaptiveTrail && (fading || stalling || statisticallyWeak)) {
      return {
        action: "LOCK PROFIT",
        sellFraction: 1,
        score: 0,
        edgeScore: learnedEdge,
        reason: `Free-hand momentum exit: ${bucket} weakened · giveback ${dd.toFixed(2)}% > adaptive ${adaptiveTrail.toFixed(2)}% · learned edge ${(learnedEdge * 100).toFixed(0)}%`,
      };
    }
    if (pnl > 0.05 && (fading || statisticallyWeak) && (Number(learned.n || 0) >= 3 || signalAction === "Sell")) {
      return {
        action: "EXIT",
        sellFraction: 1,
        score: 0,
        edgeScore: learnedEdge,
        reason: `Free-hand momentum exit: ${bucket} thesis flipped · expectancy ${learnedExpectancy.toFixed(3)}%`,
      };
    }
    if (pnl <= 0 && enoughTimeForFeedback && fading && (momentumZ <= -0.65 || statisticallyWeak)) {
      return {
        action: "EXIT",
        sellFraction: 1,
        score: 0,
        edgeScore: learnedEdge,
        reason: `Free-hand loss cut: momentum ${bucket} is fading · learned edge ${(learnedEdge * 100).toFixed(0)}%`,
      };
    }
    if (t.maxHoldMs && heldMs > t.maxHoldMs) {
      return { action: "EXIT", sellFraction: 1, score: 0, edgeScore: learnedEdge, reason: `Free-hand time stop after ${(heldMs / 60000).toFixed(1)}m` };
    }
    return {
      action: "HOLD",
      sellFraction: 0,
      score: 0,
      edgeScore: learnedEdge,
      reason: `Free-hand: riding ${bucket} momentum · learned edge ${(learnedEdge * 100).toFixed(0)}% · adaptive trail ${adaptiveTrail.toFixed(2)}%`,
    };
  }

  // Risk-based sizing: risk a fixed % of capital per trade, with the stop
  // distance deciding the notional. Kelly scales the budget up/down from
  // what the bot has actually learned. Position/exposure caps stay binding.
  calculateOrderNotional(item, snapshot, L) {
    const t = this.traits();
    const multiplier = this.multiplierProfile();
    const capital = window.botCapital(this.mode);
    // Size from current equity, not only the starting deposit, so a small
    // account can compound wins while drawdowns automatically reduce risk.
    const accountValue = Math.max(0.25, Number(snapshot.totalValue || capital));
    const stopPct = Math.max(0.2, Number(item.stopLossPct) || L.stopPct || (t.stopLossBase + 1.5 * t.stopLossVol));
    const riskBudget = accountValue * t.riskPerTrade * multiplier.sizeMultiplier * (L.riskMultiplier || 1);
    const sizeFromRisk = riskBudget / (stopPct / 100);
    const currentValue = window.botHeldQuantity(this.mode, item.symbol) * Number(item.price || 0);
    const positionRoom = Math.max(0, (accountValue * multiplier.maxPosition) - currentValue);
    const exposureRoom = Math.max(0, (accountValue * multiplier.maxExposure) - Number(snapshot.openValue || 0));
    if (!multiplier.enabled) {
      return Math.max(0, Math.min(snapshot.cash, positionRoom, exposureRoom, sizeFromRisk));
    }

    // Multiplier mode has no hidden cash reserve and no fixed number of bets.
    // Allocation is a continuous function of the swarm's conviction, live
    // momentum and the learned result for this momentum bucket. A strong
    // thesis may consume all available cash; a weak one stays smaller.
    const confidence = this._clamp(Number(item.confidence || item.verdict?.confidence || 0) / 100, 0, 1);
    const edge = Number(item.edgeScore || item.rankScore || item.score || 0);
    const requiredEdge = Math.max(1, Number(item.requiredEdge || multiplier.minEdgeFloor || 40));
    const edgeQuality = this._clamp((edge - requiredEdge) / 28, 0, 1);
    const moveQuality = this._clamp(Number(item.moveZ || 0) / 2.2, 0, 1);
    const momentumQuality = this._clamp(Number(item.momZ || 0) / 1.8, 0, 1);
    const bucket = typeof window.botMomentumBucket === "function" ? window.botMomentumBucket(item.momZ) : "neutral";
    const learnedEdge = Number(L.momentumEdge?.[bucket]?.edge || 0);
    const learnedQuality = this._clamp(0.5 + learnedEdge * 0.5, 0.25, 0.8);
    const conviction = this._clamp(
      confidence * 0.34 + edgeQuality * 0.3 + moveQuality * 0.2 + momentumQuality * 0.16,
      0,
      1,
    );
    const allocation = this._clamp(
      (multiplier.allocationMin || 0.2)
        + ((multiplier.allocationMax || 1) - (multiplier.allocationMin || 0.2)) * conviction * learnedQuality,
      multiplier.allocationMin || 0.2,
      multiplier.allocationMax || 1,
    );
    const adaptiveSize = accountValue * allocation * this._clamp(Number(L.riskMultiplier || 1), 0.65, 1.15);
    return Math.max(0, Math.min(snapshot.cash, positionRoom, exposureRoom, Math.max(sizeFromRisk, adaptiveSize)));
  }

  _clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }
}

window.TraderBot = TraderBot;
