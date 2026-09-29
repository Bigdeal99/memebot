import type { Logger } from "../types.js";

const URL = "wss://pumpportal.fun/api/data";

/**
 * Listens for Pump.fun "graduations": tokens that filled their bonding curve and moved to a real AMM pool.
 * Only these are interesting to us; brand-new launches are mostly rugs and are the domain of sniper bots.
 * PumpPortal asks clients to keep ONE connection and add subscriptions to it.
 */
export class PumpPortalFeed {
  private ws: WebSocket | undefined;
  private stopped = false;
  private retryMs = 2_000;

  constructor(
    private readonly onMigration: (mint: string) => void,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retryMs = 2_000;
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      this.log.info("PumpPortal connected, listening for migrations");
    });

    ws.addEventListener("message", (event) => {
      const msg = parse(String(event.data));
      if (msg && typeof msg.mint === "string") this.onMigration(msg.mint);
    });

    ws.addEventListener("close", () => {
      if (this.stopped) return;
      this.log.warn(`PumpPortal disconnected, reconnecting in ${this.retryMs / 1000}s`);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
    });

    // An "error" event is always followed by "close", which handles reconnecting.
    ws.addEventListener("error", () => undefined);
  }
}

function parse(data: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
