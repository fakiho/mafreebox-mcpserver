import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { FreeboxClient } from "../freeboxClient.js";
import type {
  DeviceAnomaly,
  IsolationRecord,
  IsolationStateFile,
} from "./types.js";

const CONFIRM_TTL_SEC = 24 * 3600;

export interface IsolationConfig {
  /** Seed allowlist from env — used only if the state file doesn't yet
   *  have an allowlist array. Post-seed, the file is authoritative. */
  envAllowlistSeed: Set<string>;
  autoEnabled: boolean;
  autoScoreThreshold: number;
  defaultDurationSec: number;
  statePath: string;
}

export interface ApplyOpts {
  durationSec?: number;
  reason: string;
  source: IsolationRecord["source"];
  userConfirmed: boolean;
}

/**
 * Central decision authority for "should this device be cut off from the
 * internet?" plus the bookkeeping of current isolations. All Freebox
 * parental-control side-effects flow through this module so they can be
 * audited in one place.
 *
 * Non-negotiable invariants:
 * - A MAC in `allowlist` is NEVER isolated, regardless of signals or
 *   calling source (Node-RED, auto, manual API). Enforced in every path.
 * - The first isolation of any given MAC requires `userConfirmed=true`.
 *   The `confirmedMacs` map remembers confirmations for 24h so repeat
 *   offenders can skip the dialog.
 * - Freebox's `tmp_mode_expire` provides native time-limited blocking —
 *   we don't run our own un-block timers on the happy path.
 */
export class IsolationManager {
  private state: IsolationStateFile = { isolations: [], confirmedMacs: {}, allowlist: [] };
  /** Cached effective allowlist set (lowercased, normalized). Rebuilt on
   *  every mutation so hot-path isAllowlisted() is O(1). */
  private allowlistSet: Set<string> = new Set();

  constructor(
    private freebox: FreeboxClient,
    private cfg: IsolationConfig,
    private log: (msg: string) => void,
  ) {
    this.load();
  }

  private load(): void {
    if (existsSync(this.cfg.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.cfg.statePath, "utf8"));
        if (raw && typeof raw === "object") {
          this.state = {
            isolations: Array.isArray(raw.isolations) ? raw.isolations : [],
            confirmedMacs: (raw.confirmedMacs && typeof raw.confirmedMacs === "object") ? raw.confirmedMacs : {},
            allowlist: Array.isArray(raw.allowlist) ? raw.allowlist : [],
          };
        }
      } catch {
        // fall through to env seed below
      }
    }
    // Seed from env on first boot (no allowlist yet OR empty).
    if (this.state.allowlist.length === 0 && this.cfg.envAllowlistSeed.size > 0) {
      this.state.allowlist = Array.from(this.cfg.envAllowlistSeed);
      this.log(`[isolation] seeded allowlist from env with ${this.state.allowlist.length} MAC(s)`);
      this.save();
    }
    this.rebuildAllowlistSet();
  }

  private rebuildAllowlistSet(): void {
    this.allowlistSet = new Set(this.state.allowlist.map((m) => this.normalizeMac(m)));
  }

  save(): void {
    const dir = dirname(this.cfg.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = this.cfg.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    try {
      renameSync(tmp, this.cfg.statePath);
    } catch {
      writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    }
  }

  private normalizeMac(mac: string): string {
    return mac.trim().toLowerCase().replace(/-/g, ":");
  }

  isAllowlisted(mac: string): boolean {
    return this.allowlistSet.has(this.normalizeMac(mac));
  }

  /** Adds a MAC to the dynamic allowlist. Idempotent. Automatically
   *  revokes any active isolation on that MAC (trusting a device implies
   *  we don't want it blocked). Returns true if newly added. */
  async addToAllowlist(mac: string): Promise<{ added: boolean; revokedIsolation: boolean }> {
    const m = this.normalizeMac(mac);
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) {
      throw new IsolationError("bad_mac", `Invalid MAC format: ${mac}`);
    }
    if (this.allowlistSet.has(m)) return { added: false, revokedIsolation: false };
    this.state.allowlist.push(m);
    this.rebuildAllowlistSet();
    this.log(`[isolation] + allowlist ${m}`);
    // Lifting any active isolation for newly-trusted MAC keeps semantics clean.
    let revoked = false;
    if (this.state.isolations.some((r) => r.mac === m)) {
      try {
        await this.revoke(m);
        revoked = true;
      } catch (e) {
        this.log(`[isolation] allowlist add: revoke failed for ${m}: ${String(e)}`);
      }
    }
    this.save();
    return { added: true, revokedIsolation: revoked };
  }

  /** Removes a MAC from the dynamic allowlist. Idempotent. */
  removeFromAllowlist(mac: string): boolean {
    const m = this.normalizeMac(mac);
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) {
      throw new IsolationError("bad_mac", `Invalid MAC format: ${mac}`);
    }
    const before = this.state.allowlist.length;
    this.state.allowlist = this.state.allowlist.filter((x) => this.normalizeMac(x) !== m);
    if (this.state.allowlist.length === before) return false;
    this.rebuildAllowlistSet();
    this.log(`[isolation] - allowlist ${m}`);
    this.save();
    return true;
  }

  listAllowlist(): string[] {
    return Array.from(this.allowlistSet).sort();
  }

  isCurrentlyIsolated(mac: string): boolean {
    const m = this.normalizeMac(mac);
    const nowSec = Math.floor(Date.now() / 1000);
    return this.state.isolations.some((r) => r.mac === m && r.expiresAt > nowSec);
  }

  wasRecentlyConfirmed(mac: string): boolean {
    const m = this.normalizeMac(mac);
    const nowSec = Math.floor(Date.now() / 1000);
    const ts = this.state.confirmedMacs[m];
    return typeof ts === "number" && nowSec - ts < CONFIRM_TTL_SEC;
  }

  /**
   * Decides whether a given anomaly warrants proposing isolation.
   * Conservative by default — only strong signals earn a proposal. The
   * actual block never happens without user confirmation in v1 (unless
   * the caller is the API with userConfirmed=true, or auto mode is on
   * AND the MAC is already in the recently-confirmed set).
   */
  shouldPropose(anomaly: DeviceAnomaly): { propose: boolean; reason: string } {
    if (this.isAllowlisted(anomaly.mac)) {
      return { propose: false, reason: "allowlisted" };
    }
    if (this.isCurrentlyIsolated(anomaly.mac)) {
      return { propose: false, reason: "already isolated" };
    }
    if (anomaly.threat_intel_hits_24h > 0) {
      return { propose: true, reason: `threat-intel hit (${anomaly.threat_intel_hits_24h} in 24h)` };
    }
    if (anomaly.score >= this.cfg.autoScoreThreshold && anomaly.signals.length >= 2) {
      return { propose: true, reason: `score=${anomaly.score} signals=${anomaly.signals.join("+")}` };
    }
    return { propose: false, reason: "below threshold" };
  }

  /**
   * Applies an isolation. Throws IsolationError on safety-check failures
   * so the HTTP layer can map to 409/403/400.
   */
  async apply(mac: string, opts: ApplyOpts): Promise<IsolationRecord> {
    const m = this.normalizeMac(mac);
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) {
      throw new IsolationError("bad_mac", `Invalid MAC format: ${mac}`);
    }
    if (this.isAllowlisted(m)) {
      throw new IsolationError("allowlisted", `MAC ${m} is in BYPASS_ALLOWLIST — isolation refused`);
    }
    // First-isolate-always-confirmed, unless the caller is auto mode AND
    // we've seen a user confirmation for this MAC within CONFIRM_TTL_SEC.
    if (!opts.userConfirmed) {
      if (opts.source !== "auto" || !this.wasRecentlyConfirmed(m)) {
        throw new IsolationError(
          "confirmation_required",
          `MAC ${m} requires user confirmation for first isolation`,
        );
      }
    }

    const durationSec = opts.durationSec ?? this.cfg.defaultDurationSec;
    const { filterId, expiresAt } = await this.freebox.blockMac(m, { durationSec });
    const nowSec = Math.floor(Date.now() / 1000);
    const record: IsolationRecord = {
      mac: m,
      filterId,
      blockedAt: nowSec,
      expiresAt,
      reason: opts.reason,
      confirmedByUser: opts.userConfirmed,
      source: opts.source,
    };
    // Replace any prior entry for this MAC
    this.state.isolations = this.state.isolations.filter((r) => r.mac !== m);
    this.state.isolations.push(record);
    if (opts.userConfirmed) {
      this.state.confirmedMacs[m] = nowSec;
    }
    this.save();
    this.log(`[isolation] 🚫 blocked ${m} for ${Math.floor(durationSec / 60)}min (${opts.reason}, source=${opts.source})`);
    return record;
  }

  async revoke(mac: string): Promise<boolean> {
    const m = this.normalizeMac(mac);
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) {
      throw new IsolationError("bad_mac", `Invalid MAC format: ${mac}`);
    }
    const existed = this.state.isolations.some((r) => r.mac === m);
    try {
      await this.freebox.unblockMac(m);
    } catch (e) {
      this.log(`[isolation] Freebox unblock failed for ${m}: ${String(e)}`);
    }
    this.state.isolations = this.state.isolations.filter((r) => r.mac !== m);
    this.save();
    this.log(`[isolation] ✅ unblocked ${m}${existed ? "" : " (was not in our ledger)"}`);
    return existed;
  }

  getActive(): IsolationRecord[] {
    const nowSec = Math.floor(Date.now() / 1000);
    return this.state.isolations.filter((r) => r.expiresAt > nowSec);
  }

  /**
   * Runs every reconcile tick. Prunes expired entries from our ledger
   * (Freebox auto-unblocks via tmp_mode_expire, so we just catch up).
   * Also prunes stale confirmedMacs entries past the TTL.
   */
  cleanupExpired(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const before = this.state.isolations.length;
    this.state.isolations = this.state.isolations.filter((r) => r.expiresAt > nowSec);
    for (const [mac, ts] of Object.entries(this.state.confirmedMacs)) {
      if (nowSec - ts > CONFIRM_TTL_SEC) delete this.state.confirmedMacs[mac];
    }
    if (this.state.isolations.length !== before) {
      this.log(`[isolation] cleaned ${before - this.state.isolations.length} expired record(s)`);
      this.save();
    }
  }

  getConfig(): { allowlist: string[]; autoEnabled: boolean; autoScoreThreshold: number; defaultDurationSec: number } {
    return {
      allowlist: this.listAllowlist(),
      autoEnabled: this.cfg.autoEnabled,
      autoScoreThreshold: this.cfg.autoScoreThreshold,
      defaultDurationSec: this.cfg.defaultDurationSec,
    };
  }
}

export class IsolationError extends Error {
  constructor(public code: "bad_mac" | "allowlisted" | "confirmation_required" | "internal", message: string) {
    super(message);
    this.name = "IsolationError";
  }
}
