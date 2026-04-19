#!/usr/bin/env node
/**
 * One-shot helper: get the agh-sync its own Freebox app_token.
 *
 * Usage (typical):
 *   docker exec -it agh-sync node dist/agh-sync/authorize.js
 *
 * Flow: requests an app_token → prompts user to press ">" on Freebox LCD →
 * polls until granted → writes token file, exits.
 */

import { FreeboxClient } from "../freeboxClient.js";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const host = process.env.FREEBOX_HOST ?? "mafreebox.freebox.fr";
  const appId = process.env.FREEBOX_APP_ID ?? "fr.freebox.agh-sync";

  const client = new FreeboxClient({
    host,
    appId,
    appName: "Freebox AGH Sync",
    appVersion: "1.0.0",
    deviceName: "agh-sync",
  });

  process.stdout.write(`[authorize] host=${host} app=${appId}\n`);
  const start = await client.startAuthorization();

  if (start.alreadyAuthorized) {
    process.stdout.write(`[authorize] already authorized — token file is valid, nothing to do.\n`);
    return;
  }

  process.stdout.write(
    `[authorize] request sent (track_id=${start.trackId}). Press ">" on your Freebox LCD within 30s.\n`,
  );

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      const status = await client.checkAuthorizationStatus(start.trackId);
      process.stdout.write(`[authorize] status=${status.status}\n`);
      if (status.status === "granted") {
        await client.openSession();
        process.stdout.write(`[authorize] ✅ granted — token saved. You can start the sync service now.\n`);
        return;
      }
      if (status.status === "denied" || status.status === "timeout") {
        process.stdout.write(`[authorize] ❌ ${status.status}. Rerun this command to try again.\n`);
        process.exit(1);
      }
    } catch (e) {
      process.stdout.write(`[authorize] poll error: ${String(e)}\n`);
    }
  }

  process.stdout.write(`[authorize] timed out waiting for LCD approval.\n`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`[authorize] fatal: ${String(e)}\n`);
  process.exit(1);
});
