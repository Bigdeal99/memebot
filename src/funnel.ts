/** Counts where coins drop out of the pipeline, so we can see which rule is the bottleneck. */
export interface Funnel {
  since: number;
  checks: number;
  tooYoung: number;
  tooOldOrBig: number;
  failedBasics: number;
  weakMomentum: number;
  failedSafety: number;
  askedGrok: number;
  bought: number;
  basicsReasons: Record<string, number>;
  safetyReasons: Record<string, number>;
}

export function newFunnel(now = Date.now()): Funnel {
  return {
    since: now,
    checks: 0,
    tooYoung: 0,
    tooOldOrBig: 0,
    failedBasics: 0,
    weakMomentum: 0,
    failedSafety: 0,
    askedGrok: 0,
    bought: 0,
    basicsReasons: {},
    safetyReasons: {},
  };
}

/** "liquidity $5123 too low" -> "liquidity # too low", so the same rule is counted together. */
export function reasonKey(reason: string): string {
  return reason.replace(/-?\$?\d[\d.,]*%?/g, "#").replace(/\s+/g, " ").trim();
}

export function countReasons(into: Record<string, number>, reasons: string[]): void {
  for (const r of reasons) {
    const key = reasonKey(r);
    into[key] = (into[key] ?? 0) + 1;
  }
}

export function topReasons(reasons: Record<string, number>, n = 3): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([r, c]) => `${r} (${c})`)
    .join(", ");
}
