import { RateLimiter, requestJson } from "../util/http.js";

export interface RugHolder {
  address: string;
  owner?: string;
  pct?: number;
  insider?: boolean;
}

export interface RugRisk {
  name: string;
  level?: string;
  description?: string;
  score?: number;
  value?: string;
}

export interface RugMarket {
  pubkey?: string;
  marketType?: string;
  lp?: { lpLockedPct?: number };
  [key: string]: unknown;
}

/** Subset of GET /v1/tokens/{mint}/report. Every field is optional because the API is not versioned strictly. */
export interface RugReport {
  mint?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  rugged?: boolean;
  score?: number;
  score_normalised?: number;
  risks?: RugRisk[] | null;
  topHolders?: RugHolder[] | null;
  markets?: RugMarket[] | null;
  totalMarketLiquidity?: number;
  graphInsidersDetected?: number;
  lpLockedPct?: number;
}

const BASE = "https://api.rugcheck.xyz/v1";
const CACHE_MS = 10 * 60_000;
const limiter = new RateLimiter(30);
const cache = new Map<string, { at: number; report: RugReport | null }>();

/** Returns null when RugCheck has not indexed the token yet. */
export async function getRugReport(mint: string, now = Date.now()): Promise<RugReport | null> {
  const hit = cache.get(mint);
  if (hit && now - hit.at < CACHE_MS) return hit.report;
  const report = await requestJson<RugReport>(`${BASE}/tokens/${mint}/report`, {
    limiter,
    allow404: true,
    timeoutMs: 20_000,
  });
  cache.set(mint, { at: now, report });
  return report;
}
