// Normal Bot — Trend Follower.
// Philosophy: only buy when trend, momentum and signal agree; ride the move
// with a trailing stop; rotate out when the trend fades. Medium positions.
class NormalBot extends window.TraderBot {
  constructor() {
    super("normal", 800);
  }

  traits() {
    return {
      label: "Normal Trend Follower",
      strategy: "trend_following",
      directionalBias: "trend",
      preferredSetups: ["trend", "pullback", "breakout", "momentum"],
      riskPerTrade: 0.0025,
      maxRiskLoad: 60,
      minSamples: 8,
      verdictMinConfidence: 30,
      qualityWeight: 1.0,
      agreementWeight: 0.9,
      momentumWeight: 2.5,
      exitOnMomentumFade: true,
      momentumFadeThreshold: 1.0,
      momentumFadePnlFloor: 0.3,
      exitOnSignalFlip: true,
      // DEMO-MODE: relaxed trend-entry bars so Normal trades a quiet tape.
      minMomentum: 0.06,
      minMoveZ: 0.35,
      maxEntryRsi: 78,
      maxEntryZ: 2.5,
      freshBreakoutMoveZ: 1.5,
      stopLossBase: 0.5,
      stopLossVol: 0.8,
      stopFloor: 0.35,
      stopCap: 4.5,
      takeProfitBase: 1.1,
      takeProfitVol: 1.0,
      tpFloor: 0.4,
      tpCap: 7.0,
      stopMoveMultiple: 1.0,
      targetMoveMultiple: 1.35,
      minEdgeBase: 44,
      minEdgeFloor: 44,
      minEdgeCap: 60,
      convictionBias: 0.5,
      maxPosition: 0.14,
      maxExposure: 0.38,
      maxPositions: 5,
      cooldownMs: 30000,
      trailingFraction: 1,
      takeProfitFraction: 0.55,
      takeProfitAction: "LOCK PROFIT",
      breakevenLockPct: 0.14,
      breakevenTrailPct: 0.1,
      maxHoldMs: 12 * 60 * 1000,
      entryRuntimeFraction: 0.25,
    };
  }
}

window.NormalBot = NormalBot;
