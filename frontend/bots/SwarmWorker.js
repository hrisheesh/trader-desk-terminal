class SwarmWorker {
  constructor(mode) {
    this.mode = mode;
  }

  async evaluate(quote) {
    // Artificial swarm delay to simulate processing and allow UI render
    await new Promise(resolve => setTimeout(resolve, Math.random() * 150 + 50));
    
    const price = Number(quote.price || 0);
    if (!price || price < 0.001) return null;
    
    if (window.rememberBotPrice) window.rememberBotPrice(this.mode, quote.symbol, price);
    const history = window.botState.modes[this.mode].priceMemory[quote.symbol] || [];

    if (history.length >= 2) {
      let staleCount = 0;
      for (let i = history.length - 1; i > 0; i -= 1) {
        if (history[i].price === history[i - 1].price) staleCount += 1;
        else break;
      }
      if (staleCount > window.BOT_STALE_TICK_LIMIT) return null;
    }
    
    const stats = window.botHistoryStats(history, price);
    const signal = window.botSignalFor(quote.symbol);
    const heldQty = window.botHeldQuantity(this.mode, quote.symbol);
    const entry = window.botAverageEntry(this.mode, quote.symbol);
    const changePercent = Number(quote.changePercent ?? quote.change_percent ?? 0);
    const dayRangePct = quote.high && quote.low ? ((quote.high - quote.low) / price) * 100 : 0;
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
    const l2Data = window.botAnalyzeOrderBook(quote.symbol);
    
    const context = {
      symbol: quote.symbol,
      price,
      changePercent,
      dayRangePct,
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
      ...stats,
    };
    
    context.agreement = window.botMarketAgreement(context);
    
    return this.applyModeWeights(context);
  }

  applyModeWeights(context) {
    if (this.mode === "calm") {
      context.trendQuality = window.clamp((context.momentumPct * 6) + (context.shortMomentumPct * 10) + (context.changePercent * 3) + (context.agreement * 24) + (context.l2Imbalance * 18) - (context.noisePct * 5), -45, 55);
    } else if (this.mode === "aggressive") {
      context.trendQuality = window.clamp((context.momentumPct * 12) + (context.shortMomentumPct * 18) + (context.changePercent * 5) + (context.agreement * 12) + (context.l2Imbalance * 8) - (context.noisePct * 2), -45, 55);
    } else {
      context.trendQuality = window.clamp((context.momentumPct * 9) + (context.shortMomentumPct * 14) + (context.changePercent * 3) + (context.agreement * 18) + (context.l2Imbalance * 12) - (context.noisePct * 4), -45, 55);
    }
  
    context.riskLoad = window.clamp((context.volatilityPct * 9) + (context.dayRangePct * 1.6) + Math.max(0, -context.shortMomentumPct) * 9, 0, 100);
    context.opportunity = window.clamp(50 + context.trendQuality - (context.riskLoad * 0.35), 0, 100);
    context.score = Math.round(context.opportunity);
    
    if (this.mode === "calm") {
      context.rankScore = context.opportunity + (context.l2Imbalance * 15) - context.riskLoad;
    } else if (this.mode === "aggressive") {
      context.rankScore = context.opportunity + Math.max(0, context.shortMomentumPct) * 15 + Math.max(0, context.volatilityPct) * 8;
    } else {
      context.rankScore = context.opportunity + Math.max(0, context.shortMomentumPct) * 4 + Math.max(0, context.resistanceDistancePct) * 0.6;
    }
    
    return context;
  }
}

window.SwarmWorker = SwarmWorker;
