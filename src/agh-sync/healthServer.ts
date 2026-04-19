import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { IsolationError, type IsolationManager } from "./isolationManager.js";
import type { MetricsSnapshot } from "./types.js";

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
  suspectedBypassers: Array<{
    mac: string;
    aghName: string | null;
    lastActiveFreebox: number;
    ips: string[];
  }>;
  bypassLastComputedAt: number;
  metrics: MetricsSnapshot | null;
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
  private isolation: IsolationManager | null = null;
  private isolationApiKey: string | null = null;
  private state: HealthState = {
    startedAt: Date.now(),
    freeboxReachable: false,
    aghReachable: false,
    lastReconcileAt: 0,
    lastReconcileCounts: { added: 0, adopted: 0, updated: 0, deleted: 0, unchanged: 0 },
    managedMacs: 0,
    recentErrors: [],
    suspectedBypassers: [],
    bypassLastComputedAt: 0,
    metrics: null,
  };

  constructor(private log: (msg: string) => void) {}

  attachIsolation(manager: IsolationManager, apiKey: string | null): void {
    this.isolation = manager;
    this.isolationApiKey = apiKey;
  }

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

  recordBypassers(list: HealthState["suspectedBypassers"]): void {
    this.state.suspectedBypassers = list;
    this.state.bypassLastComputedAt = Date.now();
  }

  recordMetrics(m: MetricsSnapshot): void {
    this.state.metrics = m;
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
      suspectedBypassers: this.state.suspectedBypassers,
      suspectedBypasserCount: this.state.suspectedBypassers.length,
      bypassLastComputedAt: this.state.bypassLastComputedAt
        ? new Date(this.state.bypassLastComputedAt).toISOString()
        : null,
      anomalyCount: this.state.metrics?.anomalyCount ?? 0,
      anomalyGeneratedAt: this.state.metrics?.generatedAt ?? null,
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
    if (req.url === "/metrics") {
      const body = JSON.stringify(this.state.metrics ?? { anomalyCount: 0, anomalies: [] }, null, 2);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/isolations") {
      this.handleListIsolations(res);
      return;
    }
    if (req.method === "POST" && req.url === "/isolate") {
      this.handleIsolate(req, res).catch((e) => this.replyError(res, 500, `internal: ${String(e)}`));
      return;
    }
    if (req.method === "POST" && req.url === "/unisolate") {
      this.handleUnisolate(req, res).catch((e) => this.replyError(res, 500, `internal: ${String(e)}`));
      return;
    }
    if (req.method === "GET" && req.url === "/allowlist") {
      this.handleListAllowlist(res);
      return;
    }
    if (req.method === "POST" && req.url === "/allowlist/add") {
      this.handleAllowlistMutate(req, res, "add").catch((e) => this.replyError(res, 500, `internal: ${String(e)}`));
      return;
    }
    if (req.method === "POST" && req.url === "/allowlist/remove") {
      this.handleAllowlistMutate(req, res, "remove").catch((e) => this.replyError(res, 500, `internal: ${String(e)}`));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
  }

  // ─── Isolation endpoints ──────────────────────────────────────────────

  private handleListIsolations(res: ServerResponse): void {
    if (!this.isolation) {
      this.replyError(res, 503, "isolation manager not attached");
      return;
    }
    const body = JSON.stringify({
      active: this.isolation.getActive(),
      config: this.isolation.getConfig(),
    }, null, 2);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
  }

  private async handleIsolate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isolation) return this.replyError(res, 503, "isolation manager not attached");
    if (!this.authorized(req)) return this.replyError(res, 403, "invalid or missing X-Isolation-Key header");
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch (e) {
      return this.replyError(res, 400, `bad JSON body: ${String(e)}`);
    }
    const mac = typeof body.mac === "string" ? body.mac : "";
    if (!mac) return this.replyError(res, 400, "missing `mac` field");
    const durationHours = typeof body.durationHours === "number" && body.durationHours > 0
      ? body.durationHours
      : null;
    const reason = typeof body.reason === "string" ? body.reason : "manual API request";
    const source = (body.source === "node-red-action" || body.source === "auto" || body.source === "manual-api")
      ? body.source
      : "manual-api" as const;
    const userConfirmed = body.userConfirmed === true;
    try {
      const record = await this.isolation.apply(mac, {
        durationSec: durationHours ? Math.floor(durationHours * 3600) : undefined,
        reason,
        source,
        userConfirmed,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, isolation: record }, null, 2));
    } catch (e) {
      if (e instanceof IsolationError) {
        const status = e.code === "allowlisted" ? 409
          : e.code === "bad_mac" ? 400
          : e.code === "confirmation_required" ? 409
          : 500;
        return this.replyError(res, status, e.message, e.code);
      }
      return this.replyError(res, 500, `internal: ${String(e)}`);
    }
  }

  private async handleUnisolate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isolation) return this.replyError(res, 503, "isolation manager not attached");
    if (!this.authorized(req)) return this.replyError(res, 403, "invalid or missing X-Isolation-Key header");
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch (e) {
      return this.replyError(res, 400, `bad JSON body: ${String(e)}`);
    }
    const mac = typeof body.mac === "string" ? body.mac : "";
    if (!mac) return this.replyError(res, 400, "missing `mac` field");
    try {
      const existed = await this.isolation.revoke(mac);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, existed }, null, 2));
    } catch (e) {
      if (e instanceof IsolationError) {
        const status = e.code === "bad_mac" ? 400 : 500;
        return this.replyError(res, status, e.message, e.code);
      }
      return this.replyError(res, 500, `internal: ${String(e)}`);
    }
  }

  private handleListAllowlist(res: ServerResponse): void {
    if (!this.isolation) return this.replyError(res, 503, "isolation manager not attached");
    const body = JSON.stringify({
      allowlist: this.isolation.listAllowlist(),
    }, null, 2);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
  }

  private async handleAllowlistMutate(req: IncomingMessage, res: ServerResponse, op: "add" | "remove"): Promise<void> {
    if (!this.isolation) return this.replyError(res, 503, "isolation manager not attached");
    if (!this.authorized(req)) return this.replyError(res, 403, "invalid or missing X-Isolation-Key header");
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch (e) {
      return this.replyError(res, 400, `bad JSON body: ${String(e)}`);
    }
    const mac = typeof body.mac === "string" ? body.mac : "";
    if (!mac) return this.replyError(res, 400, "missing `mac` field");
    try {
      if (op === "add") {
        const { added, revokedIsolation } = await this.isolation.addToAllowlist(mac);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, added, revokedIsolation, allowlist: this.isolation.listAllowlist() }, null, 2));
      } else {
        const removed = this.isolation.removeFromAllowlist(mac);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, removed, allowlist: this.isolation.listAllowlist() }, null, 2));
      }
    } catch (e) {
      if (e instanceof IsolationError) {
        const status = e.code === "bad_mac" ? 400 : 500;
        return this.replyError(res, status, e.message, e.code);
      }
      return this.replyError(res, 500, `internal: ${String(e)}`);
    }
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.isolationApiKey) return false; // require explicit key
    const header = req.headers["x-isolation-key"];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === "string" && value === this.isolationApiKey;
  }

  private replyError(res: ServerResponse, status: number, message: string, code?: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message, code: code ?? null }));
  }

  private readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX_BODY = 64 * 1024;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY) {
          req.destroy();
          reject(new Error("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return resolve({});
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null) {
            return reject(new Error("body must be a JSON object"));
          }
          resolve(parsed as Record<string, unknown>);
        } catch (e) {
          reject(e as Error);
        }
      });
      req.on("error", reject);
    });
  }
}
