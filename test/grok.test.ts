import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractText, parseVerdict } from "../src/ai/grok.js";

describe("extractText", () => {
  it("reads output_text when present", () => {
    assert.equal(extractText({ output_text: "hi" }), "hi");
  });

  it("collects message text and skips tool-call items", () => {
    const text = extractText({
      output: [
        { type: "x_search_call" },
        { type: "message", content: [{ type: "output_text", text: '{"hype": 6}' }] },
      ],
    });
    assert.equal(text, '{"hype": 6}');
  });
});

describe("parseVerdict", () => {
  it("parses JSON wrapped in a code fence with extra words", () => {
    const v = parseVerdict(
      'Here you go:\n```json\n{"hype": 7, "organic": 6.5, "mentions": "~300 posts, rising", "narrative": "cat meme", ' +
        '"red_flags": [], "verdict": "BUY", "reason": "many independent accounts"}\n```',
    );
    assert.deepEqual(v, {
      hype: 7,
      organic: 6.5,
      mentions: "~300 posts, rising",
      narrative: "cat meme",
      redFlags: [],
      verdict: "buy",
      reason: "many independent accounts",
    });
  });

  it("clamps scores and falls back to avoid on an unknown verdict", () => {
    const v = parseVerdict('{"hype": 42, "organic": -3, "verdict": "moon"}');
    assert.equal(v?.hype, 10);
    assert.equal(v?.organic, 0);
    assert.equal(v?.verdict, "avoid");
  });

  it("returns null for non-JSON answers", () => {
    assert.equal(parseVerdict("I could not find anything."), null);
    assert.equal(parseVerdict("{not json}"), null);
  });
});
