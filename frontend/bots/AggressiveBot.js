// Aggressive Bot — Momentum / Breakout Hunter.
// Philosophy: hunt acceleration and breakouts near the day high with order
// book confirmation; accept wider variance, bank profits fast, rotate hard.
class AggressiveBot extends window.TraderBot {
  constructor() {
    super("aggressive", 300);
  }

  traits() {
    return {
      label: "Aggressive Momentum Hunter",
      strategy: "breakout",
      directionalBias: "momentum",
      preferredSetups: ["breakout", "momentum", "trend"],
      riskPerTrade: 0.0051,
      maxRiskLoad: 75,
      minSamples: 6,
      verdictMinConfidence: 30,
      qualityWeight: 1.1,
      agreementWeight: 0.5,
      momentumWeight: 5.0,
      expectMomentum: true,
      exitOnMomentumFade: true,
      momentumFadeThreshold: 0.8,
      momentumFadePnlFloor: 0.2,
      exitOnSignalFlip: true,
      // DEMO-MODE: relaxed momentum bars so Aggressive trades a quiet tape.
      minAcceleration: 0.25,
      minMomentum: 0.2,
      minMoveZ: 0.5,
      maxRsi: 92,
      maxEntryRsi: 88,
      maxEntryZ: 3.0,
      freshBreakoutMoveZ: 1.7,
      minL2: -3,
      stopLossBase: 0.6,
      stopLossVol: 1.1,
      stopFloor: 0.4,
      stopCap: 6.0,
      takeProfitBase: 1.6,
      takeProfitVol: 1.4,
      tpFloor: 0.6,
      tpCap: 10.0,
      stopMoveMultiple: 1.1,
      targetMoveMultiple: 1.5,
      minEdgeBase: 40,
      minEdgeFloor: 40,
      minEdgeCap: 56,
      convictionBias: 0.3,
      maxPosition: 0.2,
      maxExposure: 0.6,
      maxPositions: 6,
      cooldownMs: 12000,
      trailingFraction: 1,
      takeProfitFraction: 0.45,
      takeProfitAction: "LOCK PROFIT",
      breakevenLockPct: 0.18,
      breakevenTrailPct: 0.13,
      maxHoldMs: 10 * 60 * 1000,
      entryRuntimeFraction: 0.25,
    };
  }
}

window.AggressiveBot = AggressiveBot;
