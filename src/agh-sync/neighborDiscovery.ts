import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Reads the host kernel's neighbor cache (NDP for v6, ARP for v4) and returns
 * a MAC → Set<IP> map. Requires network_mode: host and the `ip` binary from
 * iproute2 (installed in the agh-sync Dockerfile).
 *
 * This is strictly supplementary to Freebox's /lan/browser/pub/: Freebox only
 * reports DHCP/ARP-observed addresses, while NDP catches SLAAC, RFC-4941
 * privacy addresses, and any v6 device the kernel has talked to.
 */
export class NeighborCache {
  private available = true;
  private warned = false;

  constructor(private log: (msg: string) => void) {}

  async snapshot(): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    if (!this.available) return map;
    try {
      const v6 = await this.runIpNeigh("-6");
      const v4 = await this.runIpNeigh("-4");
      this.parse(v6, map, { skipLinkLocal: true });
      this.parse(v4, map, { skipLinkLocal: false });
    } catch (e) {
      if (!this.warned) {
        this.log(`[neigh] kernel neighbor cache unavailable — IPv6 enrichment disabled (${String(e).slice(0, 120)})`);
        this.warned = true;
      }
      this.available = false;
    }
    return map;
  }

  private async runIpNeigh(family: "-4" | "-6"): Promise<string> {
    const { stdout } = await execFileAsync("ip", [family, "neigh", "show"], {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  }

  /**
   * Lines look like:
   *   2a01:cb05::1234 dev enp0s5 lladdr 00:e0:4c:b0:a5:aa router STALE
   *   fe80::aabb:ccdd:eeff:0011 dev enp0s5 lladdr aa:bb:cc:dd:ee:ff STALE
   *   192.168.1.42 dev enp0s5 lladdr aa:bb:cc:dd:ee:ff REACHABLE
   * We accept REACHABLE/STALE/DELAY/PROBE, skip FAILED and INCOMPLETE (no MAC
   * observed). Link-local IPv6 is skipped for client ids — it adds noise
   * without helping AGH match DNS source addresses.
   */
  private parse(
    raw: string,
    map: Map<string, Set<string>>,
    opts: { skipLinkLocal: boolean },
  ): void {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/\b(FAILED|INCOMPLETE|NOARP|PERMANENT)\b/.test(trimmed)) continue;

      const match = trimmed.match(/^(\S+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})\b/i);
      if (!match) continue;

      const ip = match[1];
      const mac = match[2].toLowerCase();
      if (opts.skipLinkLocal && ip.toLowerCase().startsWith("fe80:")) continue;

      let set = map.get(mac);
      if (!set) {
        set = new Set();
        map.set(mac, set);
      }
      set.add(ip);
    }
  }
}
