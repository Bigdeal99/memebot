import type { SafetyConfig } from "./config.js";
import type { RugHolder, RugReport } from "./sources/rugcheck.js";
import type { SafetyResult } from "./types.js";

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Pool vaults show up as "top holders" but are not people. We drop any holder whose address or owner
 * appears anywhere in the market data RugCheck returned for the token.
 */
export function realHolders(report: RugReport): RugHolder[] {
  const marketText = JSON.stringify(report.markets ?? []);
  return (report.topHolders ?? []).filter((h) => {
    const isPool =
      (h.address !== "" && marketText.includes(h.address)) || (!!h.owner && marketText.includes(h.owner));
    return !isPool;
  });
}

function lpLockedPct(report: RugReport): number | undefined {
  const fromMarkets = (report.markets ?? [])
    .map((m) => m.lp?.lpLockedPct)
    .filter((v): v is number => typeof v === "number");
  if (fromMarkets.length > 0) return Math.max(...fromMarkets);
  return typeof report.lpLockedPct === "number" ? report.lpLockedPct : undefined;
}

/** Hard safety rules. Any single failure means we never buy the token. */
export function evaluateSafety(report: RugReport | null, cfg: SafetyConfig): SafetyResult {
  if (!report) return { pass: false, retryable: true, reasons: ["no RugCheck report yet"], metrics: {} };

  const reasons: string[] = [];

  if (report.rugged) reasons.push("RugCheck marks it as rugged");
  if (report.mintAuthority) reasons.push("mint authority enabled: dev can print new tokens");
  if (report.freezeAuthority) reasons.push("freeze authority enabled: dev can freeze your tokens");

  const dangers = (report.risks ?? []).filter((r) => r.level === "danger");
  if (cfg.failOnDanger && dangers.length > 0) {
    reasons.push(`RugCheck danger: ${dangers.map((d) => d.name).join(", ")}`);
  }

  const riskScore = report.score_normalised;
  if (typeof riskScore === "number" && riskScore > cfg.maxRiskScore) {
    reasons.push(`RugCheck risk score ${riskScore} > ${cfg.maxRiskScore}`);
  }

  const holders = realHolders(report)
    .filter((h) => typeof h.pct === "number")
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  let top10Pct: number | undefined;
  let topHolderPct: number | undefined;
  let insiderPct: number | undefined;
  if (holders.length > 0) {
    top10Pct = round(holders.slice(0, 10).reduce((sum, h) => sum + (h.pct ?? 0), 0));
    topHolderPct = round(holders[0]?.pct ?? 0);
    insiderPct = round(holders.filter((h) => h.insider).reduce((sum, h) => sum + (h.pct ?? 0), 0));
    if (top10Pct > cfg.maxTop10Pct) reasons.push(`top 10 holders own ${top10Pct}% (max ${cfg.maxTop10Pct}%)`);
    if (topHolderPct > cfg.maxSingleHolderPct) {
      reasons.push(`one wallet owns ${topHolderPct}% (max ${cfg.maxSingleHolderPct}%)`);
    }
    if (insiderPct > cfg.maxInsiderPct) reasons.push(`insiders own ${insiderPct}% (max ${cfg.maxInsiderPct}%)`);
  } else if (cfg.strictUnknown) {
    reasons.push("holder data missing");
  }

  const lp = lpLockedPct(report);
  if (lp === undefined) {
    if (cfg.strictUnknown) reasons.push("LP lock status unknown");
  } else if (lp < cfg.minLpLockedPct) {
    reasons.push(`only ${round(lp)}% of liquidity locked/burned (min ${cfg.minLpLockedPct}%)`);
  }

  return {
    pass: reasons.length === 0,
    retryable: false,
    reasons,
    metrics: {
      top10Pct,
      topHolderPct,
      insiderPct,
      riskScore,
      lpLockedPct: lp === undefined ? undefined : round(lp),
      insidersDetected: report.graphInsidersDetected,
    },
  };
}
