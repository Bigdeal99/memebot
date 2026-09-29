import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name).toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export interface FilterConfig {
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  maxAgeHours: number;
  minTxnsH1: number;
  minVolumeH1Usd: number;
}

export interface SafetyConfig {
  maxTop10Pct: number;
  maxSingleHolderPct: number;
  maxInsiderPct: number;
  maxRiskScore: number;
  minLpLockedPct: number;
  failOnDanger: boolean;
  /** When RugCheck is missing a field (holders, LP lock), treat it as a fail. */
  strictUnknown: boolean;
}

export interface AiConfig {
  apiKey: string;
  model: string;
  maxCallsPerDay: number;
  minMomentumForAi: number;
  cacheMin: number;
}

export const config = {
  mode: str("MODE", "paper"),
  dataDir: str("DATA_DIR", "data"),

  discoveryEverySec: num("DISCOVERY_EVERY_SEC", 60),
  evaluateEverySec: num("EVALUATE_EVERY_SEC", 10),
  monitorEverySec: num("MONITOR_EVERY_SEC", 15),
  summaryEveryMin: num("SUMMARY_EVERY_MIN", 60),
  recheckAfterMin: num("RECHECK_AFTER_MIN", 5),
  maxChecksPerToken: num("MAX_CHECKS_PER_TOKEN", 12),
  migrationDelayMin: num("MIGRATION_DELAY_MIN", 3),
  usePumpPortal: bool("USE_PUMPPORTAL", true),

  paper: {
    bankrollUsd: num("PAPER_BANKROLL_USD", 1000),
    positionUsd: num("POSITION_USD", 25),
    frictionPctPerSide: num("FRICTION_PCT_PER_SIDE", 1.0),
  },

  filters: {
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15_000),
    minMarketCapUsd: num("MIN_MCAP_USD", 30_000),
    maxMarketCapUsd: num("MAX_MCAP_USD", 3_000_000),
    maxAgeHours: num("MAX_AGE_HOURS", 48),
    minTxnsH1: num("MIN_TXNS_H1", 150),
    minVolumeH1Usd: num("MIN_VOLUME_H1_USD", 10_000),
  } satisfies FilterConfig,

  safety: {
    maxTop10Pct: num("MAX_TOP10_PCT", 30),
    maxSingleHolderPct: num("MAX_SINGLE_HOLDER_PCT", 10),
    maxInsiderPct: num("MAX_INSIDER_PCT", 10),
    maxRiskScore: num("MAX_RUGCHECK_SCORE", 50),
    minLpLockedPct: num("MIN_LP_LOCKED_PCT", 80),
    failOnDanger: bool("FAIL_ON_DANGER", true),
    strictUnknown: bool("STRICT_UNKNOWN", true),
  } satisfies SafetyConfig,

  ai: {
    apiKey: str("XAI_API_KEY"),
    model: str("XAI_MODEL", "grok-4-1-fast-reasoning"),
    maxCallsPerDay: num("AI_MAX_CALLS_PER_DAY", 20),
    minMomentumForAi: num("AI_MIN_MOMENTUM", 55),
    cacheMin: num("AI_CACHE_MIN", 30),
  } satisfies AiConfig,

  telegram: {
    botToken: str("TELEGRAM_BOT_TOKEN"),
    chatId: str("TELEGRAM_CHAT_ID"),
  },
};

export type Config = typeof config;
