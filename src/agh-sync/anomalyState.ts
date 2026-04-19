import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { AnomalyStateByMac, AnomalyStateEntry } from "./types.js";

/**
 * Persistent rolling state for anomaly detection:
 * - firstSeenDomains: "first time this MAC queried this domain" — pruned at 7d
 * - hourlyCounts: per-hour query counts for baseline — pruned at 24h
 *
 * File is small (< 1 MB for typical homes), written atomically on save().
 */
export class AnomalyStateStore {
  private path: string;
  private state: AnomalyStateByMac;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): AnomalyStateByMac {
    if (!existsSync(this.path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return typeof raw === "object" && raw !== null ? (raw as AnomalyStateByMac) : {};
    } catch {
      return {};
    }
  }

  save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(this.state));
    try {
      renameSync(this.path + ".tmp", this.path);
    } catch {
      writeFileSync(this.path, JSON.stringify(this.state));
    }
  }

  getOrInit(mac: string): AnomalyStateEntry {
    let e = this.state[mac];
    if (!e) {
      e = { firstSeenDomains: {}, hourlyCounts: {} };
      this.state[mac] = e;
    }
    return e;
  }

  get(mac: string): AnomalyStateEntry | undefined {
    return this.state[mac];
  }

  all(): Array<[string, AnomalyStateEntry]> {
    return Object.entries(this.state);
  }

  /**
   * Prunes firstSeenDomains older than `domainTtlSec` seconds and
   * hourlyCounts whose bucket key is more than `hourBucketTtl` hours old.
   */
  prune(nowSec: number, domainTtlSec = 7 * 86400, hourBucketTtl = 24): void {
    const cutoffDomain = nowSec - domainTtlSec;
    const cutoffBucket = this.hourBucket(nowSec - hourBucketTtl * 3600);
    for (const entry of Object.values(this.state)) {
      for (const [d, ts] of Object.entries(entry.firstSeenDomains)) {
        if (ts < cutoffDomain) delete entry.firstSeenDomains[d];
      }
      for (const b of Object.keys(entry.hourlyCounts)) {
        if (b < cutoffBucket) delete entry.hourlyCounts[b];
      }
    }
  }

  hourBucket(epochSec: number): string {
    const d = new Date(epochSec * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}`;
  }
}
