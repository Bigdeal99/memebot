import type { FilterConfig } from "./config.js";
import type { DexPair, Signals } from "./types.js";

function ratio(buys: number, sells: number): number {
  const total = buys + sells;
  return total > 0 ? buys / total : 0;
}

export function computeSignals(pair: DexPair, now = Date.now()): Signals {
  const buysM5 = pair.txns?.m5?.buys ?? 0;
  const sellsM5 = pair.txns?.m5?.sells ?? 0;
  const buysH1 = pair.txns?.h1?.buys ?? 0;
  const sellsH1 = pair.txns?.h1?.sells ?? 0;
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volumeM5Usd = pair.volume?.m5 ?? 0;
  const volumeH1Usd = pair.volume?.h1 ?? 0;

  return {
    priceUsd: Number(pair.priceUsd ?? 0),
    liquidityUsd,
    marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
    ageMin: pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : Number.POSITIVE_INFINITY,
    buysM5,
    sellsM5,
    buysH1,
    sellsH1,
    txnsH1: buysH1 + sellsH1,
    buyRatioM5: ratio(buysM5, sellsM5),
    buyRatioH1: ratio(buysH1, sellsH1),
    volumeM5Usd,
    volumeH1Usd,
    volumeH24Usd: pair.volume?.h24 ?? 0,
    volumeToLiquidityH1: liquidityUsd > 0 ? volumeH1Usd / liquidityUsd : 0,
    acceleration: volumeH1Usd > 0 ? (volumeM5Usd * 12) / volumeH1Usd : 0,
    changeM5Pct: pair.priceChange?.m5 ?? 0,
    changeH1Pct: pair.priceChange?.h1 ?? 0,
    changeH6Pct: pair.priceChange?.h6 ?? 0,
    hasSocials: (pair.info?.socials?.length ?? 0) > 0 || (pair.info?.websites?.length ?? 0) > 0,
    boosted: (pair.boosts?.active ?? 0) > 0,
  };
}

export interface PrefilterResult {
  pass: boolean;
  /** True when the token can never pass (too old / too big), so stop watching it. */
  permanent: boolean;
  reasons: string[];
}

/** Cheap checks on DexScreener data, done before spending any RugCheck or AI calls. */
export function prefilter(s: Signals, f: FilterConfig): PrefilterResult {
  const permanent: string[] = [];
  const temporary: string[] = [];

  if (s.ageMin > f.maxAgeHours * 60) permanent.push(`older than ${f.maxAgeHours}h`);
  if (s.marketCapUsd > f.maxMarketCapUsd) permanent.push(`market cap $${Math.round(s.marketCapUsd)} above max`);
  if (!(s.priceUsd > 0)) temporary.push("no price");
  if (s.liquidityUsd < f.minLiquidityUsd) temporary.push(`liquidity $${Math.round(s.liquidityUsd)} too low`);
  if (s.marketCapUsd < f.minMarketCapUsd) temporary.push(`market cap $${Math.round(s.marketCapUsd)} too low`);
  if (s.txnsH1 < f.minTxnsH1) temporary.push(`${s.txnsH1} txns/h too few`);
  if (s.volumeH1Usd < f.minVolumeH1Usd) temporary.push(`1h volume $${Math.round(s.volumeH1Usd)} too low`);

  return {
    pass: permanent.length === 0 && temporary.length === 0,
    permanent: permanent.length > 0,
    reasons: [...permanent, ...temporary],
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Linear ramp: 0 points at `from`, `max` points at `to` and beyond. */
function ramp(x: number, from: number, to: number, max: number): number {
  return clamp01((x - from) / (to - from)) * max;
}

export interface MomentumScore {
  score: number;
  parts: Record<string, number>;
}

/**
 * 0–100 score for "buyers are winning and it is speeding up, but we are not buying the top".
 * The weights are a starting point; the report command shows which features really separate winners.
 */
export function momentumScore(s: Signals): MomentumScore {
  const parts: Record<string, number> = {
    buyPressureH1: ramp(s.buyRatioH1, 0.5, 0.7, 20),
    buyPressureM5: ramp(s.buyRatioM5, 0.5, 0.75, 15),
    acceleration: ramp(s.acceleration, 1, 3, 20),
    turnover: ramp(s.volumeToLiquidityH1, 0.5, 3, 15),
    // Rising is good, but a +300% hour usually means we would be someone's exit liquidity.
    trendH1: s.changeH1Pct > 300 ? 0 : ramp(s.changeH1Pct, 0, 100, 15),
    trendM5: s.changeM5Pct > 40 ? 0 : ramp(s.changeM5Pct, 0, 15, 10),
    socials: s.hasSocials ? 5 : 0,
  };
  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  let score = raw;
  if (s.changeM5Pct < -15) {
    score *= 0.5; // actively dumping right now
    parts.dumpPenalty = score - raw;
  } else if (s.changeM5Pct > 40 || s.changeH1Pct > 300) {
    score *= 0.5; // vertical candle: late buyers become exit liquidity
    parts.overextendedPenalty = score - raw;
  }
  return { score: Math.round(score), parts };
}
