import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDebatePrompt, parseDebate } from "../src/ai/grok.js";
import { PaperBook } from "../src/paper/book.js";
import { evaluateSafety } from "../src/safety.js";
import { computeSignals } from "../src/signals.js";
import { defaultStrategies, deskHoldersAllows, deskMarketAllows } from "../src/strategies.js";
import { cleanReport, features, NOW, safetyCfg, strategy, strongPair } from "./fixtures.js";

const desk = defaultStrategies(25).find((s) => s.name === "grok_desk");
const d = desk?.desk;

describe("grok_desk filters", () => {
  it("exists with the prompt's numbers", () => {
    assert.ok(desk && d);
    assert.equal(desk.stopLossPct, 6);
    assert.equal(desk.trailActivationMultiple, 1.12);
    assert.equal(desk.positionPctOfEquity, 8);
    assert.equal(desk.minAgeMin, 30);
  });

  it("scout keeps $300k-$20M coins with a $40k+ pool, kills the rest", () => {
    assert.ok(d);
    assert.equal(deskMarketAllows(d, computeSignals(strongPair(), NOW)), null);
    assert.match(deskMarketAllows(d, computeSignals(strongPair({ marketCap: 100_000 }), NOW)) ?? "", /mcap/);
    assert.match(deskMarketAllows(d, computeSignals(strongPair({ liquidity: { usd: 30_000 } }), NOW)) ?? "", /pool/);
  });

  it("kills a dev wallet above 3% and LP that is not burned", () => {
    assert.ok(d);
    const ok = evaluateSafety(cleanReport(), safetyCfg).metrics;
    assert.equal(deskHoldersAllows(d, ok), null);
    const devHeavy = evaluateSafety(cleanReport({ creator: "W1" }), safetyCfg).metrics; // W1 owns 4.1%
    assert.equal(devHeavy.devPct, 4.1);
    assert.match(deskHoldersAllows(d, devHeavy) ?? "", /dev wallet/);
    assert.match(deskHoldersAllows(d, { ...ok, lpLockedPct: 60 }) ?? "", /LP burned/);
  });
});

describe("Bear vs Analyst debate", () => {
  const point = (rebutted: boolean) =>
    `{"reason": "sells rising", "evidence": "h1 sells 300", "rebuttal": "buys 700", "rebutted": ${rebutted}}`;

  it("passes only when all 3 Bear points are rebutted", () => {
    const won = parseDebate(`{"debate": [${point(true)}, ${point(true)}, ${point(true)}], "summary": "ok"}`);
    assert.equal(won?.passed, true);
    const veto = parseDebate(`noise {"debate": [${point(true)}, ${point(false)}, ${point(true)}]} noise`);
    assert.equal(veto?.passed, false);
    const short = parseDebate(`{"debate": [${point(true)}, ${point(true)}]}`);
    assert.equal(short?.passed, false, "fewer than 3 Bear points is a veto");
    assert.equal(parseDebate("no json here"), null);
  });

  it("gives Grok our real on-chain numbers", () => {
    const prompt = buildDebatePrompt(
      { mint: "M", symbol: "TCAT", name: "Test Cat" },
      computeSignals(strongPair(), NOW),
      evaluateSafety(cleanReport(), safetyCfg).metrics,
    );
    const data = JSON.parse(prompt);
    assert.equal(data.market.liquidityUsd, 60000);
    assert.equal(data.holders.top10PctExcludingPools, 11.7);
    assert.equal(data.contract.lpLockedOrBurnedPct, 100);
  });
});

describe("percentage position sizing", () => {
  it("bets 8% of the strategy's current money", () => {
    const st = strategy({ positionUsd: 0, positionPctOfEquity: 8 });
    const book = new PaperBook([st], { bankrollUsd: 1000, frictionPctPerSide: 0 });
    assert.equal(book.positionSize(st), 80);
    book.enter("test", { mint: "A", symbol: "A", name: "A" }, 1, 1e12, features(computeSignals(strongPair(), NOW)), NOW);
    assert.equal(book.cashOf("test"), 920);
  });
});
