class TraderBot {
  constructor(mode, tickMs = 1000) {
    this.mode = mode;
    this.tickMs = tickMs;
    this.activeSwarms = 0;
    this.running = false;
    this.timer = null;
    this.worker = new window.SwarmWorker(mode);
  }

  // Subclasses override these
  traits() { return {}; }
  evaluateEntry(context, snapshot) { return { action: "WAIT" }; }
  evaluateExit(context, snapshot) { return { action: "WAIT" }; }
  
  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    console.log(`[${this.mode}] Bot started with tick ${this.tickMs}ms`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log(`[${this.mode}] Bot stopped`);
  }

  async tick() {
    if (!this.running || this.activeSwarms > 0) return; // Prevent overlapping runs for this specific bot

    const universe = typeof window.getBotUniverseQuotes === "function" ? window.getBotUniverseQuotes() : [];
    console.log(`[${this.mode}] Universe length:`, universe.length);
    if (!universe.length) return;

    this.activeSwarms = universe.length;
    if(!window.botSwarmStats) window.botSwarmStats = {}; window.botSwarmStats[this.mode] = this.activeSwarms;
    if (window.renderBotStatus) window.renderBotStatus();

    try {
      const promises = universe.map(async (quote) => {
        try {
          return await this.worker.evaluate(quote);
        } finally {
          this.activeSwarms--;
          if(!window.botSwarmStats) window.botSwarmStats = {}; window.botSwarmStats[this.mode] = this.activeSwarms;
          if (window.renderBotStatus) window.renderBotStatus();
        }
      });
      
      const results = await Promise.all(promises);
      const valid = results.filter(Boolean);
      const ranked = valid.sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));
      
      if (ranked.length) {
        this.runModeDecision(ranked);
      }
    } catch (e) {
      console.error(`[${this.mode}] Swarm error:`, e);
      this.activeSwarms = 0;
      if(!window.botSwarmStats) window.botSwarmStats = {}; window.botSwarmStats[this.mode] = 0;
    }
  }

  runModeDecision(ranked) {
    const state = window.botState.modes[this.mode];
    state.rankings = ranked;
    state.decisions += 1;
    
    const snapshot = window.botPortfolioSnapshot(this.mode, ranked);
    const profile = this.traits();
    const held = ranked.filter(item => window.botHeldQuantity(this.mode, item.symbol) > 0);

    // 1. Evaluate Exits
    for (const item of held) {
      const decision = this.evaluateExit(item, snapshot);
      if ((decision.action === "EXIT" || decision.action === "REDUCE" || decision.action === "LOCK PROFIT") && item.heldQty > 0) {
        const qty = item.heldQty * (decision.sellFraction || 1);
        window.executeBotSell(this.mode, item, qty, decision.reason);
        return;
      }
    }

    // 2. Evaluate Entries
    const openSymbols = new Set(held.map(item => item.symbol));
    const candidates = ranked.filter(item => !openSymbols.has(item.symbol));
    const decisions = candidates.map(item => ({ context: item, decision: this.evaluateEntry(item, snapshot) }));
    
    const buy = decisions
      .filter(item => item.decision.action === "BUY")
      .sort((a, b) => (b.decision.confidence - b.decision.risk * 0.35) - (a.decision.confidence - a.decision.risk * 0.35))[0];

    if (buy) {
      const notional = this.calculateOrderNotional(buy.decision, snapshot);
      if (notional >= Math.max(0.25, snapshot.capital * 0.01)) {
        window.executeBotBuy(this.mode, { ...buy.context, ...buy.decision, notional }, notional, buy.decision.reason);
        return;
      }
    }

    // 3. Log Observation for the top ranked symbol
    const top = decisions[0] || (held[0] ? { context: held[0], decision: this.evaluateEntry(held[0], snapshot) } : null);
    if (top) {
      const action = top.decision.action === "WAIT" ? "WAIT" : "WATCH";
      window.logBotDecision(this.mode, { action, symbol: top.context.symbol, score: top.decision.score, reason: top.decision.reason }, { key: `${action}:${top.context.symbol}`, throttleMs: 3000 });
    }
  }

  calculateOrderNotional(decision, snapshot) {
    const profile = this.traits();
    const candidate = decision;
    const currentValue = window.botHeldQuantity(this.mode, candidate.symbol) * candidate.price;
    const positionRoom = Math.max(0, (window.botCapital(this.mode) * profile.maxPosition) - currentValue);
    return Math.min(snapshot.cash, positionRoom, Number(candidate.notional || 0));
  }
}

window.TraderBot = TraderBot;