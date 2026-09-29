import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperBook, priceImpact } from "../src/paper/book.js";
import { decideExit } from "../src/paper/exits.js";
import { strategyStats } from "../src/report.js";
import { computeSignals } from "../src/signals.js";
import { shouldEnter } from "../src/strategies.js";
import type { HypeVerdict, Position } from "../src/types.js";
import { features, MINT, NOW, strategy, strongPair } from "./fixtures.js";

const token = { mint: MINT, symbol: "TCAT", name: "Test Cat" };
const MIN = 60_000;
const LIQ = 60_000;

function newBook(st = strategy(), frictionPctPerSide = 1) {
  return new PaperBook([st], { bankrollUsd: 1000, frictionPctPerSide });
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "p1",
    strategy: "test",
    mint: MINT,
    symbol: "TCAT",
    name: "Test Cat",
    openedAt: NOW,
    entryPriceUsd: 1,
    effectiveEntryUsd: 1.02,
    costUsd: 25,
    tokens: 100,
    remainingTokens: 100,
    proceedsUsd: 0,
    peakPriceUsd: 1,
    lastPriceUsd: 1,
    takeProfitsHit: [],
    exits: [],
    features: features(computeSignals(strongPair(), NOW)),
    ...overrides,
  };
}

describe("decideExit", () => {
  const st = strategy();

  it("holds inside the range", () => {
    assert.deepEqual(decideExit(position(), st, 1.1, LIQ, NOW + MIN), { kind: "hold" });
  });

  it("sells everything at the stop loss", () => {
    const d = decideExit(position(), st, 0.69, LIQ, NOW + MIN);
    assert.deepEqual(d, { kind: "sell", tokens: 100, reason: "stop loss -30%" });
  });

  it("sells half at 2x", () => {
    const d = decideExit(position({ peakPriceUsd: 2.1 }), st, 2.1, LIQ, NOW + MIN);
    assert.deepEqual(d, { kind: "sell", tokens: 50, reason: "take profit 2x", takeProfitIndex: 0 });
  });

  it("trails the rest after the first take profit", () => {
    const pos = position({ remainingTokens: 50, takeProfitsHit: [0], peakPriceUsd: 4 });
    assert.equal(decideExit(pos, st, 3, LIQ, NOW + MIN).kind, "hold");
    const d = decideExit(pos, st, 2.7, LIQ, NOW + MIN);
    assert.equal(d.kind === "sell" && d.tokens, 50);
  });

  it("time-stops a token that went nowhere", () => {
    const d = decideExit(position(), st, 1.05, LIQ, NOW + 361 * MIN);
    assert.equal(d.kind === "sell" && d.reason, "time stop: no move");
  });

  it("dumps immediately when liquidity disappears", () => {
    const d = decideExit(position(), st, 1.5, 200, NOW + MIN);
    assert.equal(d.kind === "sell" && d.reason, "liquidity gone (likely rug)");
  });
});

describe("PaperBook", () => {
  it("charges fees and price impact on the way in and out", () => {
    const book = newBook();
    const pos = book.enter("test", token, 1, LIQ, features(computeSignals(strongPair(), NOW)), NOW);
    const impact = priceImpact(25, LIQ);
    assert.ok(Math.abs(pos.effectiveEntryUsd - (1 + 0.01 + impact)) < 1e-12);
    assert.equal(book.cashOf("test"), 975);

    // Flat price, time stop: a round trip at the same price must lose money to costs.
    const events = book.onPrice(MINT, 1, LIQ, NOW + 361 * MIN);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.ok(e?.type === "closed");
    assert.ok(e.trade.pnlUsd < 0 && e.trade.pnlUsd > -1.5, `pnl ${e.trade.pnlUsd}`);
    assert.equal(book.positions.length, 0);
  });

  it("runs a full winner: half at 2x, trailing stop on the rest", () => {
    const book = newBook(strategy(), 0);
    book.enter("test", token, 1, 10_000_000, features(computeSignals(strongPair(), NOW)), NOW);
    const first = book.onPrice(MINT, 2, 10_000_000, NOW + 10 * MIN);
    assert.equal(first[0]?.type, "partial");
    assert.deepEqual(book.onPrice(MINT, 3, 10_000_000, NOW + 20 * MIN), []);
    const last = book.onPrice(MINT, 2, 10_000_000, NOW + 30 * MIN);
    const closed = last[0];
    assert.ok(closed?.type === "closed");
    // ~12.5 tokens sold at 2 (+25) and ~12.5 at 2 (+25) on a $25 cost -> ~ +$25 minus tiny impact.
    assert.ok(closed.trade.pnlUsd > 24.9 && closed.trade.pnlUsd <= 25, `pnl ${closed.trade.pnlUsd}`);
    assert.equal(closed.trade.peakMultiple, 3);
  });

  it("enforces max open, duplicate, re-entry cooldown and daily loss limit", () => {
    const st = strategy({ maxOpen: 1, dailyLossLimitUsd: 5 });
    const book = newBook(st);
    const f = features(computeSignals(strongPair(), NOW));
    book.enter("test", token, 1, LIQ, f, NOW);
    assert.equal(book.canEnter("test", MINT, NOW), "already holding");
    assert.equal(book.canEnter("test", "OtherMint", NOW), "max 1 open positions");

    book.onPrice(MINT, 0.5, LIQ, NOW + MIN); // stop loss, about -$13
    assert.equal(book.canEnter("test", "OtherMint", NOW + 2 * MIN), "daily loss limit hit");
    const nextDay = NOW + 24 * 60 * MIN;
    assert.equal(book.canEnter("test", "OtherMint", nextDay), null);
  });

  it("does not revenge-trade the same token right after closing it", () => {
    const book = newBook(strategy({ dailyLossLimitUsd: 1000, reentryCooldownMin: 360 }));
    book.enter("test", token, 1, LIQ, features(computeSignals(strongPair(), NOW)), NOW);
    book.onPrice(MINT, 0.5, LIQ, NOW + MIN);
    assert.equal(book.canEnter("test", MINT, NOW + 60 * MIN), "re-entry cooldown");
    assert.equal(book.canEnter("test", MINT, NOW + 362 * MIN), null);
  });

  it("restores from a saved snapshot", () => {
    const book = newBook();
    book.enter("test", token, 1, LIQ, features(computeSignals(strongPair(), NOW)), NOW);
    const restored = new PaperBook([strategy()], { bankrollUsd: 1000, frictionPctPerSide: 1 }, book.snapshot());
    assert.equal(restored.positions.length, 1);
    assert.equal(restored.cashOf("test"), 975);
  });
});

describe("shouldEnter", () => {
  const verdict = (v: Partial<HypeVerdict>): HypeVerdict => ({
    hype: 8,
    organic: 7,
    mentions: "",
    narrative: "",
    redFlags: [],
    verdict: "buy",
    reason: "",
    ...v,
  });

  it("baseline ignores the AI completely", () => {
    const st = strategy({ requireAi: false });
    assert.equal(shouldEnter(st, 65, verdict({ verdict: "avoid" }), true).enter, true);
    assert.equal(shouldEnter(st, 50, null, false).enter, false);
  });

  it("AI strategies need a confident, organic buy verdict", () => {
    const st = strategy({ requireAi: true, minHype: 5, minOrganic: 5 });
    assert.equal(shouldEnter(st, 65, verdict({}), true).enter, true);
    assert.equal(shouldEnter(st, 65, null, false).enter, false);
    assert.equal(shouldEnter(st, 65, verdict({ verdict: "watch" }), true).enter, false);
    assert.equal(shouldEnter(st, 65, verdict({ organic: 3 }), true).enter, false);
  });
});

describe("strategyStats", () => {
  it("computes win rate, expectancy and drawdown", () => {
    const base = position();
    const trade = (pnlUsd: number, closedAt: number) => ({
      ...base,
      closedAt,
      pnlUsd,
      pnlPct: (pnlUsd / 25) * 100,
      peakMultiple: 1,
      exitReason: "x",
    });
    const s = strategyStats("test", [trade(50, 1), trade(-10, 2), trade(-10, 3), trade(20, 4)]);
    assert.equal(s.trades, 4);
    assert.equal(s.winRatePct, 50);
    assert.equal(s.pnlUsd, 50);
    assert.equal(s.expectancyUsd, 12.5);
    assert.equal(s.maxDrawdownUsd, 20);
  });
});
