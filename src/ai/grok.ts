import type { AiConfig } from "../config.js";
import type { AiVerdictKind, HypeVerdict, Logger, Signals, TokenRef } from "../types.js";
import { requestJson } from "../util/http.js";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

const SYSTEM_PROMPT = `You are a skeptical Solana memecoin analyst. Your job is to protect the trader's money.
Use X search to look at what people posted about the token in the last 24 hours.
Search by the ticker with a $ sign AND by the contract address, because tickers are often reused by other scam tokens.

Judge:
- hype (0-10): how much real attention is there and is it growing right now?
- organic (0-10): does it look like many independent real people (10) or coordinated shilling, bots,
  copy-paste posts, paid "calls" and raid groups (0)?
- red flags: impersonating a celebrity, brand or news event; "CTO" takeover stories; dev dumped; many near-identical
  posts; only brand-new accounts; the contract address in posts does not match the one given.

If there are almost no posts, hype must be low. When unsure, choose "watch" or "avoid", never "buy".
Answer with ONLY a JSON object, no markdown, in exactly this shape:
{"hype": 0-10, "organic": 0-10, "mentions": "rough count and trend", "narrative": "one sentence",
 "red_flags": ["..."], "verdict": "buy" | "watch" | "avoid", "reason": "one or two sentences"}`;

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
