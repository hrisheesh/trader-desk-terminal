function botMomentumBucket(value) {
  const z = Number(value || 0);
  if (z >= 1) return "strong-up";
  if (z >= 0.35) return "up";
  if (z <= -1) return "strong-down";
  if (z <= -0.35) return "down";
  return "neutral";
}

class LearningEngine {
  constructor() {
    this.state = { modes: {} };
    this._clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || min));
  }

  initMode(mode) {
    if (!this.state.modes[mode]) {
      this.state.modes[mode] = {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        peak: 0,
        maxDrawdown: 0,
        ewmaWinRate: 0.5,
        ewmaPayoff: 1.0,
        ewmaAvgVol: 1.5,
        realizedSeries: [],
        bySymbol: {},
        bySetup: {},
        byMomentum: {},
      };
    }
    if (!this.state.modes[mode].byMomentum) this.state.modes[mode].byMomentum = {};
    return this.state.modes[mode];
  }

  alphaFor(n) {
    const alpha = 1 / (1 + Math.sqrt(Math.max(1, n)));
    return this._clamp(alpha, 0.05, 0.5);
  }

  recordExit(mode, outcome) {
    const s = this.initMode(mode);
    const pnl = Number(outcome.pnl || 0);
    const capital = Math.max(1, Number(outcome.capital || 10000));
    const pnlPct = Number(outcome.pnlPct) || (pnl / capital) * 100;
    const setup = String(outcome.setupType || "unknown");
    const momentumBucket = botMomentumBucket(outcome.entryMomentumZ);

    s.trades += 1;
    s.pnl += pnl;
    if (pnl > 0) s.wins += 1;
    else s.losses += 1;

    const alpha = this.alphaFor(s.trades);
    s.ewmaWinRate = (1 - alpha) * s.ewmaWinRate + alpha * (pnl > 0 ? 1 : 0);

    // Track average win and loss size for expectancy.
    if (pnl > 0) {
      const winMag = Math.max(0.05, pnlPct);
      s.avgWin = s.avgWin === undefined ? winMag : (s.avgWin + winMag) / 2;
    } else {
      const lossMag = Math.max(0.05, Math.abs(pnlPct));
      s.avgLoss = s.avgLoss === undefined ? lossMag : (s.avgLoss + lossMag) / 2;
    }
    s.expectancyPct = (s.ewmaWinRate * (s.avgWin || 0)) - ((1 - s.ewmaWinRate) * (s.avgLoss || 0));

    const mag = Math.abs(pnlPct);
    if (pnl > 0) {
      s.ewmaPayoff = s.ewmaPayoff + alpha * (Math.max(0.1, mag) - s.ewmaPayoff);
    } else if (mag > 0) {
      const invPayoff = 1 / Math.max(0.1, s.ewmaPayoff);
      s.ewmaPayoff = 1 / (invPayoff + alpha * (mag - invPayoff));
    }

    if (Number(outcome.volatility) > 0) {
      s.ewmaAvgVol = s.ewmaAvgVol + 0.1 * (Number(outcome.volatility) - s.ewmaAvgVol);
    }

    s.peak = Math.max(s.peak, s.pnl);
    s.maxDrawdown = Math.min(s.maxDrawdown, s.pnl - s.peak);

    s.realizedSeries.push(pnlPct);
    if (s.realizedSeries.length > 40) s.realizedSeries.shift();

    const sym = s.bySymbol[outcome.symbol] || { n: 0, wins: 0, pnl: 0 };
    sym.n += 1;
    sym.wins += pnl > 0 ? 1 : 0;
    sym.pnl += pnl;
    s.bySymbol[outcome.symbol] = sym;

    const su = s.bySetup[setup] || { n: 0, wins: 0, pnl: 0 };
    su.n += 1;
    su.wins += pnl > 0 ? 1 : 0;
    su.pnl += pnl;
    s.bySetup[setup] = su;

    const momentum = s.byMomentum[momentumBucket] || { n: 0, wins: 0, pnl: 0, pnlPct: 0 };
    momentum.n += 1;
    momentum.wins += pnl > 0 ? 1 : 0;
    momentum.pnl += pnl;
    momentum.pnlPct += pnlPct;
    s.byMomentum[momentumBucket] = momentum;

    return s;
  }

  recentMomentum(s) {
    const series = s.realizedSeries.slice(-10);
    if (!series.length) return 0;
    return series.reduce((sum, v) => sum + v, 0) / series.length;
  }

  // Kelly fraction: f = p - (1-p)/b
  kellyFor(s) {
    const p = s.ewmaWinRate;
    const b = Math.max(0.1, s.ewmaPayoff);
    return this._clamp(p - (1 - p) / b, 0, 0.3);
  }

  getParams(mode, traits) {
    const s = this.initMode(mode);
    const momentum = this.recentMomentum(s);
    const winRate = s.ewmaWinRate;
    const payoff = s.ewmaPayoff;
    const kelly = this.kellyFor(s);
    const warm = s.trades < 6 ? 0.78 : 1;
    const expectancy = Number(s.expectancyPct || 0);

    // Positive expectancy makes the boss hungrier (lower bar, bigger risk);
    // negative expectancy makes it defensive (higher bar, smaller size).
    const minEdge = this._clamp(
      traits.minEdgeBase - momentum * 2.6 - expectancy * 1.5,
      traits.minEdgeFloor || traits.minEdgeBase - 12,
      traits.minEdgeCap || traits.minEdgeBase + 10,
    );
    const conviction = this._clamp(traits.convictionBias + momentum * 0.04, 0.2, 0.95);

    const volAvg = Math.max(0.4, s.ewmaAvgVol);
    const stopPct = this._clamp(
      (traits.stopLossBase + volAvg * traits.stopLossVol) * (1 - momentum * 0.05),
      traits.stopFloor || 0.4,
      traits.stopCap || 6,
    );
    const targetPct = this._clamp(
      (traits.takeProfitBase + volAvg * traits.takeProfitVol) * (1 + momentum * 0.05),
      traits.tpFloor || 0.5,
      traits.tpCap || 10,
    );
    const trailPct = this._clamp(stopPct * 0.55, 0.2, 4.5);
    const riskMultiplier = this._clamp(0.55 + kelly * 4, 0.4, 1.5) * warm;
    const setupEdge = {};
    Object.entries(s.bySetup).forEach(([setup, st]) => {
      if (st.n >= 2) setupEdge[setup] = this._clamp((st.wins / st.n - 0.5) * 2, -0.6, 0.6);
    });
    const symbolEdge = {};
    Object.entries(s.bySymbol).forEach(([sym, st]) => {
      if (st.n >= 3) symbolEdge[sym] = this._clamp((st.wins / st.n - 0.5) * 2, -0.7, 0.7);
    });
    const momentumEdge = {};
    Object.entries(s.byMomentum || {}).forEach(([bucket, st]) => {
      const n = Number(st.n || 0);
      if (n > 0) {
        momentumEdge[bucket] = {
          n,
          wins: Number(st.wins || 0),
          edge: this._clamp((Number(st.wins || 0) / n - 0.5) * 2, -1, 1),
          expectancyPct: Number(st.pnlPct || 0) / n,
        };
      }
    });
    const bestMomentum = Object.entries(momentumEdge)
      .filter(([, stats]) => stats.n >= 2)
      .sort((a, b) => b[1].expectancyPct - a[1].expectancyPct)[0]?.[0] || "neutral";

    return {
      winRate,
      payoff,
      kelly,
      momentum,
      conviction,
      minEdge,
      stopPct,
      targetPct,
      trailPct,
      riskMultiplier,
      setupEdge,
      symbolEdge,
      momentumEdge,
      bestMomentum,
      avgWinPct: Number(s.avgWin || 0),
      avgLossPct: Number(s.avgLoss || 0),
      expectancyPct: Number(s.expectancyPct || 0),
      trades: s.trades,
      pnl: s.pnl,
    };
  }

  hydrate(saved) {
    if (saved && saved.modes) this.state = saved;
  }

  serialize() {
    return JSON.parse(JSON.stringify(this.state));
  }

  reset() {
    this.state = { modes: {} };
  }
}

window.LearningEngine = LearningEngine;
window.botMomentumBucket = botMomentumBucket;
