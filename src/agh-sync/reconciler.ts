import type { FreeboxClient } from "../freeboxClient.js";
import type { AdGuardHomeClient } from "./aghClient.js";
import type { NeighborCache } from "./neighborDiscovery.js";
import type { StateStore } from "./state.js";
import type {
  AghClient,
  FreeboxL3Connectivity,
  FreeboxLanHostsResponse,
  FreeboxRawHost,
} from "./types.js";

/**
 * Filters out addresses that are noise in AGH client ids:
 * - IPv6 link-local (fe80::/10) — never reaches AGH's DNS listener
 * - IPv4 link-local / APIPA (169.254.0.0/16)
 * - Unspecified / malformed (e.g. "2a01:e0a:239:cdd0::" — a /64 prefix with
 *   null host that some routers emit as a neighbor placeholder)
 */
function isRoutableIp(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const ip = addr.toLowerCase().trim();
  if (!ip) return false;
  if (ip.startsWith("fe80:")) return false;
  if (ip.startsWith("169.254.")) return false;
  if (ip === "0.0.0.0" || ip === "::" || ip === "::0") return false;
  if (ip.endsWith("::")) return false; // null host (e.g. prefix-only)
  return true;
}

// AGH DOES enforce a server-side allowlist on tags (empirically: POST
// /control/clients/add returns HTTP 400 "invalid tag: X" for any tag outside
// the 21 constants in internal/client/storage.go's allowedTags).
// So we only emit conventional tags — no custom marker, no freebox_type:*.
// Ownership is tracked in state.json (MAC → aghName), not via a tag marker.
const FREEBOX_TYPE_TO_AGH_TAG: Record<string, string> = {
  smartphone: "device_phone",
  phone: "device_phone",
  laptop: "device_laptop",
  desktop: "device_pc",
  workstation: "device_pc",
  tablet: "device_tablet",
  printer: "device_printer",
  nas: "device_nas",
  networking: "device_other",
  media_player: "device_tv",
  multimedia_device: "device_tv",
  freebox_player: "device_tv",
  tv: "device_tv",
  ip_camera: "device_camera",
  camera: "device_camera",
  game_console: "device_gameconsole",
  console: "device_gameconsole",
  alarm: "device_securityalarm",
  audio_player: "device_audio",
  speaker: "device_audio",
  other: "device_other",
};

export interface ReconcilerConfig {
  retentionDays: number;
  excludeMacs: Set<string>;
}

export interface DesiredClient {
  mac: string;
  client: AghClient;
  rawType?: string;
}

export class Reconciler {
  constructor(
    private freebox: FreeboxClient,
    private agh: AdGuardHomeClient,
    private state: StateStore,
    private cfg: ReconcilerConfig,
    private log: (msg: string) => void,
    private neighbors: NeighborCache | null = null,
  ) {}

  normalizeMac(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.trim().toLowerCase().replace(/-/g, ":");
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(cleaned)) return null;
    return cleaned;
  }

  pickIps(host: FreeboxRawHost): { ipv4: string | null; ipv6: string | null } {
    const conns: FreeboxL3Connectivity[] = Array.isArray(host.l3connectivities)
      ? host.l3connectivities
      : [];
    const usefulV4 = conns.filter((c) => c.af === "ipv4" && isRoutableIp(c.addr));
    const usefulV6 = conns.filter((c) => c.af === "ipv6" && isRoutableIp(c.addr));
    const v4 = usefulV4.find((c) => c.active) ?? usefulV4[0];
    const v6 = usefulV6.find((c) => c.active) ?? usefulV6[0];
    return { ipv4: v4?.addr ?? null, ipv6: v6?.addr ?? null };
  }

  buildName(host: FreeboxRawHost, mac: string): string {
    const primary = (host.primary_name ?? "").trim();
    if (primary) return primary;
    const fallback = (host.default_name ?? "").trim();
    if (fallback) return fallback;
    const vendor = (host.vendor_name ?? "").trim() || "device";
    const suffix = mac.split(":").slice(-3).join("").toUpperCase();
    return `${vendor}-${suffix}`;
  }

  buildTags(host: FreeboxRawHost, _isVm: boolean): string[] {
    const tags: string[] = [];
    const raw = host.host_type;
    if (raw) {
      const conventional = FREEBOX_TYPE_TO_AGH_TAG[raw];
      if (conventional) tags.push(conventional);
    }
    return tags;
  }

  async buildDesiredSet(): Promise<Map<string, DesiredClient>> {
    const lanResp = (await this.freebox.getLanHosts({
      compact: false,
      limit: 0,
    })) as FreeboxLanHostsResponse;

    const vms = (await this.freebox.getVMs().catch(() => [])) as unknown;
    const vmMacs = this.collectVmMacs(vms);
    const neighborMap = this.neighbors ? await this.neighbors.snapshot() : new Map<string, Set<string>>();

    const desired = new Map<string, DesiredClient>();
    for (const host of lanResp.hosts) {
      const mac = this.normalizeMac(host.l2ident?.id ?? null);
      if (!mac) continue;
      if (this.cfg.excludeMacs.has(mac)) continue;

      const { ipv4, ipv6 } = this.pickIps(host);
      const ids = new Set<string>([mac]);
      if (ipv4) ids.add(ipv4);
      if (ipv6) ids.add(ipv6);
      // Merge addresses the host kernel has observed for this MAC — catches
      // SLAAC and IPv6 privacy addresses Freebox doesn't report.
      const kernelIps = neighborMap.get(mac);
      if (kernelIps) for (const ip of kernelIps) {
        if (isRoutableIp(ip)) ids.add(ip);
      }

      desired.set(mac, {
        mac,
        rawType: host.host_type,
        client: {
          name: this.buildName(host, mac),
          ids: Array.from(ids),
          tags: this.buildTags(host, vmMacs.has(mac)),
          use_global_settings: true,
          use_global_blocked_services: true,
          filtering_enabled: true,
          parental_enabled: false,
          safebrowsing_enabled: false,
        },
      });
    }

    // Freebox devices can share a display name (4 iPhones, 3 Macs, etc.).
    // AGH requires unique names across all persistent clients — disambiguate
    // every duplicate with a MAC-tail suffix so each Freebox device keeps its
    // own identity. Only duplicates are suffixed; unique names stay clean.
    const nameCount = new Map<string, number>();
    for (const { client } of desired.values()) {
      nameCount.set(client.name, (nameCount.get(client.name) ?? 0) + 1);
    }
    for (const entry of desired.values()) {
      if ((nameCount.get(entry.client.name) ?? 0) > 1) {
        const suffix = entry.mac.split(":").slice(-3).join("").toUpperCase();
        entry.client.name = `${entry.client.name} (${suffix})`;
      }
    }
    return desired;
  }

  private collectVmMacs(raw: unknown): Set<string> {
    const macs = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node === "object") {
        const rec = node as Record<string, unknown>;
        for (const [k, v] of Object.entries(rec)) {
          if (k === "mac" && typeof v === "string") {
            const norm = this.normalizeMac(v);
            if (norm) macs.add(norm);
          } else if (typeof v === "object" && v !== null) {
            walk(v);
          }
        }
      }
    };
    walk(raw);
    return macs;
  }

  async reconcile(): Promise<{ added: number; adopted: number; updated: number; deleted: number; unchanged: number }> {
    const desired = await this.buildDesiredSet();
    const aghResp = await this.agh.listClients();

    // Index AGH clients by MAC and by name. Both views are needed: MAC finds
    // "same device" even if named differently; name finds conflicts during add.
    const aghByMac = new Map<string, AghClient>();
    const aghByName = new Map<string, AghClient>();
    for (const c of aghResp.clients ?? []) {
      aghByName.set(c.name, c);
      for (const id of c.ids) {
        const n = this.normalizeMac(id);
        if (n) aghByMac.set(n, c);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    let adopted = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    for (const [mac, desiredEntry] of desired) {
      const { client } = desiredEntry;
      const existing = aghByMac.get(mac);
      const wasManaged = this.state.get(mac) !== undefined;

      if (existing) {
        if (this.clientEquals(existing, client)) {
          this.state.upsert({ mac, aghName: client.name, lastSeen: now });
          unchanged++;
          continue;
        }
        const upsertResult = await this.updateWithConflictHandling(existing.name, client, mac);
        if (upsertResult) {
          this.state.upsert({ mac, aghName: upsertResult.name, lastSeen: now });
          if (wasManaged) {
            this.log(`[reconcile] ~ "${existing.name}" → "${upsertResult.name}" (${mac})`);
            updated++;
          } else {
            this.log(`[reconcile] adopted "${existing.name}" → "${upsertResult.name}" (${mac}) — Freebox authoritative`);
            adopted++;
          }
        }
        continue;
      }

      const addResult = await this.addWithConflictHandling(client, mac);
      if (addResult) {
        this.state.upsert({ mac, aghName: addResult.name, lastSeen: now });
        const typeHint = this.rawTypeHint(desiredEntry);
        this.log(`[reconcile] + ${addResult.name} (${mac}) tags=${(addResult.tags ?? []).join(",") || "-"}${typeHint}`);
        added++;
      }
    }

    // Retention: delete OUR clients (state-tracked) whose MACs no longer appear
    // in Freebox. User-owned AGH clients unrelated to Freebox are never deleted.
    const retentionSec = this.cfg.retentionDays * 86400;
    for (const mac of this.state.macs()) {
      if (desired.has(mac)) continue;
      const entry = this.state.get(mac);
      const lastSeen = entry?.lastSeen ?? 0;
      if (now - lastSeen < retentionSec) continue;
      const aghClient = aghByMac.get(mac);
      try {
        if (aghClient) await this.agh.deleteClient({ name: aghClient.name });
        this.state.remove(mac);
        this.log(`[reconcile] - ${aghClient?.name ?? mac} (${mac}, stale > ${this.cfg.retentionDays}d)`);
        deleted++;
      } catch (e) {
        this.log(`[reconcile] delete failed for ${aghClient?.name ?? mac} (${mac}): ${String(e)}`);
      }
    }

    this.state.save();
    return { added, adopted, updated, deleted, unchanged };
  }

  async enrichByIp(ip: string): Promise<boolean> {
    const lanResp = (await this.freebox.getLanHosts({
      compact: false,
      limit: 0,
    })) as FreeboxLanHostsResponse;

    const host = lanResp.hosts.find((h) => {
      const { ipv4, ipv6 } = this.pickIps(h);
      return ipv4 === ip || ipv6 === ip;
    });
    if (!host) return false;

    const mac = this.normalizeMac(host.l2ident?.id ?? null);
    if (!mac) return false;
    if (this.cfg.excludeMacs.has(mac)) return false;

    const vms = (await this.freebox.getVMs().catch(() => [])) as unknown;
    const vmMacs = this.collectVmMacs(vms);
    const { ipv4, ipv6 } = this.pickIps(host);
    const ids = new Set<string>([mac]);
    if (ipv4) ids.add(ipv4);
    if (ipv6) ids.add(ipv6);
    if (this.neighbors) {
      const kernelIps = (await this.neighbors.snapshot()).get(mac);
      if (kernelIps) for (const ipAddr of kernelIps) {
        if (isRoutableIp(ipAddr)) ids.add(ipAddr);
      }
    }

    const client: AghClient = {
      name: this.buildName(host, mac),
      ids: Array.from(ids),
      tags: this.buildTags(host, vmMacs.has(mac)),
      use_global_settings: true,
      use_global_blocked_services: true,
      filtering_enabled: true,
      parental_enabled: false,
      safebrowsing_enabled: false,
    };

    const aghResp = await this.agh.listClients();
    const existing = (aghResp.clients ?? []).find((c) =>
      c.ids.some((id) => this.normalizeMac(id) === mac),
    );
    const isManaged = this.state.get(mac) !== undefined;

    const now = Math.floor(Date.now() / 1000);
    if (!existing) {
      const saved = await this.addWithConflictHandling(client, mac);
      if (!saved) return false;
      this.state.upsert({ mac, aghName: saved.name, lastSeen: now });
      this.state.save();
      this.log(`[live] + ${saved.name} ip=${ip} mac=${mac}`);
      return true;
    }
    if (!isManaged) {
      // Pre-existing user-owned client with matching MAC — never touch it.
      return false;
    }
    if (this.clientEquals(existing, client)) {
      this.state.upsert({ mac, aghName: client.name, lastSeen: now });
      this.state.save();
      return false;
    }
    const stateEntry = this.state.get(mac);
    const lookupName = stateEntry?.aghName ?? existing.name;
    await this.agh.updateClient({ name: lookupName, data: client });
    this.state.upsert({ mac, aghName: client.name, lastSeen: now });
    this.state.save();
    this.log(`[live] ~ ${lookupName} → ${client.name} ip=${ip} mac=${mac}`);
    return true;
  }

  /**
   * Policy: Freebox is the source of truth. On conflict, the colliding AGH
   * client is deleted and Freebox's data replaces it. The only exception is
   * duplicate names within the Freebox set itself — those are pre-disambiguated
   * with a MAC-tail suffix before this function is called, so any name/IP
   * collision here is guaranteed to be with a *non-Freebox-backed* AGH client
   * (either pre-existing user data or orphaned from an earlier sync).
   */
  private async addWithConflictHandling(
    client: AghClient,
    mac: string,
  ): Promise<AghClient | null> {
    try {
      await this.agh.addClient(client);
      return client;
    } catch (e) {
      const msg = String(e);
      const nameMatch = msg.match(/uses the same name "([^"]+)"/);
      if (nameMatch) {
        await this.evictAndRetry(nameMatch[1], client, mac, "name");
        return client;
      }
      const ipMatch = msg.match(/another client "([^"]+)" uses the same IP/);
      if (ipMatch) {
        await this.evictAndRetry(ipMatch[1], client, mac, "IP");
        return client;
      }
      this.log(`[reconcile] add failed for "${client.name}" (${mac}): ${msg}`);
      return null;
    }
  }

  /**
   * Like addWithConflictHandling but issues an update (client already exists
   * under `currentName`). Used to adopt a pre-existing AGH client whose MAC
   * matches a Freebox host, or to update one we created earlier.
   */
  private async updateWithConflictHandling(
    currentName: string,
    client: AghClient,
    mac: string,
  ): Promise<AghClient | null> {
    try {
      await this.agh.updateClient({ name: currentName, data: client });
      return client;
    } catch (e) {
      const msg = String(e);
      const nameMatch = msg.match(/uses the same name "([^"]+)"/);
      if (nameMatch && nameMatch[1] !== currentName) {
        await this.agh.deleteClient({ name: nameMatch[1] }).catch(() => {});
        this.log(`[reconcile]   evicted "${nameMatch[1]}" to free name for "${client.name}"`);
        try {
          await this.agh.updateClient({ name: currentName, data: client });
          return client;
        } catch (e2) {
          this.log(`[reconcile] update failed after name eviction for "${client.name}" (${mac}): ${String(e2)}`);
          return null;
        }
      }
      const ipMatch = msg.match(/another client "([^"]+)" uses the same IP/);
      if (ipMatch && ipMatch[1] !== currentName) {
        await this.agh.deleteClient({ name: ipMatch[1] }).catch(() => {});
        this.log(`[reconcile]   evicted "${ipMatch[1]}" to free IP for "${client.name}"`);
        try {
          await this.agh.updateClient({ name: currentName, data: client });
          return client;
        } catch (e2) {
          this.log(`[reconcile] update failed after IP eviction for "${client.name}" (${mac}): ${String(e2)}`);
          return null;
        }
      }
      this.log(`[reconcile] update failed for "${currentName}" → "${client.name}" (${mac}): ${msg}`);
      return null;
    }
  }

  private async evictAndRetry(
    collidingName: string,
    client: AghClient,
    mac: string,
    conflict: "name" | "IP",
  ): Promise<void> {
    this.log(`[reconcile]   ${conflict} conflict — evicting "${collidingName}" to make room for Freebox "${client.name}" (${mac})`);
    await this.agh.deleteClient({ name: collidingName }).catch(() => {});
    this.state.remove(this.findStateMacByName(collidingName) ?? "__none__");
    await this.agh.addClient(client);
  }

  private findStateMacByName(name: string): string | null {
    for (const entry of this.state.all()) {
      if (entry.aghName === name) return entry.mac;
    }
    return null;
  }

  /**
   * If the desired client has no mapped AGH tag, append the raw Freebox
   * host_type to the log so the mapping can be expanded. Cheap feedback loop.
   */
  private rawTypeHint(desired: DesiredClient | undefined): string {
    if (!desired) return "";
    const hasTag = (desired.client.tags ?? []).length > 0;
    if (hasTag) return "";
    if (!desired.rawType) return "";
    return ` [host_type=${desired.rawType}]`;
  }

  private clientEquals(a: AghClient, b: AghClient): boolean {
    if (a.name !== b.name) return false;
    if (!this.setEquals(a.ids, b.ids)) return false;
    if (!this.setEquals(a.tags ?? [], b.tags ?? [])) return false;
    return true;
  }

  private setEquals(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    for (const x of b) if (!sa.has(x)) return false;
    return true;
  }
}
