import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * One JSON file per room, written atomically (temp file + rename).
 * ponytail: whole-file writes, fine for LAN scale (≤16 players, few KB/room).
 * Swap for SQLite if rooms ever get large histories.
 */
export class JsonStore<T extends { id: string }> {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  loadAll(): T[] {
    const out: T[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T);
      } catch {
        // skip corrupt file rather than take the server down
      }
    }
    return out;
  }

  save(data: T): void {
    const target = this.path(data.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, target);
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}
