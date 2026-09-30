import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Bot } from "../src/bot.js";
import { config } from "../src/config.js";
import type { BookState } from "../src/paper/book.js";
import { Store } from "../src/store.js";
import { defaultStrategies } from "../src/strategies.js";
import type { ClosedTrade, Logger } from "../src/types.js";
import { cleanReport, MINT, strongPair } from "./fixtures.js";

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: (m) => console.error(m) };

let priceUsd = "0.0004";
const realFetch = globalThis.fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Fake DexScreener + RugCheck so the whole loop runs offline. */
function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/token-profiles/latest/v1")) return Promise.resolve(json([{ chainId: "solana", tokenAddress: MINT }]));
  if (url.includes("/token-boosts/")) return Promise.resolve(json([]));
  if (url.includes("/tokens/v1/solana/")) {
    return Promise.resolve(json([strongPair({ priceUsd, pairCreatedAt: Date.now() - 3 * 3_600_000 })]));
  }
  if (url.includes("api.rugcheck.xyz")) return Promise.resolve(json(cleanReport()));
  return Promise.reject(new Error(`unexpected request in test: ${url}`));
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe("Bot end-to-end (offline, paper mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "memebot-test-"));
  const store = new Store(dir);
  const state = (): BookState | null => store.loadJson<BookState>("state.json");
  const trades = (): ClosedTrade[] => (existsSync(join(dir, "trades.jsonl")) ? store.readAll<ClosedTrade>("trades.jsonl") : []);
  const bot = new Bot(
    {
      ...config,
      dataDir: dir,
      usePumpPortal: false,
      discoveryEverySec: 60,
      evaluateEverySec: 0.1,
      monitorEverySec: 0.1,
      summaryEveryMin: 60,
      ai: { ...config.ai, apiKey: "" },
      telegram: { botToken: "", chatId: "" },
      paper: { bankrollUsd: 1000, positionUsd: 25, frictionPctPerSide: 1 },
    },
    defaultStrategies(25),
    store,
    quiet,
  );

  before(() => {
    globalThis.fetch = fakeFetch as typeof fetch;
  });
  after(() => {
    bot.stop();
    globalThis.fetch = realFetch;
  });

  it("discovers, safety-checks, buys, takes profit and trails out", async () => {
    bot.start();

    await waitFor("paper buys", () => (state()?.positions.length ?? 0) >= 4);
    const bought = new Set(state()?.positions.map((p) => p.strategy));
    assert.deepEqual([...bought].sort(), ["baseline", "basket", "lottery", "quick_flip"], "only non-AI strategies may buy without a key");

    const decisions = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    assert.match(decisions, /needs AI but no XAI_API_KEY/);

    // 2x: quick_flip sells everything at +40%, baseline sells half.
    priceUsd = "0.0008";
    await waitFor("quick_flip closed", () => trades().some((t) => t.strategy === "quick_flip"));
    await waitFor("baseline half sold", () =>
      (state()?.positions.find((p) => p.strategy === "baseline")?.takeProfitsHit.length ?? 0) === 1,
    );
    const flip = trades().find((t) => t.strategy === "quick_flip");
    assert.ok(flip && flip.pnlUsd > 20, `quick_flip pnl ${flip?.pnlUsd}`);

    // Run up to 3x, then fall back: the trailing stop closes the rest of baseline.
    priceUsd = "0.0012";
    await sleep(1_500);
    priceUsd = "0.0005";
    await waitFor("baseline closed", () => trades().some((t) => t.strategy === "baseline"));
    const base = trades().find((t) => t.strategy === "baseline");
    assert.ok(base, "baseline trade recorded");
    assert.match(base.exitReason, /trailing stop/);
    assert.ok(base.pnlUsd > 5, `baseline pnl ${base.pnlUsd}`);
    assert.ok(Math.abs(base.peakMultiple - 3) < 1e-9, `peak ${base.peakMultiple}`);
  });
});
