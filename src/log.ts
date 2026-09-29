import type { Logger } from "./types.js";

function line(level: string, msg: string): string {
  return `${new Date().toISOString()} ${level} ${msg}`;
}

export const consoleLogger: Logger = {
  info: (msg) => console.log(line("INFO ", msg)),
  warn: (msg) => console.warn(line("WARN ", msg)),
  error: (msg) => console.error(line("ERROR", msg)),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
