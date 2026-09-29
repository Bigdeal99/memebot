import { RateLimiter, requestJson } from "../util/http.js";
import type { Discovery } from "./dexscreener.js";

const BASE = "https://api.geckoterminal.com/api/v2";
// Free keyless tier: 30 calls/min. We use two per discovery round.
const limiter = new RateLimiter(20);

interface TrendingPools {
  data?: { relationships?: { base_token?: { data?: { id?: string } } } }[];
}

/** "solana_<mint>" -> "<mint>" */
export function mintFromTokenId(id: string | undefined): string | undefined {
  if (!id?.startsWith("solana_")) return undefined;
  const mint = id.slice("solana_".length);
  return mint.length >= 32 ? mint : undefined;
}

export function parseTrending(body: TrendingPools | null): string[] {
  return (body?.data ?? [])
    .map((p) => mintFromTokenId(p.relationships?.base_token?.data?.id))
    .filter((m): m is string => m !== undefined);
}

/** Pools that are trending right now on Solana, whatever their age: coins that are already moving. */
export async function discoverTrending(): Promise<Discovery[]> {
  const mints = new Set<string>();
  for (const page of [1, 2]) {
    const body = await requestJson<TrendingPools>(`${BASE}/networks/solana/trending_pools?page=${page}`, {
      limiter,
      retries: 1,
    });
    for (const m of parseTrending(body)) mints.add(m);
  }
  return [...mints].map((mint) => ({ mint, source: "gecko-trending" }));
}
