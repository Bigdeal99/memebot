import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Bot } from "../src/bot.js";
import { config } from "../src/config.js";
import type { BookState } from "../src/paper/book.js";
import { Store } from "../src/store.js";
import { defaultStrategies } from "../src/strategies.js";
import type { Logger } from "../src/types.js";
import { cleanReport, MINT, strongPair } from "./fixtures.js";

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: (m) => console.error(m) };
const realFetch = globalThis.fetch;
let grokCalls = 0;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const point = { reason: "sells picked up", evidence: "h1 sells 300", rebuttal: "buys are 700", rebutted: true };

/** Fake DexScreener + RugCheck + a Grok whose Analyst wins every point. */
function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/token-profiles/latest/v1")) return Promise.resolve(json([{ chainId: "solana", tokenAddress: MINT }]));
  if (url.includes("/token-boosts/")) return Promise.resolve(json([]));
  if (url.includes("/tokens/v1/solana/")) {
    return Promise.resolve(json([strongPair({ pairCreatedAt: Date.now() - 3 * 3_600_000 })]));
  }
  if (url.includes("api.rugcheck.xyz")) return Promise.resolve(json(cleanReport()));
  if (url.includes("api.x.ai")) {
    grokCalls++;
    return Promise.resolve(json({ output_text: JSON.stringify({ debate: [point, point, point], summary: "fine" }) }));
  }
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

describe("grok_desk end-to-end (offline, paper mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "memebot-desk-"));
  const store = new Store(dir);
  const bot = new Bot(
    {
      ...config,
      dataDir: dir,
      usePumpPortal: false,
      discoveryEverySec: 60,
      evaluateEverySec: 0.1,
      monitorEverySec: 60,
      summaryEveryMin: 60,
      ai: { ...config.ai, apiKey: "test-key", maxCallsPerDay: 0, maxDebatesPerDay: 5 },
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

  it("buys 8% of its money when the Analyst rebuts all three Bear points, and logs the debate", async () => {
    bot.start();
    await waitFor("desk buy", () =>
      (store.loadJson<BookState>("state.json")?.positions ?? []).some((p) => p.strategy === "grok_desk"),
    );
    const pos = store.loadJson<BookState>("state.json")?.positions.find((p) => p.strategy === "grok_desk");
    assert.equal(pos?.costUsd, 80);
    assert.equal(grokCalls, 1, "one debate per coin, hype checks were budgeted to zero");
    const log = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    assert.match(log, /"debate":\{"points":\[/);
    assert.match(log, /Analyst rebutted all 3 Bear points/);
  });
});
