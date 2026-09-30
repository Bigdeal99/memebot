import type { HypeVerdict, StrategyParams } from "./types.js";

/**
 * The strategy tournament. Every strategy sees the same tokens and trades its own paper bankroll,
 * so after a few hundred trades the report shows which rules actually work.
 * "baseline" is the control group: same rules as "hype_momentum" but it ignores the AI.
 * If hype_momentum does not beat baseline, the AI is not earning its cost.
 */
export function defaultStrategies(positionUsd: number): StrategyParams[] {
  const common = {
    positionUsd,
    maxOpen: 5,
    dailyLossLimitUsd: positionUsd * 4,
    reentryCooldownMin: 360,
    minHype: 0,
    minOrganic: 0,
    allowWatchVerdict: false,
  };

  return [
    {
      ...common,
      name: "hype_momentum",
      description: "Momentum + Grok sees real attention on X and no red flags. Half out at 2x, trail the rest.",
      minMomentum: 60,
      requireAi: true,
      minHype: 4,
      minOrganic: 4,
      allowWatchVerdict: true,
      stopLossPct: 30,
      takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
      trailingStopPct: 30,
      trailActivationMultiple: 1.5,
      maxHoldMin: 360,
      timeStopMinGainPct: 20,
    },
    {
      ...common,
      name: "baseline",
      description: "Control group: same as hype_momentum but ignores the AI completely.",
      minMomentum: 60,
      requireAi: false,
      stopLossPct: 30,
      takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
      trailingStopPct: 30,
      trailActivationMultiple: 1.5,
      maxHoldMin: 360,
      timeStopMinGainPct: 20,
    },
    {
      ...common,
      name: "quick_flip",
      description: "No AI, strict entry, small quick target: all out at +40%, tight stop, 45 min max.",
      minMomentum: 70,
      requireAi: false,
      stopLossPct: 20,
      takeProfits: [{ multiple: 1.4, sellFraction: 1 }],
      trailingStopPct: 15,
      trailActivationMultiple: 1.25,
      maxHoldMin: 45,
      timeStopMinGainPct: 10,
    },
    {
      ...common,
      name: "moonshot",
      description: "Strong momentum + very strong organic hype. Sells in thirds at 2x and 5x, lets a runner ride.",
      minMomentum: 65,
      requireAi: true,
      minHype: 7,
      minOrganic: 6,
      maxOpen: 3,
      stopLossPct: 35,
      takeProfits: [
        { multiple: 2, sellFraction: 1 / 3 },
        { multiple: 5, sellFraction: 1 / 3 },
      ],
      trailingStopPct: 40,
      trailActivationMultiple: 2,
      maxHoldMin: 1440,
      timeStopMinGainPct: 30,
    },
    {
      ...common,
      name: "lottery",
      description:
        "Many tiny bets hunting rare 10x-100x runners. Takes the stake back at 2x, then lets the rest ride for days.",
      positionUsd: Math.max(1, Math.round(positionUsd * 0.4)),
      maxOpen: 10,
      minMomentum: 50,
      requireAi: false,
      stopLossPct: 50,
      takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
      // Very wide trail: a real runner often drops 30-40% on the way up and would shake out a tight stop.
      trailingStopPct: 50,
      trailActivationMultiple: 3,
      maxHoldMin: 3 * 24 * 60,
      timeStopMinGainPct: 0,
    },
  ];
}

export interface EntryDecision {
  enter: boolean;
  reason: string;
}

export function shouldEnter(
  st: StrategyParams,
  momentum: number,
  ai: HypeVerdict | null,
  aiEnabled: boolean,
): EntryDecision {
  if (momentum < st.minMomentum) return { enter: false, reason: `momentum ${momentum} < ${st.minMomentum}` };
  if (!st.requireAi) return { enter: true, reason: `momentum ${momentum}` };

  if (!aiEnabled) return { enter: false, reason: "needs AI but no XAI_API_KEY" };
  if (!ai) return { enter: false, reason: "no AI verdict (budget used or error)" };
  if (ai.verdict === "avoid") return { enter: false, reason: `AI says avoid: ${ai.reason}` };
  if (ai.verdict === "watch" && !st.allowWatchVerdict) return { enter: false, reason: "AI says watch" };
  if (ai.hype < st.minHype) return { enter: false, reason: `hype ${ai.hype} < ${st.minHype}` };
  if (ai.organic < st.minOrganic) return { enter: false, reason: `organic ${ai.organic} < ${st.minOrganic}` };
  return { enter: true, reason: `momentum ${momentum}, hype ${ai.hype}, organic ${ai.organic}` };
}
