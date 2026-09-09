/**
 * Standalone connectivity check: `npm run check:deps`
 *
 * Verifies Postgres, Redis and Elasticsearch independently of the HTTP server,
 * so a credential problem can be diagnosed without starting the API. Prints a
 * readable table and exits non-zero if a critical dependency is unreachable.
 */

import { env } from "../config/env";
import { disconnectElasticsearch, getElasticsearchInfo, isSearchConfigured } from "../lib/elasticsearch";
import { errorMessage } from "../lib/errors";
import { disconnectPrisma, pingPostgres, postgresPoolMax } from "../lib/prisma";
import { disconnectRedis, getClientCount, getMaxmemoryPolicy, pingRedis } from "../lib/redis";

interface Result {
  name: string;
  ok: boolean;
  critical: boolean;
  detail: string;
}

function fmt(ms: number): string {
  return `${Math.round(ms * 100) / 100}ms`;
}

async function main(): Promise<void> {
  const results: Result[] = [];

  // ── Postgres ──
  try {
    const latency = await pingPostgres();
    results.push({
      name: "Postgres",
      ok: true,
      critical: true,
      detail: `${fmt(latency)}, pool max ${postgresPoolMax}`,
    });
  } catch (err) {
    results.push({ name: "Postgres", ok: false, critical: true, detail: errorMessage(err) });
  }

  // ── Redis ──
  try {
    const latency = await pingRedis();
    const [policy, clients] = await Promise.all([getMaxmemoryPolicy(), getClientCount()]);
    const evictionUnsafe = policy !== null && policy !== "noeviction";
    results.push({
      name: "Redis",
      ok: !evictionUnsafe,
      critical: true,
      detail: evictionUnsafe
        ? `reachable (${fmt(latency)}) but maxmemory-policy is "${policy}"; must be "noeviction"`
        : `${fmt(latency)}, policy ${policy ?? "unknown"}, ${clients ?? "?"} clients connected`,
    });
  } catch (err) {
    results.push({ name: "Redis", ok: false, critical: true, detail: errorMessage(err) });
  }

  // ── Elasticsearch ──
  if (!isSearchConfigured) {
    results.push({
      name: "Elasticsearch",
      ok: true,
      critical: false,
      detail: "not configured; search falls back to Postgres",
    });
  } else {
    try {
      const info = await getElasticsearchInfo();
      results.push({
        name: "Elasticsearch",
        ok: true,
        critical: false,
        detail: `cluster ${info.clusterName}, version ${info.version}`,
      });
    } catch (err) {
      results.push({
        name: "Elasticsearch",
        ok: false,
        critical: false,
        detail: errorMessage(err),
      });
    }
  }

  // ── Report ──
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log(`\nDependency check (${env.NODE_ENV})\n`);
  for (const r of results) {
    const icon = r.ok ? "OK  " : r.critical ? "FAIL" : "WARN";
    console.log(`  [${icon}] ${r.name.padEnd(pad)}  ${r.detail}`);
  }
  console.log("");

  const criticalFailure = results.some((r) => !r.ok && r.critical);

  await Promise.allSettled([disconnectPrisma(), disconnectRedis(), disconnectElasticsearch()]);
  process.exit(criticalFailure ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error("dependency check crashed:", errorMessage(err));
  process.exit(1);
});
