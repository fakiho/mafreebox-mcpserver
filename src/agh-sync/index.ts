#!/usr/bin/env node
/**
 * freebox-mcp agh-sync — long-running sidecar that pushes Freebox device names
 * and metadata into AdGuard Home persistent clients.
 *
 * Two loops:
 *   - live (default 3s)     : watch AGH auto_clients for new IPs, enrich immediately
 *   - reconcile (default 5m): full Freebox scan, upsert all managed clients
 *
 * Safety : only touches AGH clients tagged "freebox-sync". User-created
 * persistent clients are never modified or deleted.
 */

import { FreeboxClient } from "../freeboxClient.js";
import { AdGuardHomeClient } from "./aghClient.js";
import { HealthServer } from "./healthServer.js";
import { LiveWatcher } from "./liveWatcher.js";
import { NeighborCache } from "./neighborDiscovery.js";
import { Reconciler } from "./reconciler.js";
import { StateStore } from "./state.js";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`[agh-sync] missing required env ${name}\n`);
    process.exit(1);
  }
  return v;
}

function parseMacList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/-/g, ":"))
      .filter((s) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)),
  );
}

function makeLogger(level: LogLevel) {
  const threshold = LOG_LEVELS.indexOf(level);
  const emit = (lvl: LogLevel, msg: string) => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [${lvl}] ${msg}\n`);
  };
  return {
    debug: (m: string) => emit("debug", m),
    info: (m: string) => emit("info", m),
    warn: (m: string) => emit("warn", m),
    error: (m: string) => emit("error", m),
  };
}

async function main() {
  const freeboxHost = process.env.FREEBOX_HOST ?? "mafreebox.freebox.fr";
  const appId = process.env.FREEBOX_APP_ID ?? "fr.freebox.agh-sync";
  const aghUrl = envRequired("AGH_URL");
  const aghUser = envRequired("AGH_USER");
  const aghPass = envRequired("AGH_PASS");
  const pollLiveMs = envNum("POLL_LIVE_MS", 3000);
  const pollReconcileMs = envNum("POLL_RECONCILE_MS", 300000);
  const retentionDays = envNum("RETENTION_DAYS", 30);
  const excludeMacs = parseMacList(process.env.EXCLUDE_MACS);
  const statePath = process.env.SYNC_STATE_FILE ?? "/app/data/sync_state.json";
  const healthPort = envNum("HEALTH_PORT", 8090);
  const healthBind = process.env.HEALTH_BIND ?? "0.0.0.0";
  const logLevel = ((process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel);
  const level: LogLevel = LOG_LEVELS.includes(logLevel) ? logLevel : "info";
  const logger = makeLogger(level);

  logger.info(
    `starting agh-sync freebox=${freeboxHost} agh=${aghUrl} live=${pollLiveMs}ms reconcile=${pollReconcileMs}ms retention=${retentionDays}d exclude=${excludeMacs.size}`,
  );

  const freebox = new FreeboxClient({
    host: freeboxHost,
    appId,
    appName: "Freebox AGH Sync",
    appVersion: "1.0.0",
    deviceName: "agh-sync",
  });

  if (!freebox.isAuthorized()) {
    logger.error(
      `no Freebox token — run 'node dist/agh-sync/authorize.js' once (press ">" on Freebox LCD when prompted)`,
    );
    process.exit(2);
  }

  try {
    await freebox.openSession();
    logger.info("freebox session OK");
  } catch (e) {
    logger.error(`freebox auth failed: ${String(e)}`);
    process.exit(2);
  }

  const agh = new AdGuardHomeClient({ baseUrl: aghUrl, user: aghUser, pass: aghPass });
  const reachable = await agh.ping();
  if (!reachable) {
    logger.error(`AdGuard Home unreachable at ${aghUrl} (check AGH_URL / AGH_USER / AGH_PASS)`);
    process.exit(3);
  }
  logger.info("agh reachable");

  const state = new StateStore(statePath);
  const neighbors = new NeighborCache((m) => logger.info(m));
  const health = new HealthServer((m) => logger.info(m));
  health.markFreebox(true);
  health.markAgh(true);
  health.start(healthPort, healthBind);

  const errorLogger = (m: string) => {
    logger.error(m);
    health.recordError(m);
  };
  const reconciler = new Reconciler(
    freebox,
    agh,
    state,
    { retentionDays, excludeMacs },
    (m) => logger.info(m),
    neighbors,
  );
  const liveWatcher = new LiveWatcher(agh, reconciler, pollLiveMs, (m) => logger.info(m));

  const runReconcile = async (label: string) => {
    try {
      const res = await reconciler.reconcile();
      logger.info(
        `[reconcile] ${label}added=${res.added} adopted=${res.adopted} updated=${res.updated} deleted=${res.deleted} unchanged=${res.unchanged}`,
      );
      health.recordReconcile(res, state.macs().length);
      health.markFreebox(true);
      health.markAgh(true);
    } catch (e) {
      const msg = String(e);
      errorLogger(`reconcile failed: ${msg}`);
      if (msg.includes("ECONNREFUSED") || msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
        health.markAgh(false);
      }
      if (msg.toLowerCase().includes("freebox")) {
        health.markFreebox(false);
      }
    }
  };

  await runReconcile("startup: ");
  liveWatcher.start();
  const reconcileTimer = setInterval(() => runReconcile(""), pollReconcileMs);

  const shutdown = (sig: string) => {
    logger.info(`received ${sig}, shutting down`);
    liveWatcher.stop();
    clearInterval(reconcileTimer);
    health.stop();
    state.save();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  process.stderr.write(`[agh-sync] fatal: ${String(e)}\n`);
  process.exit(1);
});
