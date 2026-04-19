import type { AdGuardHomeClient } from "./aghClient.js";
import type { AnomalyStateStore } from "./anomalyState.js";
import type { StateStore } from "./state.js";
import type {
  AghQueryLogItem,
  DeviceAnomaly,
  MetricsSnapshot,
  QueryRecord,
} from "./types.js";

const SCORE_THRESHOLD = 40;

/**
 * Per-device DNS anomaly detector. Four heuristics:
 *
 *   rate_spike      (+40 pts): queries_1h > 3× 24h hourly avg AND > 50 queries/h
 *                              → data exfiltration, DNS tunneling, scanning
 *   nxdomain_high   (+30 pts): nxdomain_rate > 0.3 over last hour, > 30 queries
 *                              → DGA / C2 beaconing
 *   first_seen_flood (+20 pts): > 20 never-before-queried domains in last hour
 *                              → lateral movement, new C2 infra, scanning
 *   threat_hit      (+20 pts): any query matched a filter list (threat intel)
 *                              → direct indicator of known-bad domain lookup
 *
 * Devices with score ≥ 40 are flagged as anomalies.
 * A device can score up to 110 (all four rules firing) — clamped to 100.
 */
export class AnomalyDetector {
  private lastSeenQueryTs = 0;
  private ipToMac = new Map<string, string>();
  private lastAttributionStats = { seen: 0, attributed: 0 };

  constructor(
    private agh: AdGuardHomeClient,
    private state: StateStore,
    private anomalyState: AnomalyStateStore,
    private log: (msg: string) => void,
  ) {}

  private isMac(s: string): boolean {
    return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(s);
  }

  /**
   * Builds the IP→MAC map from two sources, in order of authority:
   *   1. AGH client `ids` — populated by our sync with the device's MAC + IPs.
   *      This is the strongest source because we controlled what went in.
   *   2. Kernel neighbor cache (ARP/NDP) — catches IPs the device rotates to
   *      that aren't in AGH's ids yet (e.g., fresh IPv6 privacy address).
   */
  async updateIpMap(neighIps: Map<string, Set<string>>): Promise<void> {
    this.ipToMac.clear();
    try {
      const resp = await this.agh.listClients();
      for (const c of resp.clients ?? []) {
        const macs = c.ids.filter((id) => this.isMac(id)).map((m) => m.toLowerCase());
        if (macs.length === 0) continue;
        const mac = macs[0];
        for (const id of c.ids) {
          if (this.isMac(id)) continue;
          this.ipToMac.set(id, mac);
        }
      }
    } catch (e) {
      this.log(`[anomaly] listClients failed while building IP map: ${String(e)}`);
    }
    for (const [mac, ips] of neighIps) {
      for (const ip of ips) {
        if (!this.ipToMac.has(ip)) this.ipToMac.set(ip, mac);
      }
    }
  }

  async run(): Promise<MetricsSnapshot> {
    const nowSec = Math.floor(Date.now() / 1000);
    await this.pollRecentQueries(nowSec);
    this.anomalyState.prune(nowSec);

    const managed = this.state.all();
    const anomalies: DeviceAnomaly[] = [];
    let totalQ1h = 0;
    let totalNx1h = 0;
    let totalBlocked24h = 0;

    for (const entry of managed) {
      const a = this.computeForMac(entry.mac, entry.aghName, nowSec);
      totalQ1h += a.queries_1h;
      totalNx1h += Math.round(a.queries_1h * a.nxdomain_rate);
      totalBlocked24h += a.blocked_hits_24h;
      if (a.score >= SCORE_THRESHOLD) anomalies.push(a);
    }
    anomalies.sort((x, y) => y.score - x.score);
    this.anomalyState.save();

    return {
      generatedAt: new Date(nowSec * 1000).toISOString(),
      anomalyThreshold: SCORE_THRESHOLD,
      anomalyCount: anomalies.length,
      anomalies,
      aggregate: {
        totalManagedMacs: managed.length,
        totalQueries_1h: totalQ1h,
        totalBlocked_24h: totalBlocked24h,
        totalNxdomain_1h: totalNx1h,
      },
    };
  }

  /** Paginates AGH's /querylog back to the last record we saw. */
  private async pollRecentQueries(nowSec: number): Promise<void> {
    let olderThan: string | undefined;
    let totalFetched = 0;
    const maxPages = 40; // hard cap — ~20k entries

    // On first run (no lastSeenQueryTs yet), only look back 1 hour to seed.
    const lookbackFloorMs =
      this.lastSeenQueryTs > 0 ? this.lastSeenQueryTs * 1000 : (nowSec - 3600) * 1000;

    let newestSeenMs = this.lastSeenQueryTs * 1000;
    let attributed = 0;

    for (let page = 0; page < maxPages; page++) {
      let resp;
      try {
        resp = await this.agh.getQueryLog({ older_than: olderThan, limit: 500 });
      } catch (e) {
        this.log(`[anomaly] querylog fetch failed: ${String(e)}`);
        return;
      }
      const items = resp.data ?? [];
      if (items.length === 0) break;

      let reachedFloor = false;
      for (const item of items) {
        const rec = this.toRecord(item);
        if (!rec) continue;
        const tsMs = rec.ts * 1000;
        if (tsMs <= lookbackFloorMs) { reachedFloor = true; continue; }
        if (tsMs > newestSeenMs) newestSeenMs = tsMs;
        totalFetched++;
        if (this.recordQuery(rec)) attributed++;
      }
      if (reachedFloor) break;
      olderThan = items[items.length - 1].time;
      if (!olderThan) break;
    }

    if (newestSeenMs > 0) this.lastSeenQueryTs = Math.floor(newestSeenMs / 1000);
    this.lastAttributionStats = { seen: totalFetched, attributed };
    if (totalFetched > 0) {
      const pct = Math.round((attributed / totalFetched) * 100);
      this.log(
        `[anomaly] ingested ${totalFetched} query log entries, attributed ${attributed} to managed MACs (${pct}%), ip-map size=${this.ipToMac.size}`,
      );
    }
  }

  private toRecord(item: AghQueryLogItem): QueryRecord | null {
    if (!item.time || !item.client) return null;
    const tsMs = Date.parse(item.time);
    if (!Number.isFinite(tsMs)) return null;
    const domain = (item.question?.name ?? item.question?.host ?? "").toLowerCase().trim();
    if (!domain) return null;
    const status = (item.status ?? "").toLowerCase();
    const reason = (item.reason ?? "").toLowerCase();
    const blocked =
      reason.startsWith("filtered") ||
      reason.startsWith("blocked") ||
      reason === "rewrite";
    const nxdomain = status === "nxdomain" || status === "nodata";
    return {
      ts: Math.floor(tsMs / 1000),
      clientIp: item.client,
      domain,
      nxdomain,
      blocked,
    };
  }

  private recordQuery(rec: QueryRecord): boolean {
    const mac = this.ipToMac.get(rec.clientIp);
    if (!mac) return false;
    const entry = this.anomalyState.getOrInit(mac);
    const bucket = this.anomalyState.hourBucket(rec.ts);
    entry.hourlyCounts[bucket] = (entry.hourlyCounts[bucket] ?? 0) + 1;
    if (!(rec.domain in entry.firstSeenDomains)) {
      entry.firstSeenDomains[rec.domain] = rec.ts;
    }
    // Attach stamps for NXDOMAIN and blocked tallies via separate keys
    const nxKey = `_nx_${bucket}`;
    const blockedKey = `_blk_${bucket}`;
    if (rec.nxdomain) {
      entry.hourlyCounts[nxKey] = (entry.hourlyCounts[nxKey] ?? 0) + 1;
    }
    if (rec.blocked) {
      entry.hourlyCounts[blockedKey] = (entry.hourlyCounts[blockedKey] ?? 0) + 1;
    }
    return true;
  }

  private computeForMac(mac: string, name: string | null, nowSec: number): DeviceAnomaly {
    const entry = this.anomalyState.get(mac) ?? { firstSeenDomains: {}, hourlyCounts: {} };

    // queries_1h: current hour bucket
    const curBucket = this.anomalyState.hourBucket(nowSec);
    const q1h = entry.hourlyCounts[curBucket] ?? 0;
    const nx1h = entry.hourlyCounts[`_nx_${curBucket}`] ?? 0;

    // queries_24h_avg_per_hour: average over last 24 buckets (excluding current)
    let sum24 = 0;
    let n24 = 0;
    let blocked24 = 0;
    for (let h = 1; h <= 24; h++) {
      const b = this.anomalyState.hourBucket(nowSec - h * 3600);
      const cnt = entry.hourlyCounts[b] ?? 0;
      if (cnt > 0) { sum24 += cnt; n24++; }
      blocked24 += entry.hourlyCounts[`_blk_${b}`] ?? 0;
    }
    blocked24 += entry.hourlyCounts[`_blk_${curBucket}`] ?? 0;
    const avg24 = n24 > 0 ? sum24 / n24 : 0;

    // new_domains_1h: domains whose firstSeen is within last hour
    const floor = nowSec - 3600;
    let newDomains = 0;
    for (const ts of Object.values(entry.firstSeenDomains)) {
      if (ts >= floor) newDomains++;
    }

    const nxdomainRate = q1h > 0 ? nx1h / q1h : 0;

    const signals: string[] = [];
    let score = 0;
    if (q1h > 50 && avg24 > 0 && q1h > 3 * avg24) { signals.push("rate_spike"); score += 40; }
    if (q1h >= 30 && nxdomainRate > 0.3) { signals.push("nxdomain_high"); score += 30; }
    if (newDomains > 20) { signals.push("first_seen_flood"); score += 20; }
    if (blocked24 > 0) { signals.push("threat_hit"); score += Math.min(20, blocked24 * 5); }
    if (score > 100) score = 100;

    return {
      mac,
      name,
      ips: [],
      score,
      signals,
      queries_1h: q1h,
      queries_24h_avg_per_hour: Math.round(avg24 * 10) / 10,
      nxdomain_rate: Math.round(nxdomainRate * 100) / 100,
      new_domains_1h: newDomains,
      blocked_hits_24h: blocked24,
      last_seen_ts: nowSec,
    };
  }
}
