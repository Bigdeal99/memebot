/** Subset of a DexScreener pair object that the bot uses. */
export interface DexPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  txns?: Partial<Record<Window, { buys: number; sells: number }>>;
  volume?: Partial<Record<Window, number>>;
  priceChange?: Partial<Record<Window, number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    websites?: { url: string }[];
    socials?: { type?: string; platform?: string; url?: string; handle?: string }[];
  };
  boosts?: { active?: number };
}

export type Window = "m5" | "h1" | "h6" | "h24";

export interface TokenRef {
  mint: string;
  symbol: string;
  name: string;
}

export interface Signals {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  ageMin: number;
  buysM5: number;
  sellsM5: number;
  buysH1: number;
  sellsH1: number;
  txnsH1: number;
  buyRatioM5: number;
  buyRatioH1: number;
  volumeM5Usd: number;
  volumeH1Usd: number;
  volumeH24Usd: number;
  /** One hour of volume divided by pool liquidity (turnover). */
  volumeToLiquidityH1: number;
  /** Last 5 min volume, annualised to an hour, divided by last hour volume. >1 = speeding up. */
  acceleration: number;
  changeM5Pct: number;
  changeH1Pct: number;
  changeH6Pct: number;
  hasSocials: boolean;
  boosted: boolean;
}

export interface SafetyMetrics {
  top10Pct?: number;
  topHolderPct?: number;
  insiderPct?: number;
  riskScore?: number;
  lpLockedPct?: number;
  insidersDetected?: number;
}

export interface SafetyResult {
  pass: boolean;
  /** True when the check may pass later (e.g. RugCheck has not indexed the token yet). */
  retryable: boolean;
  reasons: string[];
  metrics: SafetyMetrics;
}

export type AiVerdictKind = "buy" | "watch" | "avoid";

export interface HypeVerdict {
  hype: number;
  organic: number;
  mentions: string;
  narrative: string;
  redFlags: string[];
  verdict: AiVerdictKind;
  reason: string;
}

export interface EntryFeatures {
  source: string;
  momentum: number;
  signals: Signals;
  safety: SafetyMetrics;
  ai: HypeVerdict | null;
}

export interface TakeProfit {
  /** Price multiple vs. entry, e.g. 2 = 2x. */
  multiple: number;
  /** Fraction of the ORIGINAL position to sell at this level. */
  sellFraction: number;
}

/**
 * Basket mode: fill up to `slots` coins with equal slices of the round's money, ignore single-coin exits,
 * and close EVERYTHING when the whole basket hits the target, the floor or the time limit. Then start again
 * with whatever the basket is worth.
 */
export interface BasketParams {
  slots: number;
  targetMultiple: number;
  stopMultiple: number;
  maxRoundMin: number;
}

export interface StrategyParams {
  name: string;
  description: string;
  minMomentum: number;
  requireAi: boolean;
  minHype: number;
  minOrganic: number;
  allowWatchVerdict: boolean;
  positionUsd: number;
  maxOpen: number;
  dailyLossLimitUsd: number;
  reentryCooldownMin: number;
  stopLossPct: number;
  takeProfits: TakeProfit[];
  trailingStopPct: number;
  trailActivationMultiple: number;
  maxHoldMin: number;
  timeStopMinGainPct: number;
  /** Strategy-specific minimum pool size, on top of the global filter. */
  minLiquidityUsd?: number;
  basket?: BasketParams;
}

export interface ExitFill {
  at: number;
  reason: string;
  tokens: number;
  priceUsd: number;
  proceedsUsd: number;
}

export interface Position {
  id: string;
  strategy: string;
  mint: string;
  symbol: string;
  name: string;
  openedAt: number;
  entryPriceUsd: number;
  effectiveEntryUsd: number;
  costUsd: number;
  tokens: number;
  remainingTokens: number;
  proceedsUsd: number;
  peakPriceUsd: number;
  lastPriceUsd: number;
  lastLiquidityUsd?: number;
  takeProfitsHit: number[];
  exits: ExitFill[];
  features: EntryFeatures;
}

export interface ClosedTrade extends Position {
  closedAt: number;
  pnlUsd: number;
  pnlPct: number;
  peakMultiple: number;
  exitReason: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
