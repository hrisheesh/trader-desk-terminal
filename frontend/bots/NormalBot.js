class NormalBot extends window.TraderBot {
  constructor() {
    super('normal', 800); // Ticks every 0.8 seconds (Normal)
  }

  traits() {
    return {
      label: "Normal Trend Follower",
      strategy: "trend_following",
      maxPosition: 0.50,
      drawdownFromHighPct: 2.0,
    };
  }

  evaluateEntry(context, snapshot) {
    const profile = this.traits();
    let action = "WAIT";
    let confidence = 0;
    let risk = context.riskLoad;
    let reason = "Watching trend";

    if (context.pnlPct < -0.5) {
      reason = "Prior trades showing weakness";
      risk += 15;
    }

    if (context.agreement > 5 && context.resistanceDistancePct > 0.5 && context.momentumPct > 0) {
      action = "BUY";
      confidence = context.opportunity + (context.resistanceDistancePct * 10) - risk;
      reason = `Trend Agreement & Room to Resistance`;
    } else if (context.resistanceDistancePct < 0.2) {
      reason = "Too close to resistance, skipping";
      risk += 15;
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
    
    if (context.pnlPct < -6.0) return { action: "EXIT", reason: `Hard Stop-Loss (-6.0%)` };
    
    if (context.drawdownFromHighPct > profile.drawdownFromHighPct) {
      const lockType = context.pnlPct > 0 ? "LOCK PROFIT" : "TRAILING STOP";
      return { action: lockType, reason: `Price dropped ${context.drawdownFromHighPct.toFixed(2)}% from peak` };
    }

    if (context.pnlPct > 5.0) return { action: "LOCK PROFIT", reason: `Profit Target Hit (+5.0%)` };
    
    if (context.pnlPct > 0.5 && context.resistanceDistancePct < 0.1) {
      return { action: "EXIT", reason: `Hit Resistance Zone` };
    }

    return { action: "HOLD", reason: "Riding trend" };
  }
}

window.NormalBot = NormalBot;
