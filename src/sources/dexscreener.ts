import type { DexPair } from "../types.js";
import { RateLimiter, requestJson } from "../util/http.js";

const BASE = "https://api.dexscreener.com";
const MAX_TOKENS_PER_CALL = 30;

// Published limits: 60/min for profile & boost endpoints, 300/min for pair & token endpoints.
const slowLimiter = new RateLimiter(55);
const fastLimiter = new RateLimiter(280);

interface TokenListing {
  chainId: string;
  tokenAddress: string;
}

export interface Discovery {
  mint: string;
  source: string;
}

async function listing(path: string, source: string): Promise<Discovery[]> {
  const rows = (await requestJson<TokenListing[]>(`${BASE}${path}`, { limiter: slowLimiter })) ?? [];
  return rows
    .filter((r) => r.chainId === "solana" && typeof r.tokenAddress === "string")
    .map((r) => ({ mint: r.tokenAddress, source }));
}

/** Solana tokens that just got a DexScreener profile or paid boost (teams spending money on promotion). */
export async function discoverSolanaTokens(): Promise<Discovery[]> {
  const results = await Promise.allSettled([
    listing("/token-profiles/latest/v1", "dex-profile"),
    listing("/token-boosts/latest/v1", "dex-boost"),
    listing("/token-boosts/top/v1", "dex-top-boost"),
  ]);
  const firstFailure = results.find((r) => r.status === "rejected");
  if (firstFailure && results.every((r) => r.status === "rejected")) throw firstFailure.reason;

  const seen = new Map<string, Discovery>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const d of r.value) if (!seen.has(d.mint)) seen.set(d.mint, d);
  }
  return [...seen.values()];
}

/** Picks the most liquid pool where the token is the base token. */
export function bestPairFor(mint: string, pairs: DexPair[]): DexPair | undefined {
  let best: DexPair | undefined;
  for (const p of pairs) {
    if (p.chainId !== "solana" || p.baseToken?.address !== mint) continue;
    if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}

/** Fetches pair data for many mints (batched 30 per request). */
export async function getBestPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const unique = [...new Set(mints)];
  const out = new Map<string, DexPair>();
  for (let i = 0; i < unique.length; i += MAX_TOKENS_PER_CALL) {
    const chunk = unique.slice(i, i + MAX_TOKENS_PER_CALL);
    const pairs =
      (await requestJson<DexPair[]>(`${BASE}/tokens/v1/solana/${chunk.join(",")}`, { limiter: fastLimiter })) ?? [];
    for (const mint of chunk) {
      const best = bestPairFor(mint, pairs);
      if (best) out.set(mint, best);
    }
  }
  return out;
}
