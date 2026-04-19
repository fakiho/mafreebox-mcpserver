import type { AdGuardHomeClient } from "./aghClient.js";
import type { StateStore } from "./state.js";
import type { FreeboxLanHostsResponse, FreeboxRawHost, SuspectedBypasser } from "./types.js";

/**
 * A device is suspected of bypassing AGH if:
 *  - Freebox has seen it active within the last N hours (default 24h), AND
 *  - we have an AGH client for it (MAC is in our state ledger), AND
 *  - AGH's stats show zero queries from that client in the same window.
 *
 * All three must hold. Offline/sleeping devices fail the first test;
 * devices we haven't synced yet fail the second; devices that simply
 * happen to resolve nothing fail the third — but in practice even idle
 * IoT makes at least a handful of DNS queries per day (NTP, firmware,
 * heartbeats), so persistent zero is a strong bypass signal.
 */
export class BypassDetector {
  constructor(
    private agh: AdGuardHomeClient,
    private state: StateStore,
    private log: (msg: string) => void,
  ) {}

  async detect(
    freeboxHosts: FreeboxRawHost[],
    activityWindowSec = 86400,
  ): Promise<SuspectedBypasser[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - activityWindowSec;

    const stats = await this.agh.getStats().catch(() => null);
    if (!stats) {
      this.log(`[bypass] AGH stats unavailable — skipping detection`);
      return [];
    }
    const queryingNames = new Set<string>();
    for (const entry of stats.top_clients ?? []) {
      for (const name of Object.keys(entry)) queryingNames.add(name);
    }

    const macToFreebox = new Map<string, FreeboxRawHost>();
    for (const h of freeboxHosts) {
      const raw = h.l2ident?.id;
      if (!raw) continue;
      const mac = raw.trim().toLowerCase().replace(/-/g, ":");
      macToFreebox.set(mac, h);
    }

    const out: SuspectedBypasser[] = [];
    for (const entry of this.state.all()) {
      const host = macToFreebox.get(entry.mac);
      if (!host) continue;
      const lastActive = host.last_activity ?? 0;
      if (lastActive < cutoff) continue;

      const aghClient = queryingNames.has(entry.aghName);
      if (aghClient) continue;

      const ips: string[] = [];
      for (const c of host.l3connectivities ?? []) {
        if (c.addr && !c.addr.toLowerCase().startsWith("fe80:")) ips.push(c.addr);
      }
      out.push({
        mac: entry.mac,
        aghName: entry.aghName,
        lastActiveFreebox: lastActive,
        ips,
      });
    }
    return out;
  }
}
