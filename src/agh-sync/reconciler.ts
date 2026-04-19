import type { FreeboxClient } from "../freeboxClient.js";
import type { AdGuardHomeClient } from "./aghClient.js";
import type { StateStore } from "./state.js";
import {
  MANAGED_TAG,
  type AghClient,
  type FreeboxL3Connectivity,
  type FreeboxLanHostsResponse,
  type FreeboxRawHost,
} from "./types.js";

// AGH enforces no server-side allowlist, but its UI and per-tag rules only
// render nicely for its 21 conventional tags (internal/client/storage.go).
// Mapping Freebox host_type → AGH tag lights up native per-tag filtering
// without manual setup. Unknown types fall through to `freebox_type:*` only.
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
}

export class Reconciler {
  constructor(
    private freebox: FreeboxClient,
    private agh: AdGuardHomeClient,
    private state: StateStore,
    private cfg: ReconcilerConfig,
    private log: (msg: string) => void,
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
    const v4 =
      conns.find((c) => c.af === "ipv4" && c.active) ??
      conns.find((c) => c.af === "ipv4");
    const v6 =
      conns.find((c) => c.af === "ipv6" && c.active) ??
      conns.find((c) => c.af === "ipv6");
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

  buildTags(host: FreeboxRawHost, isVm: boolean): string[] {
    const tags = [MANAGED_TAG];
    const raw = host.host_type;
    if (raw) {
      const conventional = FREEBOX_TYPE_TO_AGH_TAG[raw];
      if (conventional) tags.push(conventional);
      tags.push(`freebox_type:${raw}`);
    }
    if (isVm) tags.push("source:vm");
    return tags;
  }

  async buildDesiredSet(): Promise<Map<string, DesiredClient>> {
    const lanResp = (await this.freebox.getLanHosts({
      compact: false,
      limit: 0,
    })) as FreeboxLanHostsResponse;

    const vms = (await this.freebox.getVMs().catch(() => [])) as unknown;
    const vmMacs = this.collectVmMacs(vms);

    const desired = new Map<string, DesiredClient>();
    for (const host of lanResp.hosts) {
      const mac = this.normalizeMac(host.l2ident?.id ?? null);
      if (!mac) continue;
      if (this.cfg.excludeMacs.has(mac)) continue;

      const { ipv4, ipv6 } = this.pickIps(host);
      const ids = [mac];
      if (ipv4) ids.push(ipv4);
      if (ipv6) ids.push(ipv6);

      desired.set(mac, {
        mac,
        client: {
          name: this.buildName(host, mac),
          ids,
          tags: this.buildTags(host, vmMacs.has(mac)),
          use_global_settings: true,
          use_global_blocked_services: true,
          filtering_enabled: true,
          parental_enabled: false,
          safebrowsing_enabled: false,
        },
      });
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

  async reconcile(): Promise<{ added: number; updated: number; deleted: number; unchanged: number }> {
    const desired = await this.buildDesiredSet();
    const aghResp = await this.agh.listClients();
    const managed = (aghResp.clients ?? []).filter((c) =>
      (c.tags ?? []).includes(MANAGED_TAG),
    );
    const managedByMac = new Map<string, AghClient>();
    for (const c of managed) {
      const mac = c.ids.find((id) => this.normalizeMac(id) !== null);
      const n = this.normalizeMac(mac ?? null);
      if (n) managedByMac.set(n, c);
    }

    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    for (const [mac, { client }] of desired) {
      const existing = managedByMac.get(mac);
      const stateEntry = this.state.get(mac);
      if (!existing) {
        try {
          await this.agh.addClient(client);
          this.state.upsert({ mac, aghName: client.name, lastSeen: now });
          this.log(`[reconcile] + ${client.name} (${mac}) tags=${(client.tags ?? []).join(",")}`);
          added++;
        } catch (e) {
          this.log(`[reconcile] add failed for ${client.name} (${mac}): ${String(e)}`);
        }
        continue;
      }

      if (this.clientEquals(existing, client)) {
        this.state.upsert({ mac, aghName: client.name, lastSeen: now });
        unchanged++;
        continue;
      }

      const lookupName = stateEntry?.aghName ?? existing.name;
      try {
        await this.agh.updateClient({ name: lookupName, data: client });
        this.state.upsert({ mac, aghName: client.name, lastSeen: now });
        this.log(`[reconcile] ~ ${lookupName} → ${client.name} (${mac})`);
        updated++;
      } catch (e) {
        this.log(`[reconcile] update failed for ${lookupName} (${mac}): ${String(e)}`);
      }
    }

    const retentionSec = this.cfg.retentionDays * 86400;
    for (const [mac, client] of managedByMac) {
      if (desired.has(mac)) continue;
      const entry = this.state.get(mac);
      const lastSeen = entry?.lastSeen ?? 0;
      if (now - lastSeen < retentionSec) continue;
      try {
        await this.agh.deleteClient({ name: client.name });
        this.state.remove(mac);
        this.log(`[reconcile] - ${client.name} (${mac}, stale > ${this.cfg.retentionDays}d)`);
        deleted++;
      } catch (e) {
        this.log(`[reconcile] delete failed for ${client.name} (${mac}): ${String(e)}`);
      }
    }

    this.state.save();
    return { added, updated, deleted, unchanged };
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
    const ids = [mac];
    if (ipv4) ids.push(ipv4);
    if (ipv6) ids.push(ipv6);

    const client: AghClient = {
      name: this.buildName(host, mac),
      ids,
      tags: this.buildTags(host, vmMacs.has(mac)),
      use_global_settings: true,
      use_global_blocked_services: true,
      filtering_enabled: true,
      parental_enabled: false,
      safebrowsing_enabled: false,
    };

    const aghResp = await this.agh.listClients();
    const existing = (aghResp.clients ?? []).find((c) =>
      (c.tags ?? []).includes(MANAGED_TAG) &&
      c.ids.some((id) => this.normalizeMac(id) === mac),
    );

    const now = Math.floor(Date.now() / 1000);
    if (!existing) {
      await this.agh.addClient(client);
      this.state.upsert({ mac, aghName: client.name, lastSeen: now });
      this.state.save();
      this.log(`[live] + ${client.name} ip=${ip} mac=${mac}`);
      return true;
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
