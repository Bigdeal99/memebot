import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReasons, reasonKey, topReasons } from "../src/funnel.js";
import { mintFromTokenId, parseTrending } from "../src/sources/geckoterminal.js";

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("GeckoTerminal trending", () => {
  it("extracts Solana mints from token relationship ids", () => {
    assert.equal(mintFromTokenId(`solana_${MINT}`), MINT);
    assert.equal(mintFromTokenId(`eth_0xabc`), undefined);
    assert.equal(mintFromTokenId(undefined), undefined);
  });

  it("parses a trending_pools response", () => {
    const body = {
      data: [
        { relationships: { base_token: { data: { id: `solana_${MINT}` } } } },
        { relationships: {} },
      ],
    };
    assert.deepEqual(parseTrending(body), [MINT]);
    assert.deepEqual(parseTrending(null), []);
  });
});

describe("funnel reasons", () => {
  it("groups the same rule regardless of the numbers in it", () => {
    assert.equal(reasonKey("liquidity $5123 too low"), "liquidity # too low");
    const counts: Record<string, number> = {};
    countReasons(counts, ["liquidity $5123 too low", "liquidity $900 too low", "62 txns/h too few"]);
    assert.deepEqual(counts, { "liquidity # too low": 2, "# txns/h too few": 1 });
    assert.equal(topReasons(counts, 1), "liquidity # too low (2)");
  });
});
