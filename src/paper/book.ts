import { randomUUID } from "node:crypto";
import type { ClosedTrade, EntryFeatures, ExitFill, Position, StrategyParams, TokenRef } from "../types.js";
import { decideExit } from "./exits.js";

/**
 * Price impact of a market order in a constant-product pool: roughly size / (liquidity / 2).
 * Memecoin pools are thin, so this matters a lot. Paper results that ignore it are lies.
 */
export function priceImpact(sizeUsd: number, liquidityUsd: number): number {
  if (!(liquidityUsd > 0)) return 0.99;
  return Math.min(0.99, sizeUsd / (liquidityUsd / 2));
}

export interface BookState {
  cash: Record<string, number>;
  positions: Position[];
  daily: Record<string, { day: string; pnlUsd: number }>;
  lastClosed: Record<string, number>;
}

export type BookEvent =
  | { type: "partial"; position: Position; fill: ExitFill }
  | { type: "closed"; position: Position; fill: ExitFill; trade: ClosedTrade };

export interface BookOptions {
  bankrollUsd: number;
  frictionPctPerSide: number;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Paper portfolio: one bankroll per strategy, realistic fills (fees + slippage + price impact). */
export class PaperBook {
  private readonly strategies = new Map<string, StrategyParams>();
  private readonly state: BookState;

  constructor(strategies: StrategyParams[], private readonly opts: BookOptions, saved?: BookState | null) {
    for (const s of strategies) this.strategies.set(s.name, s);
    this.state = saved ?? { cash: {}, positions: [], daily: {}, lastClosed: {} };
    for (const s of strategies) this.state.cash[s.name] ??= opts.bankrollUsd;
  }

  snapshot(): BookState {
    return structuredClone(this.state);
  }

  get positions(): readonly Position[] {
    return this.state.positions;
  }

  openMints(): string[] {
    return [...new Set(this.state.positions.map((p) => p.mint))];
  }

  cashOf(strategy: string): number {
    return this.state.cash[strategy] ?? 0;
  }

  todayPnl(strategy: string, now = Date.now()): number {
    const d = this.state.daily[strategy];
    return d && d.day === utcDay(now) ? d.pnlUsd : 0;
  }

  private strategy(name: string): StrategyParams {
    const st = this.strategies.get(name);
    if (!st) throw new Error(`Unknown strategy ${name}`);
    return st;
  }

  /** Returns why the strategy may not enter, or null if it may. */
  canEnter(strategyName: string, mint: string, now = Date.now()): string | null {
    const st = this.strategy(strategyName);
    const mine = this.state.positions.filter((p) => p.strategy === st.name);
    if (mine.some((p) => p.mint === mint)) return "already holding";
    if (mine.length >= st.maxOpen) return `max ${st.maxOpen} open positions`;
    if (this.cashOf(st.name) < st.positionUsd) return "not enough cash";
    if (this.todayPnl(st.name, now) <= -st.dailyLossLimitUsd) return "daily loss limit hit";
    const closedAt = this.state.lastClosed[`${st.name}:${mint}`];
    if (closedAt !== undefined && now - closedAt < st.reentryCooldownMin * 60_000) return "re-entry cooldown";
    return null;
  }

  enter(
    strategyName: string,
    token: TokenRef,
    priceUsd: number,
    liquidityUsd: number,
    features: EntryFeatures,
    now = Date.now(),
  ): Position {
    const st = this.strategy(strategyName);
    const blocked = this.canEnter(st.name, token.mint, now);
    if (blocked) throw new Error(`Cannot enter ${token.symbol} for ${st.name}: ${blocked}`);
    if (!(priceUsd > 0)) throw new Error(`Invalid price for ${token.symbol}`);

    const friction = this.opts.frictionPctPerSide / 100;
    const effectiveEntryUsd = priceUsd * (1 + friction + priceImpact(st.positionUsd, liquidityUsd));
    const tokens = st.positionUsd / effectiveEntryUsd;

    const pos: Position = {
      id: randomUUID(),
      strategy: st.name,
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      openedAt: now,
      entryPriceUsd: priceUsd,
      effectiveEntryUsd,
      costUsd: st.positionUsd,
      tokens,
      remainingTokens: tokens,
      proceedsUsd: 0,
      peakPriceUsd: priceUsd,
      lastPriceUsd: priceUsd,
      takeProfitsHit: [],
      exits: [],
      features,
    };
    this.state.cash[st.name] = this.cashOf(st.name) - st.positionUsd;
    this.state.positions.push(pos);
    return pos;
  }

  /** Feeds a new price for a token to every position holding it and executes exits. */
  onPrice(mint: string, priceUsd: number, liquidityUsd: number, now = Date.now()): BookEvent[] {
    const events: BookEvent[] = [];
    for (const pos of this.state.positions.filter((p) => p.mint === mint)) {
      const st = this.strategy(pos.strategy);
      pos.lastPriceUsd = priceUsd;
      if (priceUsd > pos.peakPriceUsd) pos.peakPriceUsd = priceUsd;

      const decision = decideExit(pos, st, priceUsd, liquidityUsd, now);
      if (decision.kind === "hold") continue;

      const fill = this.sell(pos, decision.tokens, priceUsd, liquidityUsd, decision.reason, now);
      if (decision.takeProfitIndex !== undefined) pos.takeProfitsHit.push(decision.takeProfitIndex);

      if (pos.remainingTokens <= pos.tokens * 1e-9) {
        events.push({ type: "closed", position: pos, fill, trade: this.close(pos, decision.reason, now) });
      } else {
        events.push({ type: "partial", position: pos, fill });
      }
    }
    return events;
  }

  private sell(pos: Position, tokens: number, priceUsd: number, liquidityUsd: number, reason: string, now: number): ExitFill {
    const gross = tokens * priceUsd;
    const friction = this.opts.frictionPctPerSide / 100;
    const proceedsUsd = Math.max(0, gross * (1 - friction - priceImpact(gross, liquidityUsd)));
    const fill: ExitFill = { at: now, reason, tokens, priceUsd, proceedsUsd };
    pos.remainingTokens -= tokens;
    pos.proceedsUsd += proceedsUsd;
    pos.exits.push(fill);
    this.state.cash[pos.strategy] = this.cashOf(pos.strategy) + proceedsUsd;
    return fill;
  }

  private close(pos: Position, reason: string, now: number): ClosedTrade {
    this.state.positions = this.state.positions.filter((p) => p.id !== pos.id);
    this.state.lastClosed[`${pos.strategy}:${pos.mint}`] = now;

    const pnlUsd = pos.proceedsUsd - pos.costUsd;
    const day = utcDay(now);
    const prev = this.state.daily[pos.strategy];
    this.state.daily[pos.strategy] = { day, pnlUsd: (prev && prev.day === day ? prev.pnlUsd : 0) + pnlUsd };

    return {
      ...pos,
      remainingTokens: 0,
      closedAt: now,
      pnlUsd,
      pnlPct: (pnlUsd / pos.costUsd) * 100,
      peakMultiple: pos.peakPriceUsd / pos.entryPriceUsd,
      exitReason: reason,
    };
  }
}
