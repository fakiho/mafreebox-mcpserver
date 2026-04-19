import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { SyncState, SyncStateEntry } from "./types.js";

export class StateStore {
  private path: string;
  private state: SyncState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): SyncState {
    if (!existsSync(this.path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return typeof raw === "object" && raw !== null ? (raw as SyncState) : {};
    } catch {
      return {};
    }
  }

  save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  get(mac: string): SyncStateEntry | undefined {
    return this.state[mac];
  }

  upsert(entry: SyncStateEntry): void {
    this.state[entry.mac] = entry;
  }

  remove(mac: string): void {
    delete this.state[mac];
  }

  all(): SyncStateEntry[] {
    return Object.values(this.state);
  }

  macs(): string[] {
    return Object.keys(this.state);
  }
}
