import type { FilterConfig, SafetyConfig } from "../src/config.js";
import type { RugReport } from "../src/sources/rugcheck.js";
import type { DexPair, EntryFeatures, Signals, StrategyParams } from "../src/types.js";

export const NOW = Date.parse("2026-09-29T12:00:00Z");
export const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

/** A healthy, pumping token 3 hours old. Shape follows DexScreener /tokens/v1 responses. */
export function strongPair(overrides: Partial<DexPair> = {}): DexPair {
  return {
    chainId: "solana",
    dexId: "pumpswap",
    url: "https://dexscreener.com/solana/pool1",
    pairAddress: "Pool1111111111111111111111111111111111111111",
    baseToken: { address: MINT, name: "Test Cat", symbol: "TCAT" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
    priceUsd: "0.0004",
    txns: { m5: { buys: 90, sells: 30 }, h1: { buys: 700, sells: 300 }, h24: { buys: 2000, sells: 1200 } },
    volume: { m5: 30_000, h1: 150_000, h6: 400_000, h24: 600_000 },
    priceChange: { m5: 8, h1: 60, h6: 120, h24: 150 },
    liquidity: { usd: 60_000, base: 75_000_000, quote: 150 },
    fdv: 400_000,
    marketCap: 400_000,
    pairCreatedAt: NOW - 3 * 60 * 60_000,
    info: { socials: [{ type: "twitter", url: "https://x.com/testcat" }] },
    ...overrides,
  };
}

export const filters: FilterConfig = {
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 30_000,
  maxMarketCapUsd: 3_000_000,
  maxAgeHours: 48,
  minTxnsH1: 150,
  minVolumeH1Usd: 10_000,
};

export const safetyCfg: SafetyConfig = {
  maxTop10Pct: 30,
  maxSingleHolderPct: 10,
  maxInsiderPct: 10,
  maxRiskScore: 50,
  minLpLockedPct: 80,
  failOnDanger: true,
  strictUnknown: true,
};

export const POOL_VAULT = "Vau1t11111111111111111111111111111111111111";

/** Shape follows RugCheck GET /v1/tokens/{mint}/report. The pool vault is the biggest "holder". */
export function cleanReport(overrides: Partial<RugReport> = {}): RugReport {
  return {
    mint: MINT,
    mintAuthority: null,
    freezeAuthority: null,
    rugged: false,
    score: 101,
    score_normalised: 3,
    risks: [{ name: "Low amount of LP Providers", level: "warn", score: 100 }],
    topHolders: [
      { address: POOL_VAULT, owner: "PoolAuth1111111111111111111111111111111111", pct: 18.2, insider: false },
      { address: "Ho1der1", owner: "W1", pct: 4.1, insider: false },
      { address: "Ho1der2", owner: "W2", pct: 3.2, insider: false },
      { address: "Ho1der3", owner: "W3", pct: 2.5, insider: false },
      { address: "Ho1der4", owner: "W4", pct: 1.9, insider: false },
    ],
    markets: [
      {
        pubkey: "Pool1111111111111111111111111111111111111111",
        marketType: "pump_amm",
        liquidityA: POOL_VAULT,
        lp: { lpLockedPct: 100 },
      },
    ],
    graphInsidersDetected: 0,
    ...overrides,
  };
}

export function strategy(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return {
    name: "test",
    description: "test strategy",
    minMomentum: 60,
    requireAi: false,
    minHype: 0,
    minOrganic: 0,
    allowWatchVerdict: false,
    positionUsd: 25,
    maxOpen: 5,
    dailyLossLimitUsd: 100,
    reentryCooldownMin: 360,
    stopLossPct: 30,
    takeProfits: [{ multiple: 2, sellFraction: 0.5 }],
    trailingStopPct: 30,
    trailActivationMultiple: 1.5,
    maxHoldMin: 360,
    timeStopMinGainPct: 20,
    ...overrides,
  };
}

export function features(signals: Signals): EntryFeatures {
  return { source: "test", momentum: 70, signals, safety: {}, ai: null };
}
