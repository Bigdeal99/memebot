import type { AiConfig } from "../config.js";
import type { AiVerdictKind, DebatePoint, DebateResult, HypeVerdict, Logger, SafetyMetrics, Signals, TokenRef } from "../types.js";
import { requestJson } from "../util/http.js";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

const SYSTEM_PROMPT = `You are a Solana memecoin analyst who protects the trader's money without being paranoid.
Use X search to look at what people posted about the token in the last 24 hours.
Search by the ticker with a $ sign AND by the contract address, because tickers are often reused by other scam tokens.

Score RELATIVE TO SMALL SOLANA MEMECOINS (market cap $50k-$5M), not to Bitcoin or famous projects.
Coins this size normally have modest X activity, so judge what is normal for their size.

hype (0-10), how much attention right now and is it growing:
  0-2 no posts at all, or only bots | 3-4 a handful of real accounts | 5-6 a steady stream from many different
  accounts in the last few hours | 7-8 clearly trending, accounts with real followings, growing fast | 9-10 viral
organic (0-10), who is talking:
  0-2 obviously coordinated (copy-paste, raid bots, brand-new accounts) | 3-4 mostly paid calls and shill groups |
  5-6 a mix of shills and real people | 7-10 mostly independent real people
red flags (concrete only): impersonating a celebrity, brand or news event; "CTO" takeover stories; dev dumped;
  a bot farm of near-identical posts; the contract address in posts does not match the one given.

verdict: "avoid" ONLY for a concrete red flag or zero real attention. "buy" when hype >= 6, organic >= 5 and no
red flags. Everything else is "watch".
Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"hype": 0-10, "organic": 0-10, "mentions": "rough count and trend", "narrative": "one sentence",
 "red_flags": ["..."], "verdict": "buy" | "watch" | "avoid", "reason": "one or two sentences"}`;

const DEBATE_PROMPT = `You run a two-sided review of a possible Solana memecoin buy, using ONLY the on-chain data given.
Never invent numbers or facts that are not in the data.

BEAR: give exactly 3 concrete reasons NOT to buy. Each must cite a specific number or flag from the data.
ANALYST: rebut each Bear reason using the data. If the data does not clearly refute it, admit it and set
"rebutted": false. Do not rebut with hope, narratives or things the data does not show.

Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"debate": [{"reason": "...", "evidence": "the number or flag cited", "rebuttal": "...", "rebutted": true|false},
            {...}, {...}],
 "summary": "one sentence"}`;

export function buildDebatePrompt(token: TokenRef, s: Signals, safety: SafetyMetrics): string {
  return JSON.stringify(
    {
      token: { name: token.name, symbol: token.symbol, mint: token.mint },
      market: {
        priceUsd: s.priceUsd,
        marketCapUsd: Math.round(s.marketCapUsd),
        liquidityUsd: Math.round(s.liquidityUsd),
        poolAgeMinutes: Math.round(s.ageMin),
        priceChangePct: { m5: s.changeM5Pct, h1: s.changeH1Pct, h6: s.changeH6Pct },
        volumeUsd: { m5: Math.round(s.volumeM5Usd), h1: Math.round(s.volumeH1Usd), h24: Math.round(s.volumeH24Usd) },
        txns: { m5: { buys: s.buysM5, sells: s.sellsM5 }, h1: { buys: s.buysH1, sells: s.sellsH1 } },
        volumeToLiquidityH1: Number(s.volumeToLiquidityH1.toFixed(2)),
        volumeAcceleration: Number(s.acceleration.toFixed(2)),
      },
      holders: {
        top10PctExcludingPools: safety.top10Pct,
        biggestHolderPct: safety.topHolderPct,
        insiderPct: safety.insiderPct,
        devWalletPct: safety.devPct,
        insiderWalletsDetected: safety.insidersDetected,
      },
      contract: { rugcheckRiskScore: safety.riskScore, lpLockedOrBurnedPct: safety.lpLockedPct, rugcheckFlags: safety.risks },
    },
    null,
    1,
  );
}

/** Parses the debate. Anything other than exactly 3 points, every one rebutted, is a veto. */
export function parseDebate(text: string): DebateResult | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(raw.debate)) return null;
  const points: DebatePoint[] = raw.debate.map((p: Record<string, unknown>) => ({
    reason: String(p?.reason ?? ""),
    evidence: String(p?.evidence ?? ""),
    rebuttal: String(p?.rebuttal ?? ""),
    rebutted: p?.rebutted === true,
  }));
  return {
    points,
    summary: String(raw.summary ?? ""),
    passed: points.length === 3 && points.every((p) => p.rebutted),
  };
}

export function buildPrompt(token: TokenRef, s: Signals): string {
  return [
    `Token: ${token.name} ($${token.symbol})`,
    `Contract address (mint): ${token.mint}`,
    `On-chain right now: price change 5m ${s.changeM5Pct}% / 1h ${s.changeH1Pct}% / 6h ${s.changeH6Pct}%,`,
    `market cap $${Math.round(s.marketCapUsd)}, liquidity $${Math.round(s.liquidityUsd)},`,
    `1h volume $${Math.round(s.volumeH1Usd)}, 1h buys ${s.buysH1} vs sells ${s.sellsH1},`,
    `pool age ${Math.round(s.ageMin)} minutes.`,
    "Is the attention on X real and growing? Reply with the JSON only.",
  ].join("\n");
}

interface ResponsesApiResult {
  output_text?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
}

/** Pulls the final assistant text out of a Responses API result. */
export function extractText(res: ResponsesApiResult): string {
  if (typeof res.output_text === "string" && res.output_text !== "") return res.output_text;
  const parts: string[] = [];
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 0;
}

const VERDICTS: readonly AiVerdictKind[] = ["buy", "watch", "avoid"];

/** Parses the model's JSON, tolerating code fences or extra text around it. Returns null if unusable. */
export function parseVerdict(text: string): HypeVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = String(raw.verdict ?? "").toLowerCase() as AiVerdictKind;
  return {
    hype: clampScore(raw.hype),
    organic: clampScore(raw.organic),
    mentions: String(raw.mentions ?? ""),
    narrative: String(raw.narrative ?? ""),
    redFlags: Array.isArray(raw.red_flags) ? raw.red_flags.map(String) : [],
    // Anything we do not understand is treated as the safest answer.
    verdict: VERDICTS.includes(verdict) ? verdict : "avoid",
    reason: String(raw.reason ?? ""),
  };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Asks Grok (with live X search) whether the hype around a token is real. Has a daily call budget. */
export class GrokAnalyst {
  private readonly cache = new Map<string, { at: number; verdict: HypeVerdict }>();
  private day = "";
  private callsToday = 0;
  private readonly debateCache = new Map<string, { at: number; result: DebateResult }>();
  private debateDay = "";
  private debatesToday = 0;

  constructor(
    private readonly cfg: AiConfig,
    private readonly log: Logger,
  ) {}

  get enabled(): boolean {
    return this.cfg.apiKey !== "";
  }

  callsUsedToday(now = Date.now()): number {
    return utcDay(now) === this.day ? this.callsToday : 0;
  }

  debatesUsedToday(now = Date.now()): number {
    return utcDay(now) === this.debateDay ? this.debatesToday : 0;
  }

  /** Bear vs Analyst on our own on-chain numbers (no X search). Null when disabled, out of budget or unusable. */
  async debate(token: TokenRef, s: Signals, safety: SafetyMetrics, now = Date.now()): Promise<DebateResult | null> {
    if (!this.enabled) return null;
    const cached = this.debateCache.get(token.mint);
    if (cached && now - cached.at < this.cfg.cacheMin * 60_000) return cached.result;

    if (utcDay(now) !== this.debateDay) {
      this.debateDay = utcDay(now);
      this.debatesToday = 0;
    }
    if (this.debatesToday >= this.cfg.maxDebatesPerDay) return null;
    this.debatesToday++;

    const res = await requestJson<ResponsesApiResult>(XAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      body: {
        model: this.cfg.model,
        input: [
          { role: "system", content: DEBATE_PROMPT },
          { role: "user", content: buildDebatePrompt(token, s, safety) },
        ],
      },
      timeoutMs: 120_000,
      retries: 1,
    });
    const result = res ? parseDebate(extractText(res)) : null;
    if (!result) {
      this.log.warn(`Grok debate gave no usable answer for ${token.symbol}`);
      return null;
    }
    this.debateCache.set(token.mint, { at: now, result });
    return result;
  }

  async assess(token: TokenRef, s: Signals, now = Date.now()): Promise<HypeVerdict | null> {
    if (!this.enabled) return null;

    const cached = this.cache.get(token.mint);
    if (cached && now - cached.at < this.cfg.cacheMin * 60_000) return cached.verdict;

    if (utcDay(now) !== this.day) {
      this.day = utcDay(now);
      this.callsToday = 0;
    }
    if (this.callsToday >= this.cfg.maxCallsPerDay) return null;
    this.callsToday++;

    const res = await requestJson<ResponsesApiResult>(XAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      body: {
        model: this.cfg.model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(token, s) },
        ],
        tools: [{ type: "x_search" }],
      },
      timeoutMs: 120_000,
      retries: 1,
    });

    const verdict = res ? parseVerdict(extractText(res)) : null;
    if (!verdict) {
      this.log.warn(`Grok gave no usable answer for ${token.symbol}`);
      return null;
    }
    this.cache.set(token.mint, { at: now, verdict });
    return verdict;
  }
}
