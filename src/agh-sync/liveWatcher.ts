import type { AdGuardHomeClient } from "./aghClient.js";
import type { Reconciler } from "./reconciler.js";

export class LiveWatcher {
  private timer: NodeJS.Timeout | null = null;
  private previousIps = new Set<string>();
  private running = false;

  constructor(
    private agh: AdGuardHomeClient,
    private reconciler: Reconciler,
    private intervalMs: number,
    private log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => {
      if (!this.running) this.tick().catch(() => {});
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    this.running = true;
    try {
      const snapshot = await this.agh.listClients();
      const currentIps = new Set<string>();
      for (const auto of snapshot.auto_clients ?? []) {
        if (auto.ip) currentIps.add(auto.ip);
      }

      if (this.previousIps.size === 0) {
        this.previousIps = currentIps;
        return;
      }

      const newIps: string[] = [];
      for (const ip of currentIps) {
        if (!this.previousIps.has(ip)) newIps.push(ip);
      }
      this.previousIps = currentIps;

      for (const ip of newIps) {
        try {
          const changed = await this.reconciler.enrichByIp(ip);
          if (!changed) {
            this.log(`[live] ${ip} — no Freebox match or no change`);
          }
        } catch (e) {
          this.log(`[live] enrich ${ip} failed: ${String(e)}`);
        }
      }
    } catch (e) {
      this.log(`[live] poll failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
