import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSignals, momentumScore, prefilter } from "../src/signals.js";
import { filters, NOW, strongPair } from "./fixtures.js";

describe("computeSignals", () => {
  it("derives ratios, age and acceleration from a DexScreener pair", () => {
    const s = computeSignals(strongPair(), NOW);
    assert.equal(s.priceUsd, 0.0004);
    assert.equal(s.ageMin, 180);
    assert.equal(s.txnsH1, 1000);
    assert.equal(s.buyRatioH1, 0.7);
    assert.equal(s.buyRatioM5, 0.75);
    assert.equal(s.volumeToLiquidityH1, 2.5);
    assert.equal(s.acceleration, (30_000 * 12) / 150_000);
    assert.equal(s.hasSocials, true);
  });

  it("survives a pair with missing optional fields", () => {
    const s = computeSignals({ ...strongPair(), txns: undefined, volume: undefined, liquidity: undefined, pairCreatedAt: undefined }, NOW);
    assert.equal(s.buyRatioH1, 0);
    assert.equal(s.volumeToLiquidityH1, 0);
    assert.equal(s.ageMin, Number.POSITIVE_INFINITY);
  });
});

describe("prefilter", () => {
  it("passes a healthy token", () => {
    assert.deepEqual(prefilter(computeSignals(strongPair(), NOW), filters), { pass: true, permanent: false, reasons: [] });
  });

  it("drops forever a token that is too old or too big", () => {
    const old = prefilter(computeSignals(strongPair({ pairCreatedAt: NOW - 72 * 3_600_000 }), NOW), filters);
    assert.equal(old.pass, false);
    assert.equal(old.permanent, true);
    const big = prefilter(computeSignals(strongPair({ marketCap: 9_000_000 }), NOW), filters);
    assert.equal(big.permanent, true);
  });

  it("waits until a brand-new pool is an hour old instead of buying the launch dump", () => {
    const r = prefilter(computeSignals(strongPair({ pairCreatedAt: NOW - 3 * 60_000 }), NOW), filters);
    assert.equal(r.pass, false);
    assert.equal(r.permanent, false);
    assert.equal(r.waitMin, 57);
  });

  it("does not fake 'acceleration' for a pool younger than one hour", () => {
    const young = computeSignals(strongPair({ pairCreatedAt: NOW - 3 * 60_000, volume: { m5: 30_000, h1: 30_000 } }), NOW);
    assert.equal(young.acceleration, 0);
  });

  it("keeps watching a token whose liquidity is still too low", () => {
    const r = prefilter(computeSignals(strongPair({ liquidity: { usd: 5_000 } }), NOW), filters);
    assert.equal(r.pass, false);
    assert.equal(r.permanent, false);
    assert.match(r.reasons.join(), /liquidity/);
  });
});

describe("momentumScore", () => {
  it("scores a strong, accelerating token high", () => {
    assert.ok(momentumScore(computeSignals(strongPair(), NOW)).score >= 70);
  });

  it("scores sellers-in-control low", () => {
    const weak = strongPair({
      txns: { m5: { buys: 20, sells: 60 }, h1: { buys: 300, sells: 700 } },
      priceChange: { m5: -5, h1: -20, h6: -40 },
      volume: { m5: 2_000, h1: 100_000 },
    });
    assert.ok(momentumScore(computeSignals(weak, NOW)).score < 30);
  });

  it("refuses to chase a vertical candle", () => {
    const strong = momentumScore(computeSignals(strongPair(), NOW)).score;
    const vertical = momentumScore(computeSignals(strongPair({ priceChange: { m5: 80, h1: 450 } }), NOW)).score;
    assert.ok(vertical < strong - 20, `vertical ${vertical} should be far below ${strong}`);
  });

  it("does not treat a coin down 40% in the last hour as momentum", () => {
    const strong = momentumScore(computeSignals(strongPair(), NOW)).score;
    const knife = momentumScore(computeSignals(strongPair({ priceChange: { m5: 2, h1: -40 } }), NOW));
    assert.ok(knife.score < 50 && knife.score < strong, `falling knife scored ${knife.score}`);
    assert.ok(knife.parts.dumpPenalty !== undefined && knife.parts.dumpPenalty < 0);
  });

  it("halves the score while the price is dumping", () => {
    const dumping = momentumScore(computeSignals(strongPair({ priceChange: { m5: -25, h1: 60 } }), NOW));
    assert.ok(dumping.parts.dumpPenalty !== undefined && dumping.parts.dumpPenalty < 0);
  });
});
