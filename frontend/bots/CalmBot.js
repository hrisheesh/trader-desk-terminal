// Calm Bot — Mean-Reversion Scalper.
// Philosophy: protect capital, buy statistically oversold dips near support
// with low noise, take quick scalps and trail tightly. Few, patient positions.
class CalmBot extends window.TraderBot {
  constructor() {
    super("calm", 1500);
  }

  traits() {
    return {
      label: "Calm Mean-Reverter",
      strategy: "mean_reversion",
      directionalBias: "reversion",
      preferredSetups: ["reversion", "pullback"],
      riskPerTrade: 0.0011,
      maxRiskLoad: 45,
      minSamples: 10,
      verdictMinConfidence: 30,
      qualityWeight: 0.7,
      agreementWeight: 1.1,
      momentumWeight: 1.0,
      expectReversion: true,
      exitOnReversion: true,
      reversionExitZ: 0.4,
      // Reversion entry filters — dip must actually turn and be a real
      // dislocation relative to the tape's noise (momZ/moveZ are sigmas).
      // DEMO-MODE: relaxed reversion bars so Calm trades a quiet tape.
      maxNoise: 2.0,
      maxRsi: 55,
      minTurnUp: 0.0,
      bbZEntryMax: 0.6,
      minZ: -0.7,
      minReversionMomZ: -0.6,
      minMoveZ: 1.0,
      stopLossBase: 0.35,
      stopLossVol: 0.5,
      stopFloor: 0.3,
      stopCap: 2.5,
      takeProfitBase: 0.6,
      takeProfitVol: 0.6,
      tpFloor: 0.4,
      tpCap: 3.5,
      stopMoveMultiple: 1.1,
      targetMoveMultiple: 1.5,
      minEdgeBase: 46,
      minEdgeFloor: 46,
      minEdgeCap: 62,
      convictionBias: 0.72,
      maxPosition: 0.08,
      maxExposure: 0.22,
      maxPositions: 4,
      cooldownMs: 45000,
      trailingFraction: 1,
      takeProfitFraction: 0.7,
      takeProfitAction: "LOCK PROFIT",
      breakevenLockPct: 0.1,
      breakevenTrailPct: 0.07,
      maxHoldMs: 6 * 60 * 1000,
      entryRuntimeFraction: 0.25,
    };
  }
}

window.CalmBot = CalmBot;
