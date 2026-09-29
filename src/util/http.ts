import { setTimeout as sleep } from "node:timers/promises";

/** Spaces requests out evenly so we stay under a per-minute limit. */
export class RateLimiter {
  private nextAt = 0;

  constructor(private readonly perMinute: number) {}

  async take(): Promise<void> {
    const interval = 60_000 / this.perMinute;
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + interval;
    if (at > now) await sleep(at - now);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  limiter?: RateLimiter;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T | null> {
  const retries = opts.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    await opts.limiter?.take();

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      lastError = err; // network error or timeout: retry
      continue;
    }

    if (res.ok) return (await res.json()) as T;
    if (res.status === 404 && opts.allow404) return null;

    const error = new HttpError(res.status, url, await res.text().catch(() => ""));
    if (!isRetryable(res.status)) throw error;
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}
