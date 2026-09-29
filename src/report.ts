import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { Store } from "./store.js";
import type { ClosedTrade } from "./types.js";

export interface StrategyStats {
  strategy: string;
  trades: number;
  winRatePct: number;
  pnlUsd: number;
  avgWinUsd: number;
  avgLossUsd: number;
  /** Average profit per trade. Positive = the strategy has an edge (so far). */
  expectancyUsd: number;
  maxDrawdownUsd: number;
  bestPct: number;
  worstPct: number;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function strategyStats(strategy: string, trades: ClosedTrade[]): StrategyStats {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = sorted.filter((t) => t.pnlUsd > 0);
  const losses = sorted.filter((t) => t.pnlUsd <= 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const t of sorted) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  return {
    strategy,
    trades: sorted.length,
    winRatePct: sorted.length ? (wins.length / sorted.length) * 100 : 0,
    pnlUsd: equity,
    avgWinUsd: avg(wins.map((t) => t.pnlUsd)),
    avgLossUsd: avg(losses.map((t) => t.pnlUsd)),
    expectancyUsd: sorted.length ? equity / sorted.length : 0,
    maxDrawdownUsd,
    bestPct: sorted.length ? Math.max(...sorted.map((t) => t.pnlPct)) : 0,
    worstPct: sorted.length ? Math.min(...sorted.map((t) => t.pnlPct)) : 0,
  };
}

/** Which entry features separate winners from losers. This is how the bot "learns" what to tune. */
export function featureComparison(trades: ClosedTrade[]): { feature: string; winners: number; losers: number }[] {
  const features: Record<string, (t: ClosedTrade) => number | undefined> = {
    momentum: (t) => t.features.momentum,
    buyRatioH1: (t) => t.features.signals.buyRatioH1,
    acceleration: (t) => t.features.signals.acceleration,
    volumeToLiquidityH1: (t) => t.features.signals.volumeToLiquidityH1,
    changeH1Pct: (t) => t.features.signals.changeH1Pct,
    liquidityUsd: (t) => t.features.signals.liquidityUsd,
    marketCapUsd: (t) => t.features.signals.marketCapUsd,
    ageMin: (t) => t.features.signals.ageMin,
    top10Pct: (t) => t.features.safety.top10Pct,
    aiHype: (t) => t.features.ai?.hype,
    aiOrganic: (t) => t.features.ai?.organic,
  };
  const winners = trades.filter((t) => t.pnlUsd > 0);
  const losers = trades.filter((t) => t.pnlUsd <= 0);
  const values = (ts: ClosedTrade[], f: (t: ClosedTrade) => number | undefined): number[] =>
    ts.map(f).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return Object.entries(features).map(([feature, f]) => ({
    feature,
    winners: median(values(winners, f)),
    losers: median(values(losers, f)),
  }));
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function main(): void {
  const trades = new Store(config.dataDir).readAll<ClosedTrade>("trades.jsonl");
  if (trades.length === 0) {
    console.log("No closed paper trades yet. Let the bot run for a while (hours to days).");
    return;
  }

  const byStrategy = Map.groupBy(trades, (t) => t.strategy);
  console.log(`\n=== Strategy tournament (${trades.length} closed paper trades) ===`);
  console.table(
    [...byStrategy].map(([name, ts]) => {
      const s = strategyStats(name, ts);
      return {
        strategy: s.strategy,
        trades: s.trades,
        "win %": fmt(s.winRatePct, 1),
        "PnL $": fmt(s.pnlUsd),
        "avg win $": fmt(s.avgWinUsd),
        "avg loss $": fmt(s.avgLossUsd),
        "per trade $": fmt(s.expectancyUsd),
        "max DD $": fmt(s.maxDrawdownUsd),
        "best %": fmt(s.bestPct, 0),
        "worst %": fmt(s.worstPct, 0),
      };
    }),
  );

  const ai = byStrategy.get("hype_momentum");
  const base = byStrategy.get("baseline");
  if (ai && base) {
    const diff = strategyStats("ai", ai).expectancyUsd - strategyStats("base", base).expectancyUsd;
    console.log(
      `AI check: hype_momentum earns ${fmt(diff)} $/trade ${diff >= 0 ? "MORE" : "LESS"} than baseline ` +
        `(${ai.length} vs ${base.length} trades). Trust this only after 50+ trades each.`,
    );
  }

  console.log("\n=== Exit reasons ===");
  console.table(
    [...Map.groupBy(trades, (t) => t.exitReason.replace(/-?\d+(\.\d+)?%?/g, "#"))].map(([reason, ts]) => ({
      reason,
      count: ts.length,
      "avg PnL %": fmt(avg(ts.map((t) => t.pnlPct)), 1),
    })),
  );

  console.log("\n=== What winners had vs losers (median at entry) ===");
  console.table(featureComparison(trades).map((r) => ({ ...r, winners: fmt(r.winners), losers: fmt(r.losers) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
