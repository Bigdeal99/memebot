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

export interface BasketRound {
  round: number;
  startEquityUsd: number;
  startedAt: number;
}

export interface BookState {
  cash: Record<string, number>;
  positions: Position[];
  daily: Record<string, { day: string; pnlUsd: number }>;
  lastClosed: Record<string, number>;
  rounds?: Record<string, BasketRound>;
}

export interface RoundEvent {
  strategy: string;
  reason: "target" | "floor" | "time";
  round: number;
  equityUsd: number;
  startEquityUsd: number;
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
    this.state.rounds ??= {};
    for (const s of strategies) {
      if (s.basket) this.state.rounds[s.name] ??= { round: 1, startEquityUsd: this.cashOf(s.name), startedAt: Date.now() };
    }
  }

  roundOf(strategy: string): BasketRound | undefined {
    return this.state.rounds?.[strategy];
  }

  /** Cash plus open positions at their last seen price. */
  equity(strategy: string): number {
    return this.state.positions
      .filter((p) => p.strategy === strategy)
      .reduce((sum, p) => sum + p.remainingTokens * p.lastPriceUsd, this.cashOf(strategy));
  }

  /** Basket strategies split the round's starting money into equal slices; others use a fixed size. */
  positionSize(st: StrategyParams): number {
    const round = this.roundOf(st.name);
    return st.basket && round ? round.startEquityUsd / st.basket.slots : st.positionUsd;
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
    const maxOpen = st.basket?.slots ?? st.maxOpen;
    if (mine.length >= maxOpen) return `max ${maxOpen} open positions`;
    if (this.cashOf(st.name) < this.positionSize(st) - 1e-9) return "not enough cash";
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

    const size = this.positionSize(st);
    const friction = this.opts.frictionPctPerSide / 100;
    const effectiveEntryUsd = priceUsd * (1 + friction + priceImpact(size, liquidityUsd));
    const tokens = size / effectiveEntryUsd;

    const pos: Position = {
      id: randomUUID(),
      strategy: st.name,
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      openedAt: now,
      entryPriceUsd: priceUsd,
      effectiveEntryUsd,
      costUsd: size,
      tokens,
      remainingTokens: tokens,
      proceedsUsd: 0,
      peakPriceUsd: priceUsd,
      lastPriceUsd: priceUsd,
      lastLiquidityUsd: liquidityUsd,
      takeProfitsHit: [],
      exits: [],
      features,
    };
    this.state.cash[st.name] = this.cashOf(st.name) - size;
    this.state.positions.push(pos);
    return pos;
  }

  /** Feeds a new price for a token to every position holding it and executes exits. */
  onPrice(mint: string, priceUsd: number, liquidityUsd: number, now = Date.now()): BookEvent[] {
    const events: BookEvent[] = [];
    for (const pos of this.state.positions.filter((p) => p.mint === mint)) {
      const st = this.strategy(pos.strategy);
      pos.lastPriceUsd = priceUsd;
      pos.lastLiquidityUsd = liquidityUsd;
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

  /**
   * Closes every coin of a basket strategy when the whole basket reaches its target, its floor or its time
   * limit, then starts the next round with everything the basket is worth.
   */
  checkBaskets(now = Date.now()): { events: BookEvent[]; rounds: RoundEvent[] } {
    const events: BookEvent[] = [];
    const rounds: RoundEvent[] = [];
    for (const st of this.strategies.values()) {
      const round = this.roundOf(st.name);
      if (!st.basket || !round) continue;
      const open = this.state.positions.filter((p) => p.strategy === st.name);
      const equity = this.equity(st.name);
      const expired = now - round.startedAt >= st.basket.maxRoundMin * 60_000;
      const reason: RoundEvent["reason"] | null =
        equity >= round.startEquityUsd * st.basket.targetMultiple
          ? "target"
          : equity <= round.startEquityUsd * st.basket.stopMultiple
            ? "floor"
            : expired
              ? "time"
              : null;
      if (!reason) continue;
      if (open.length === 0) {
        round.startedAt = now; // nothing to close: just restart the clock
        continue;
      }
      for (const pos of open) {
        const why = `basket ${reason}`;
        const fill = this.sell(pos, pos.remainingTokens, pos.lastPriceUsd, pos.lastLiquidityUsd ?? 0, why, now);
        events.push({ type: "closed", position: pos, fill, trade: this.close(pos, why, now) });
      }
      rounds.push({ strategy: st.name, reason, round: round.round, equityUsd: this.cashOf(st.name), startEquityUsd: round.startEquityUsd });
      this.state.rounds![st.name] = { round: round.round + 1, startEquityUsd: this.cashOf(st.name), startedAt: now };
    }
    return { events, rounds };
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
