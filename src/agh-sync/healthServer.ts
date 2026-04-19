import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";

interface HealthState {
  startedAt: number;
  freeboxReachable: boolean;
  aghReachable: boolean;
  lastReconcileAt: number;
  lastReconcileCounts: {
    added: number;
    adopted: number;
    updated: number;
    deleted: number;
    unchanged: number;
  };
  managedMacs: number;
  recentErrors: Array<{ ts: number; msg: string }>;
}

/**
 * Small HTTP server exposing a JSON health endpoint for external monitors
 * (Uptime Kuma, Glances, Docker HEALTHCHECK, etc.).
 *
 *   GET  /healthz  →  200 if healthy, 503 if degraded, JSON body either way
 *   GET  /         →  same as /healthz (convenience)
 *
 * Bound on HEALTH_PORT (default 8090). Because the container runs with
 * network_mode: host, the endpoint is reachable from the LAN at
 * http://<vm-ip>:8090/healthz.
 */
export class HealthServer {
  private server: Server | null = null;
  private state: HealthState = {
    startedAt: Date.now(),
    freeboxReachable: false,
    aghReachable: false,
    lastReconcileAt: 0,
    lastReconcileCounts: { added: 0, adopted: 0, updated: 0, deleted: 0, unchanged: 0 },
    managedMacs: 0,
    recentErrors: [],
  };

  constructor(private log: (msg: string) => void) {}

  start(port: number, host = "0.0.0.0"): void {
    if (this.server) return;
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on("error", (e) => this.log(`[health] listen error: ${String(e)}`));
    this.server.listen(port, host, () => {
      this.log(`[health] listening on ${host}:${port}/healthz`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  markFreebox(ok: boolean): void {
    this.state.freeboxReachable = ok;
  }

  markAgh(ok: boolean): void {
    this.state.aghReachable = ok;
  }

  recordReconcile(counts: HealthState["lastReconcileCounts"], managedMacs: number): void {
    this.state.lastReconcileAt = Date.now();
    this.state.lastReconcileCounts = counts;
    this.state.managedMacs = managedMacs;
  }

  recordError(msg: string): void {
    const now = Date.now();
    this.state.recentErrors.push({ ts: now, msg: msg.slice(0, 240) });
    // Keep last 20 errors OR last 15min, whichever is smaller.
    const cutoff = now - 15 * 60 * 1000;
    this.state.recentErrors = this.state.recentErrors
      .filter((e) => e.ts >= cutoff)
      .slice(-20);
  }

  private snapshot() {
    const now = Date.now();
    const reconcileAgeSec = this.state.lastReconcileAt
      ? Math.floor((now - this.state.lastReconcileAt) / 1000)
      : null;
    const errors5m = this.state.recentErrors.filter((e) => now - e.ts < 5 * 60 * 1000);
    // Healthy iff: both upstreams reachable, a reconcile happened within last
    // 15 min (generous bound past the 5m reconcile cadence), <5 errors in 5m.
    const healthy =
      this.state.freeboxReachable &&
      this.state.aghReachable &&
      (reconcileAgeSec === null ? false : reconcileAgeSec < 900) &&
      errors5m.length < 5;
    return {
      ok: healthy,
      uptimeSec: Math.floor((now - this.state.startedAt) / 1000),
      freeboxReachable: this.state.freeboxReachable,
      aghReachable: this.state.aghReachable,
      lastReconcileAt: this.state.lastReconcileAt
        ? new Date(this.state.lastReconcileAt).toISOString()
        : null,
      lastReconcileAgeSec: reconcileAgeSec,
      lastReconcileCounts: this.state.lastReconcileCounts,
      managedMacs: this.state.managedMacs,
      errorsLast5m: errors5m.length,
      recentErrors: errors5m.map((e) => ({
        ageSec: Math.floor((now - e.ts) / 1000),
        msg: e.msg,
      })),
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!req.url) {
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/" || req.url === "/healthz") {
      const snap = this.snapshot();
      const body = JSON.stringify(snap, null, 2);
      res.writeHead(snap.ok ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
  }
}
