import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSafety, realHolders } from "../src/safety.js";
import { cleanReport, POOL_VAULT, safetyCfg } from "./fixtures.js";

describe("evaluateSafety", () => {
  it("passes a clean token and ignores the pool vault as a holder", () => {
    const r = evaluateSafety(cleanReport(), safetyCfg);
    assert.equal(r.pass, true, r.reasons.join("; "));
    assert.equal(r.metrics.top10Pct, 11.7);
    assert.equal(r.metrics.topHolderPct, 4.1);
    assert.equal(r.metrics.lpLockedPct, 100);
    assert.ok(!realHolders(cleanReport()).some((h) => h.address === POOL_VAULT));
  });

  it("asks to retry later when RugCheck has no report yet", () => {
    const r = evaluateSafety(null, safetyCfg);
    assert.equal(r.pass, false);
    assert.equal(r.retryable, true);
  });

  it("fails when the dev can still mint or freeze", () => {
    const r = evaluateSafety(cleanReport({ mintAuthority: "Dev1", freezeAuthority: "Dev1" }), safetyCfg);
    assert.equal(r.pass, false);
    assert.equal(r.retryable, false);
    assert.equal(r.reasons.length, 2);
  });

  it("fails on concentrated holders and insiders", () => {
    const r = evaluateSafety(
      cleanReport({
        topHolders: [
          { address: "Whale", pct: 22, insider: true },
          { address: "B", pct: 9, insider: false },
        ],
      }),
      safetyCfg,
    );
    assert.equal(r.pass, false);
    const text = r.reasons.join("; ");
    assert.match(text, /top 10 holders own 31%/);
    assert.match(text, /one wallet owns 22%/);
    assert.match(text, /insiders own 22%/);
  });

  it("fails on unlocked liquidity and RugCheck danger flags", () => {
    const r = evaluateSafety(
      cleanReport({
        markets: [{ pubkey: "P", liquidityA: POOL_VAULT, lp: { lpLockedPct: 0 } }],
        risks: [{ name: "Large Amount of LP Unlocked", level: "danger" }],
      }),
      safetyCfg,
    );
    assert.equal(r.pass, false);
    assert.match(r.reasons.join("; "), /liquidity locked/);
    assert.match(r.reasons.join("; "), /danger/);
  });

  it("treats missing data as a fail only in strict mode", () => {
    const report = cleanReport({ topHolders: null, markets: null });
    assert.equal(evaluateSafety(report, safetyCfg).pass, false);
    assert.equal(evaluateSafety(report, { ...safetyCfg, strictUnknown: false }).pass, true);
  });
});
