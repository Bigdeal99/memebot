import type { Config } from "./config.js";
import { GrokAnalyst } from "./ai/grok.js";
import { countReasons, type Funnel, newFunnel } from "./funnel.js";
import { errorMessage } from "./log.js";
import { Telegram } from "./notify/telegram.js";
import { type BookEvent, type BookState, PaperBook } from "./paper/book.js";
import { evaluateSafety } from "./safety.js";
import { computeSignals, momentumScore, prefilter } from "./signals.js";
import { discoverSolanaTokens, getBestPairs } from "./sources/dexscreener.js";
import { discoverTrending } from "./sources/geckoterminal.js";
import { PumpPortalFeed } from "./sources/pumpportal.js";
import { getRugReport } from "./sources/rugcheck.js";
import { type Store } from "./store.js";
import { shouldEnter } from "./strategies.js";
import type { DexPair, HypeVerdict, Logger, StrategyParams, TokenRef } from "./types.js";

interface Watch {
  mint: string;
  source: string;
  firstSeen: number;
  nextCheckAt: number;
  checks: number;
}

const STATE_FILE = "state.json";
const FUNNEL_FILE = "funnel.json";
const EVALUATE_BATCH = 30;
/** How long a dropped token is ignored before discovery may add it again. */
const IGNORE_DROPPED_MS = 6 * 60 * 60_000;

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export class Bot {
  private readonly watch = new Map<string, Watch>();
  private readonly ignoredUntil = new Map<string, number>();
  private readonly book: PaperBook;
  private readonly grok: GrokAnalyst;
  private readonly telegram: Telegram;
  private readonly pump: PumpPortalFeed;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private readonly minMomentum: number;
  private readonly funnel: Funnel;

  constructor(
    private readonly cfg: Config,
    private readonly strategies: StrategyParams[],
    private readonly store: Store,
    private readonly log: Logger,
  ) {
    this.book = new PaperBook(strategies, cfg.paper, store.loadJson<BookState>(STATE_FILE));
    this.grok = new GrokAnalyst(cfg.ai, log);
    this.telegram = new Telegram(cfg.telegram.botToken, cfg.telegram.chatId, log);
    this.pump = new PumpPortalFeed((mint) => this.add(mint, "pump-migration", cfg.migrationDelayMin), log);
    this.minMomentum = Math.min(...strategies.map((s) => s.minMomentum));
    this.funnel = store.loadJson<Funnel>(FUNNEL_FILE) ?? newFunnel();
  }

  start(): void {
    this.log.info(
      `memebot started in ${this.cfg.mode.toUpperCase()} mode | strategies: ${this.strategies.map((s) => s.name).join(", ")} | ` +
        `AI: ${this.grok.enabled ? this.cfg.ai.model : "off (no XAI_API_KEY)"} | Telegram: ${this.telegram.enabled ? "on" : "off"}`,
    );
    if (this.book.positions.length > 0) this.log.info(`Resumed ${this.book.positions.length} open paper positions`);
    if (this.cfg.usePumpPortal) this.pump.start();

    this.every(this.cfg.discoveryEverySec, "discover", () => this.discover());
    this.every(this.cfg.evaluateEverySec, "evaluate", () => this.evaluateDue());
    this.every(this.cfg.monitorEverySec, "monitor", () => this.monitor());
    this.every(this.cfg.summaryEveryMin * 60, "summary", () => this.summary(), false);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.pump.stop();
    this.store.saveJson(STATE_FILE, this.book.snapshot());
    this.store.saveJson(FUNNEL_FILE, this.funnel);
    this.log.info("Stopped, state saved");
  }

  /** Runs `fn` every `sec` seconds without overlapping runs; one failing run never kills the loop. */
  private every(sec: number, name: string, fn: () => Promise<void>, runNow = true): void {
    const run = async (): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        this.log.error(`${name} failed: ${errorMessage(err)}`);
      }
      if (!this.stopped) this.timers.set(name, setTimeout(run, sec * 1000));
    };
    this.timers.set(name, setTimeout(run, runNow ? 0 : sec * 1000));
  }

  private add(mint: string, source: string, delayMin = 0): void {
    const now = Date.now();
    if (this.watch.has(mint) || (this.ignoredUntil.get(mint) ?? 0) > now) return;
    this.watch.set(mint, { mint, source, firstSeen: now, nextCheckAt: now + delayMin * 60_000, checks: 0 });
  }

  private drop(mint: string, now: number): void {
    this.watch.delete(mint);
    this.ignoredUntil.set(mint, now + IGNORE_DROPPED_MS);
  }

  private async discover(): Promise<void> {
    const now = Date.now();
    for (const [mint, until] of this.ignoredUntil) if (until <= now) this.ignoredUntil.delete(mint);

    const before = this.watch.size;
    const results = await Promise.allSettled([discoverSolanaTokens(), discoverTrending()]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === results.length) throw failed[0]?.reason;
    for (const f of failed) this.log.warn(`One discovery source failed: ${errorMessage(f.reason)}`);
    for (const r of results) if (r.status === "fulfilled") for (const d of r.value) this.add(d.mint, d.source);
    const added = this.watch.size - before;
    if (added > 0) this.log.info(`Discovered ${added} new tokens (watching ${this.watch.size})`);
  }

  private reschedule(w: Watch, now: number): void {
    if (w.checks >= this.cfg.maxChecksPerToken) return this.drop(w.mint, now);
    w.nextCheckAt = now + this.cfg.recheckAfterMin * 60_000;
  }

  private async evaluateDue(): Promise<void> {
    const now = Date.now();
    const due = [...this.watch.values()].filter((w) => w.nextCheckAt <= now).slice(0, EVALUATE_BATCH);
    if (due.length === 0) return;

    const pairs = await getBestPairs(due.map((w) => w.mint));
    for (const w of due) {
      try {
        await this.evaluate(w, pairs.get(w.mint), Date.now());
      } catch (err) {
        this.log.warn(`Evaluating ${w.mint} failed: ${errorMessage(err)}`);
        this.reschedule(w, Date.now());
      }
    }
    this.store.saveJson(FUNNEL_FILE, this.funnel);
  }

  private async evaluate(w: Watch, pair: DexPair | undefined, now: number): Promise<void> {
    w.checks++;
    if (!pair) return this.reschedule(w, now);

    const token: TokenRef = { mint: w.mint, symbol: pair.baseToken.symbol, name: pair.baseToken.name };
    const signals = computeSignals(pair, now);
    const pre = prefilter(signals, this.cfg.filters);
    this.funnel.checks++;
    if (!pre.pass) {
      if (pre.permanent) {
        this.funnel.tooOldOrBig++;
        this.drop(w.mint, now);
      } else if (pre.waitMin !== undefined) {
        this.funnel.tooYoung++;
        // Too young: come back when it is old enough, without using up one of its checks.
        w.checks--;
        w.nextCheckAt = now + pre.waitMin * 60_000;
      } else {
        this.funnel.failedBasics++;
        countReasons(this.funnel.basicsReasons, pre.reasons);
        this.reschedule(w, now);
      }
      return;
    }

    const momentum = momentumScore(signals);
    if (momentum.score < this.minMomentum) {
      this.funnel.weakMomentum++;
      return this.reschedule(w, now);
    }

    // Only tokens that already look strong cost us a RugCheck call.
    const safety = evaluateSafety(await getRugReport(w.mint, now), this.cfg.safety);
    const decision = { at: now, mint: w.mint, symbol: token.symbol, source: w.source, momentum: momentum.score };
    if (!safety.pass) {
      this.funnel.failedSafety++;
      countReasons(this.funnel.safetyReasons, safety.reasons);
      this.store.append("decisions.jsonl", { ...decision, stage: "safety", reasons: safety.reasons });
      if (safety.retryable) this.reschedule(w, now);
      else this.drop(w.mint, now);
      return;
    }

    // The AI is the expensive step: ask only if some AI strategy could actually buy right now.
    let ai: HypeVerdict | null = null;
    const aiCouldBuy = this.strategies.some(
      (s) => s.requireAi && momentum.score >= s.minMomentum && this.book.canEnter(s.name, w.mint, now) === null,
    );
    if (this.grok.enabled && aiCouldBuy && momentum.score >= this.cfg.ai.minMomentumForAi) {
      this.funnel.askedGrok++;
      ai = await this.grok.assess(token, signals, now);
      if (ai) this.log.info(`Grok on ${token.symbol}: ${ai.verdict} hype=${ai.hype} organic=${ai.organic} | ${ai.reason}`);
    }

    const outcomes: Record<string, string> = {};
    let boughtAny = false;
    for (const st of this.strategies) {
      const blocked = this.book.canEnter(st.name, w.mint, now);
      if (blocked) {
        outcomes[st.name] = `skip: ${blocked}`;
        continue;
      }
      const d = shouldEnter(st, momentum.score, ai, this.grok.enabled);
      outcomes[st.name] = d.enter ? `BUY: ${d.reason}` : `skip: ${d.reason}`;
      if (!d.enter) continue;
      boughtAny = true;

      const pos = this.book.enter(
        st.name,
        token,
        signals.priceUsd,
        signals.liquidityUsd,
        { source: w.source, momentum: momentum.score, signals, safety: safety.metrics, ai },
        now,
      );
      const msg =
        `🟢 [${st.name}] PAPER BUY ${token.symbol} ${usd(pos.costUsd)} @ $${signals.priceUsd} | ` +
        `mcap $${Math.round(signals.marketCapUsd)} | ${d.reason}\n${pair.url ?? ""}`;
      this.log.info(msg);
      await this.telegram.send(msg);
    }

    if (boughtAny) this.funnel.bought++;
    this.store.append("decisions.jsonl", {
      ...decision,
      stage: "entry",
      momentumParts: momentum.parts,
      safety: safety.metrics,
      ai,
      outcomes,
    });
    this.store.saveJson(STATE_FILE, this.book.snapshot());
    this.reschedule(w, now);
  }

  private async monitor(): Promise<void> {
    const mints = this.book.openMints();
    if (mints.length === 0) return;

    const pairs = await getBestPairs(mints);
    const now = Date.now();
    let events: BookEvent[] = [];
    for (const mint of mints) {
      const pair = pairs.get(mint);
      if (!pair) continue; // DexScreener hiccup; try again next tick
      const price = Number(pair.priceUsd ?? 0);
      events = events.concat(this.book.onPrice(mint, price, pair.liquidity?.usd ?? 0, now));
    }

    for (const e of events) await this.report(e);
    if (events.length > 0) this.store.saveJson(STATE_FILE, this.book.snapshot());
  }

  private async report(e: BookEvent): Promise<void> {
    const p = e.position;
    if (e.type === "partial") {
      const msg = `🟡 [${p.strategy}] PAPER SELL part of ${p.symbol}: ${e.fill.reason}, got ${usd(e.fill.proceedsUsd)}`;
      this.log.info(msg);
      await this.telegram.send(msg);
      return;
    }
    this.store.append("trades.jsonl", e.trade);
    const icon = e.trade.pnlUsd >= 0 ? "✅" : "🔴";
    const msg =
      `${icon} [${p.strategy}] CLOSED ${p.symbol}: ${e.trade.exitReason} | ` +
      `PnL ${usd(e.trade.pnlUsd)} (${e.trade.pnlPct.toFixed(1)}%) | peak ${e.trade.peakMultiple.toFixed(2)}x`;
    this.log.info(msg);
    await this.telegram.send(msg);
  }

  private async summary(): Promise<void> {
    const lines = this.strategies.map((s) => {
      const open = this.book.positions.filter((p) => p.strategy === s.name);
      const openValue = open.reduce((sum, p) => sum + p.remainingTokens * p.lastPriceUsd, 0);
      const equity = this.book.cashOf(s.name) + openValue;
      return `${s.name}: equity ~${usd(equity)} | open ${open.length} | today ${usd(this.book.todayPnl(s.name))}`;
    });
    const f = this.funnel;
    lines.push(
      `Pipeline: ${f.checks} checks | too young ${f.tooYoung} | failed basics ${f.failedBasics} | weak momentum ${f.weakMomentum} | ` +
        `failed safety ${f.failedSafety} | asked Grok ${f.askedGrok} | bought ${f.bought}`,
    );
    const msg = `📊 Paper summary (AI calls today: ${this.grok.callsUsedToday()}/${this.cfg.ai.maxCallsPerDay})\n${lines.join("\n")}`;
    this.log.info(msg);
    await this.telegram.send(msg);
  }
}
