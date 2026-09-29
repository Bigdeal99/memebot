import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Append-only JSONL journals plus one state file. Plain files so you can open them in any editor. */
export class Store {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  append(file: string, record: unknown): void {
    appendFileSync(join(this.dir, file), `${JSON.stringify(record)}\n`);
  }

  readAll<T>(file: string): T[] {
    const path = join(this.dir, file);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as T);
  }

  saveJson(file: string, value: unknown): void {
    const path = join(this.dir, file);
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${path}.tmp`, path); // atomic: a crash never leaves a half-written state file
  }

  loadJson<T>(file: string): T | null {
    const path = join(this.dir, file);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  }
}
