class AggressiveBot extends window.TraderBot {
  constructor() {
    super('aggressive', 300); // Ticks every 0.3 seconds (Aggressive)
  }

  traits() {
    return {
      label: "Aggressive Momentum Hunter",
      strategy: "breakout",
      maxPosition: 0.80,
      drawdownFromHighPct: 2.5,
    };
  }

  evaluateEntry(context, snapshot) {
    const profile = this.traits();
    let action = "WAIT";
    let confidence = 0;
    let risk = context.riskLoad;
    let reason = "Hunting Momentum";

    if (context.shortMomentumPct > 10 && context.volatilityPct > 2 && context.l2BidVol > context.l2AskVol * 1.2) {
      action = "BUY";
      confidence = context.opportunity + (context.shortMomentumPct * 2) - risk + ((context.l2BidVol / Math.max(1, context.l2AskVol)) * 5);
      reason = `Momentum Expansion (${context.shortMomentumPct.toFixed(1)}%) + Buy Volume Dominance`;
    } else if (context.shortMomentumPct < -5 || context.l2AskVol > context.l2BidVol * 1.5) {
      reason = "Momentum dying or heavy sell wall, skipping";
      risk += 25;
    }

    const notional = Math.min(snapshot.cash, window.botCapital(this.mode) * profile.maxPosition);
    
    return {
      action,
      confidence,
      risk,
      notional: action === "BUY" ? notional : 0,
      reason,
      score: context.score
    };
  }

  evaluateExit(context, snapshot) {
    const profile = this.traits();
    
    if (context.pnlPct < -8.0) return { action: "EXIT", reason: `Hard Stop-Loss (-8.0%)` };
    
    if (context.drawdownFromHighPct > profile.drawdownFromHighPct) {
      const lockType = context.pnlPct > 0 ? "LOCK PROFIT" : "TRAILING STOP";
      return { action: lockType, reason: `Momentum broke down (${context.drawdownFromHighPct.toFixed(2)}%)` };
    }

    if (context.pnlPct > 10.0) return { action: "LOCK PROFIT", reason: `Massive Gain (+10.0%)` };
    
    if (context.pnlPct > 1.0 && context.shortMomentumPct < -2) {
      return { action: "EXIT", reason: `Momentum Reversal Detected` };
    }

    return { action: "HOLD", reason: "Riding momentum" };
  }
}

window.AggressiveBot = AggressiveBot;
