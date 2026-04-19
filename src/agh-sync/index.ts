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
import { AnomalyDetector } from "./anomalyDetector.js";
import { AnomalyStateStore } from "./anomalyState.js";
import { BypassDetector } from "./bypassDetector.js";
import { HealthServer } from "./healthServer.js";
import { IsolationManager } from "./isolationManager.js";
import { LiveWatcher } from "./liveWatcher.js";
import { NeighborCache } from "./neighborDiscovery.js";
import { Reconciler } from "./reconciler.js";
import { StateStore } from "./state.js";
import type { FreeboxLanHostsResponse } from "./types.js";

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
  const anomalyStatePath = process.env.ANOMALY_STATE_FILE ?? "/app/data/anomaly_state.json";
  const healthPort = envNum("HEALTH_PORT", 8090);
  const healthBind = process.env.HEALTH_BIND ?? "0.0.0.0";
  const bypassAllowlist = parseMacList(process.env.BYPASS_ALLOWLIST);
  const autoIsolateEnabled = (process.env.AUTO_ISOLATE_ENABLED ?? "false").toLowerCase() === "true";
  const autoIsolateScoreThreshold = envNum("AUTO_ISOLATE_SCORE_THRESHOLD", 60);
  const isolationDurationHours = envNum("ISOLATION_DURATION_HOURS", 2);
  const isolationStatePath = process.env.ISOLATION_STATE_FILE ?? "/app/data/isolation_state.json";
  const isolationApiKey = process.env.ISOLATION_API_KEY ?? null;
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

  const isolation = new IsolationManager(
    freebox,
    {
      envAllowlistSeed: bypassAllowlist,
      autoEnabled: autoIsolateEnabled,
      autoScoreThreshold: autoIsolateScoreThreshold,
      defaultDurationSec: isolationDurationHours * 3600,
      statePath: isolationStatePath,
    },
    (m) => logger.info(m),
  );
  health.attachIsolation(isolation, isolationApiKey);
  health.attachAgh(agh);
  health.start(healthPort, healthBind);
  if (!isolationApiKey) {
    logger.warn("ISOLATION_API_KEY not set — /isolate and /unisolate endpoints will reject all writes");
  }
  logger.info(
    `[isolation] config allowlist=${bypassAllowlist.size} auto=${autoIsolateEnabled} threshold=${autoIsolateScoreThreshold} duration=${isolationDurationHours}h`,
  );

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
  const bypassDetector = new BypassDetector(agh, state, (m) => logger.info(m));
  const anomalyState = new AnomalyStateStore(anomalyStatePath);
  const anomalyDetector = new AnomalyDetector(agh, state, anomalyState, (m) => logger.info(m), isolation);

  let lastAnomalyLogAt = 0;
  const runAnomalyDetection = async () => {
    try {
      const neighSnap = await neighbors.snapshot();
      await anomalyDetector.updateIpMap(neighSnap);
      const metrics = await anomalyDetector.run();
      health.recordMetrics(metrics);
      const nowMs = Date.now();
      if (metrics.anomalyCount > 0 && nowMs - lastAnomalyLogAt > 3600_000) {
        const top = metrics.anomalies.slice(0, 5).map((a) =>
          `${a.name ?? a.mac}(score=${a.score},${a.signals.join("|")})`,
        ).join(", ");
        logger.warn(
          `[anomaly] ${metrics.anomalyCount} device(s) flagged — top: ${top}${metrics.anomalyCount > 5 ? " +more" : ""}`,
        );
        lastAnomalyLogAt = nowMs;
      }
    } catch (e) {
      logger.warn(`[anomaly] detection failed: ${String(e)}`);
    }
  };

  let lastBypassLogAt = 0;
  const runBypassDetection = async () => {
    try {
      const lanResp = (await freebox.getLanHosts({ compact: false, limit: 0 })) as FreeboxLanHostsResponse;
      const suspects = await bypassDetector.detect(lanResp.hosts);
      health.recordBypassers(suspects);
      const nowMs = Date.now();
      if (suspects.length > 0 && nowMs - lastBypassLogAt > 86400000) {
        const summary = suspects
          .slice(0, 10)
          .map((s) => `${s.aghName ?? s.mac} (${s.mac})`)
          .join(", ");
        logger.warn(
          `[bypass] ${suspects.length} device(s) active on LAN but not querying AGH in 24h: ${summary}${suspects.length > 10 ? " +more" : ""}`,
        );
        lastBypassLogAt = nowMs;
      }
    } catch (e) {
      logger.warn(`[bypass] detection failed: ${String(e)}`);
    }
  };

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
  await runBypassDetection();
  await runAnomalyDetection();
  liveWatcher.start();
  const reconcileTimer = setInterval(async () => {
    await runReconcile("");
    await runBypassDetection();
    await runAnomalyDetection();
    isolation.cleanupExpired();
  }, pollReconcileMs);

  const shutdown = (sig: string) => {
    logger.info(`received ${sig}, shutting down`);
    liveWatcher.stop();
    clearInterval(reconcileTimer);
    health.stop();
    state.save();
    anomalyState.save();
    isolation.save();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  process.stderr.write(`[agh-sync] fatal: ${String(e)}\n`);
  process.exit(1);
});
