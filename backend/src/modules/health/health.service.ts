import { env } from "../../config/env";
import { isSearchConfigured, pingElasticsearch } from "../../lib/elasticsearch";
import { errorMessage } from "../../lib/errors";
import { pingPostgres } from "../../lib/prisma";
import { getClientCount, getMaxmemoryPolicy, pingRedis } from "../../lib/redis";
import { readLastReconcile } from "../../bootstrap/reconcile";

/**
 * Dependency readiness.
 *
 * Postgres and Redis are critical: without either, the service cannot accept or
 * schedule an email, so it must report itself unready and be pulled from a load
 * balancer. Elasticsearch is explicitly non-critical — search degrades to a
 * Postgres query (DESIGN.md §12), so a red cluster must not take the API down.
 */

export type DependencyState = "ok" | "degraded" | "down" | "not_configured";

export interface DependencyReport {
  status: DependencyState;
  critical: boolean;
  latencyMs?: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ReadinessReport {
  status: "ok" | "degraded" | "unavailable";
  uptimeSeconds: number;
  version: string;
  environment: string;
  checkedAt: string;
  dependencies: {
    postgres: DependencyReport;
    redis: DependencyReport;
    elasticsearch: DependencyReport;
  };
}

const startedAt = Date.now();
const VERSION = "0.1.0";

/** Bounds a probe so one unreachable dependency cannot stall the whole check. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} probe timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PROBE_TIMEOUT_MS = 5000;

async function checkPostgres(): Promise<DependencyReport> {
  try {
    const latencyMs = await withTimeout(pingPostgres(), PROBE_TIMEOUT_MS, "postgres");
    return { status: "ok", critical: true, latencyMs: round(latencyMs) };
  } catch (err) {
    return { status: "down", critical: true, error: errorMessage(err) };
  }
}

async function checkRedis(): Promise<DependencyReport> {
  try {
    const latencyMs = await withTimeout(pingRedis(), PROBE_TIMEOUT_MS, "redis");
    const [maxmemoryPolicy, clientCount, lastReconcile] = await Promise.all([
      getMaxmemoryPolicy(),
      getClientCount(),
      readLastReconcile(),
    ]);

    // Reachable but misconfigured is worth surfacing: it will not fail a send
    // today, it will lose a scheduled job at some unpredictable point later.
    const evictionUnsafe = maxmemoryPolicy !== null && maxmemoryPolicy !== "noeviction";

    return {
      status: evictionUnsafe ? "degraded" : "ok",
      critical: true,
      latencyMs: round(latencyMs),
      detail: {
        maxmemoryPolicy: maxmemoryPolicy ?? "unknown",
        clientCount: clientCount ?? "unknown",
        ...(lastReconcile ? { lastReconcile } : {}),
      },
      ...(evictionUnsafe
        ? { error: `maxmemory-policy is "${maxmemoryPolicy}"; expected "noeviction"` }
        : {}),
    };
  } catch (err) {
    return { status: "down", critical: true, error: errorMessage(err) };
  }
}

async function checkElasticsearch(): Promise<DependencyReport> {
  if (!isSearchConfigured) {
    return { status: "not_configured", critical: false };
  }
  try {
    const latencyMs = await withTimeout(pingElasticsearch(), PROBE_TIMEOUT_MS, "elasticsearch");
    return { status: "ok", critical: false, latencyMs: round(latencyMs) };
  } catch (err) {
    return { status: "down", critical: false, error: errorMessage(err) };
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export async function getReadiness(): Promise<ReadinessReport> {
  // Probed in parallel: sequential checks would make the endpoint's latency the
  // sum of three timeouts in the worst case.
  const [postgres, redis, elasticsearch] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkElasticsearch(),
  ]);

  const dependencies = { postgres, redis, elasticsearch };
  const criticalDown = [postgres, redis].some((d) => d.status === "down");
  const anyDegraded = Object.values(dependencies).some(
    (d) => d.status === "degraded" || (d.status === "down" && !d.critical),
  );

  return {
    status: criticalDown ? "unavailable" : anyDegraded ? "degraded" : "ok",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    version: VERSION,
    environment: env.NODE_ENV,
    checkedAt: new Date().toISOString(),
    dependencies,
  };
}

export interface LivenessReport {
  status: "ok";
  uptimeSeconds: number;
  version: string;
  pid: number;
}

/** Liveness answers from the process alone; it must never touch a dependency. */
export function getLiveness(): LivenessReport {
  return {
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    version: VERSION,
    pid: process.pid,
  };
}
