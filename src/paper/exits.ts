import type { Position, StrategyParams } from "../types.js";

/** Below this pool size we assume the token was rugged and our bag is close to worthless. */
export const RUG_LIQUIDITY_USD = 1_000;

export type ExitDecision =
  | { kind: "hold" }
  | { kind: "sell"; tokens: number; reason: string; takeProfitIndex?: number };

/**
 * Decides what to do with an open position at the current price. Pure function, easy to test.
 * Order matters: rug check, stop loss, take profits, trailing stop, time stop.
 * Expects pos.peakPriceUsd to already include the current price.
 */
export function decideExit(
  pos: Position,
  st: StrategyParams,
  priceUsd: number,
  liquidityUsd: number,
  now: number,
): ExitDecision {
  const sellAll = (reason: string): ExitDecision => ({ kind: "sell", tokens: pos.remainingTokens, reason });

  if (!(priceUsd > 0) || liquidityUsd < RUG_LIQUIDITY_USD) return sellAll("liquidity gone (likely rug)");

  const multiple = priceUsd / pos.entryPriceUsd;
  if (multiple <= 1 - st.stopLossPct / 100) return sellAll(`stop loss -${st.stopLossPct}%`);

  for (const [i, tp] of st.takeProfits.entries()) {
    if (pos.takeProfitsHit.includes(i) || multiple < tp.multiple) continue;
    const tokens = Math.min(pos.remainingTokens, pos.tokens * tp.sellFraction);
    return { kind: "sell", tokens, reason: `take profit ${tp.multiple}x`, takeProfitIndex: i };
  }

  const peakMultiple = pos.peakPriceUsd / pos.entryPriceUsd;
  const trailing = pos.takeProfitsHit.length > 0 || peakMultiple >= st.trailActivationMultiple;
  if (trailing && priceUsd <= pos.peakPriceUsd * (1 - st.trailingStopPct / 100)) {
    return sellAll(`trailing stop -${st.trailingStopPct}% from peak`);
  }

  const heldMin = (now - pos.openedAt) / 60_000;
  if (heldMin >= st.maxHoldMin && multiple < 1 + st.timeStopMinGainPct / 100) return sellAll("time stop: no move");
  if (heldMin >= st.maxHoldMin * 3) return sellAll("max hold time");

  return { kind: "hold" };
}
