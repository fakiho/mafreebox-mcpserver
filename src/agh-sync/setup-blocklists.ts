#!/usr/bin/env node
/**
 * One-shot helper: adds anti-bypass blocklists to AdGuard Home.
 *
 * Specifically enrolls:
 *  - Hagezi's DoH list (blocks domain resolution for public DoH providers)
 *  - Hagezi's DoH/VPN/Proxy bypass list (stricter — includes parental-bypass
 *    VPN and proxy providers)
 *
 * These help against IoT devices that try to bypass AGH by querying
 * cloudflare-dns.com, dns.google, etc. directly via DoH. They do NOT stop
 * devices that hardcode raw IPs (8.8.8.8, 1.1.1.1) — that requires firewall
 * rules upstream.
 *
 * Idempotent: skips URLs already present in AGH's filter list.
 *
 * Usage:
 *   docker compose run --rm agh-sync node dist/agh-sync/setup-blocklists.js
 */

import { AdGuardHomeClient } from "./aghClient.js";

interface BlocklistEntry {
  name: string;
  url: string;
}

const DEFAULT_BLOCKLISTS: BlocklistEntry[] = [
  {
    name: "Hagezi — DoH bypass blocklist",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/doh.txt",
  },
  {
    name: "Hagezi — DoH/VPN/Proxy bypass (stricter)",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/doh-vpn-proxy-bypass.txt",
  },
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing required env ${name}\n`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const agh = new AdGuardHomeClient({
    baseUrl: env("AGH_URL"),
    user: env("AGH_USER"),
    pass: env("AGH_PASS"),
  });

  process.stdout.write(`[blocklists] fetching current filter list from ${env("AGH_URL")}\n`);
  const status = await agh.getFilteringStatus();
  const existing = new Set((status.filters ?? []).map((f) => f.url));
  process.stdout.write(`[blocklists] currently ${existing.size} filter list(s) enrolled\n`);

  let added = 0;
  for (const entry of DEFAULT_BLOCKLISTS) {
    if (existing.has(entry.url)) {
      process.stdout.write(`[blocklists] • already present: ${entry.name}\n`);
      continue;
    }
    try {
      await agh.addFilterUrl(entry);
      process.stdout.write(`[blocklists] + added: ${entry.name}\n                 ${entry.url}\n`);
      added++;
    } catch (e) {
      process.stdout.write(`[blocklists] ✗ failed to add ${entry.name}: ${String(e)}\n`);
    }
  }

  if (added > 0) {
    process.stdout.write(`[blocklists] triggering AGH to refresh filter sources…\n`);
    try {
      await agh.refreshFilters(false);
      process.stdout.write(`[blocklists] ✅ refresh triggered — AGH is downloading rules now\n`);
    } catch (e) {
      process.stdout.write(`[blocklists] refresh call failed: ${String(e)} (lists still enrolled; AGH will refresh on its own interval)\n`);
    }
  } else {
    process.stdout.write(`[blocklists] nothing to do — all lists already enrolled\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`[blocklists] fatal: ${String(e)}\n`);
  process.exit(1);
});
