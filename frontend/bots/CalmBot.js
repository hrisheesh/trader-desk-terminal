class CalmBot extends window.TraderBot {
  constructor() {
    super('calm', 1500); // Ticks every 1.5 seconds (Calm)
  }

  traits() {
    return {
      label: "Calm Scalper",
      strategy: "mean_reversion",
      maxPosition: 0.30,
      drawdownFromHighPct: 1.5, // Stop-loss trailing sensitivity
    };
  }

  evaluateEntry(context, snapshot) {
    const profile = this.traits();
    let action = "WAIT";
    let confidence = 0;
    let risk = context.riskLoad;
    let reason = "Watching L2 depth";

    if (context.pnlPct < -0.5) {
      reason = "Prior trades showing weakness";
      risk += 25;
    }

    if (context.l2Imbalance > 15 && context.agreement > 10 && context.volatilityPct < 2 && context.l2BidVol > context.l2AskVol * 2.0) {
      action = "BUY";
      confidence = context.opportunity + (context.l2Imbalance * 1.5) - risk + 15;
      reason = `Massive L2 Bid Wall (${context.l2Imbalance.toFixed(1)}% & >2x Vol) & High Agreement`;
    } else if (context.l2Imbalance < -10 || context.l2AskVol > context.l2BidVol * 1.5) {
      reason = "L2 Ask Pressure or heavy sell wall, skipping";
      risk += 15;
    } else if (context.volatilityPct > 3) {
      reason = "Too volatile for Calm bot";
      risk += 20;
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
    
    // Hard stop loss
    if (context.pnlPct < -5.0) {
      return { action: "EXIT", reason: `Hard Stop-Loss (-5.0%)` };
    }
    
    // Dynamic Trailing Stop Loss using High-Water Mark
    if (context.drawdownFromHighPct > profile.drawdownFromHighPct) {
      const lockType = context.pnlPct > 0 ? "LOCK PROFIT" : "TRAILING STOP";
      return { action: lockType, reason: `Price dropped ${context.drawdownFromHighPct.toFixed(2)}% from peak` };
    }

    // Profit Target
    if (context.pnlPct > 3.0) {
      return { action: "LOCK PROFIT", reason: `Profit Target Hit (+3.0%)` };
    }
    
    // Mean Reversion Weakness
    if (context.pnlPct > 0.5 && context.l2Imbalance < -5) {
      return { action: "EXIT", reason: `L2 Resistance Detected` };
    }

    return { action: "HOLD", reason: "Holding position securely" };
  }
}

window.CalmBot = CalmBot;
