import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import type { BookState } from "./paper/book.js";
import { Store } from "./store.js";
import { defaultStrategies } from "./strategies.js";
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

export interface WalletLine {
  strategy: string;
  startUsd: number;
  nowUsd: number;
  profitUsd: number;
  profitPct: number;
  closedTrades: number;
  wins: number;
  losses: number;
  openTrades: number;
}

/** Plain "started with $X, now worth $Y" per strategy. Open trades are valued at their last seen price. */
export function walletSummary(
  strategies: string[],
  startUsd: number,
  state: BookState | null,
  trades: ClosedTrade[],
): WalletLine[] {
  return strategies.map((strategy) => {
    const open = (state?.positions ?? []).filter((p) => p.strategy === strategy);
    const openValue = open.reduce((sum, p) => sum + p.remainingTokens * p.lastPriceUsd, 0);
    const nowUsd = (state?.cash[strategy] ?? startUsd) + openValue;
    const closed = trades.filter((t) => t.strategy === strategy);
    return {
      strategy,
      startUsd,
      nowUsd,
      profitUsd: nowUsd - startUsd,
      profitPct: startUsd > 0 ? ((nowUsd - startUsd) / startUsd) * 100 : 0,
      closedTrades: closed.length,
      wins: closed.filter((t) => t.pnlUsd > 0).length,
      losses: closed.filter((t) => t.pnlUsd <= 0).length,
      openTrades: open.length,
    };
  });
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function printWallets(lines: WalletLine[]): void {
  console.log(`\n=== Your fake money: each strategy started with ${money(lines[0]?.startUsd ?? 0)} ===`);
  console.table(
    lines.map((l) => ({
      strategy: l.strategy,
      "started with": money(l.startUsd),
      "worth now": money(l.nowUsd),
      "profit / loss": `${l.profitUsd >= 0 ? "+" : ""}${money(l.profitUsd)} (${l.profitPct >= 0 ? "+" : ""}${l.profitPct.toFixed(1)}%)`,
      "trades done": l.closedTrades,
      won: l.wins,
      lost: l.losses,
      "still open": l.openTrades,
    })),
  );
  const best = [...lines].sort((a, b) => b.profitUsd - a.profitUsd)[0];
  const done = lines.reduce((sum, l) => sum + l.closedTrades, 0);
  if (best && done > 0) {
    console.log(`Best so far: ${best.strategy} (${best.profitUsd >= 0 ? "+" : ""}${money(best.profitUsd)}).`);
  }
  console.log(
    done < 50 * lines.length
      ? `Only ${done} trades finished so far. Results are mostly luck until each strategy has about 50.`
      : "Enough trades to start trusting these numbers.",
  );
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function main(): void {
  const store = new Store(config.dataDir);
  const trades = store.readAll<ClosedTrade>("trades.jsonl");
  const names = defaultStrategies(config.paper.positionUsd).map((s) => s.name);
  printWallets(walletSummary(names, config.paper.bankrollUsd, store.loadJson<BookState>("state.json"), trades));
  if (trades.length === 0) return;

  console.log("\n\n----- Details for tuning the bot (you can skip everything below) -----");
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
