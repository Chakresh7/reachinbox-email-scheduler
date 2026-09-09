import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config/env";
import { childLogger } from "./logger";

/**
 * Redis connections.
 *
 * Redis holds the scheduling state (BullMQ delayed sets) and the rate-limit
 * counters, so two properties are non-negotiable and both are enforced here
 * rather than left to documentation.
 *
 * 1. `maxRetriesPerRequest: null` and `enableReadyCheck: false` — BullMQ
 *    requires these. Its blocking commands (BRPOPLPUSH) legitimately sit open
 *    for seconds, and ioredis' default retry limit would abort them.
 *
 * 2. `maxmemory-policy` must be `noeviction`. Under any `allkeys-*` policy
 *    Redis is free to evict an entry from a BullMQ delayed set, which silently
 *    destroys a scheduled email with no error anywhere. Boot fails instead.
 *
 * Connection budget matters on a managed free tier (Redis Cloud allows 30).
 * BullMQ opens a *separate* blocking connection per Worker and per QueueEvents,
 * so `Queue` instances are all given this one shared client, and the live count
 * is logged at boot to make an approaching limit visible.
 */

const log = childLogger("redis");

export const baseRedisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Fail fast on a wrong host/password rather than retrying silently forever.
  connectTimeout: 15_000,
  retryStrategy: (times: number) => {
    if (times > 20) {
      log.error({ attempts: times }, "redis retry limit reached; giving up on this connection");
      return null;
    }
    // 50ms, 100ms, ... capped at 3s.
    return Math.min(times * 50, 3000);
  },
  reconnectOnError: (err: Error) => {
    // A failover can leave the connection talking to a read-only replica.
    if (err.message.includes("READONLY")) {
      log.warn("redis reported READONLY; reconnecting");
      return true;
    }
    return false;
  },
};

function createConnection(role: string): Redis {
  const connection = new Redis(env.REDIS_URL, baseRedisOptions);

  connection.on("error", (err: Error) => log.error({ err, role }, "redis connection error"));
  connection.on("reconnecting", (delay: number) =>
    log.warn({ delay, role }, "redis reconnecting"),
  );
  connection.on("end", () => log.warn({ role }, "redis connection closed"));

  return connection;
}

/**
 * Shared client for commands, Lua scripts and every BullMQ `Queue`.
 * Workers get their own via `createWorkerConnection` because their blocking
 * reads cannot share a client with ordinary commands.
 */
export const redis: Redis = createConnection("shared");

/** Dedicated connection for a BullMQ Worker or QueueEvents instance. */
export function createWorkerConnection(role: string): Redis {
  return createConnection(role);
}

export interface RedisReadiness {
  latencyMs: number;
  maxmemoryPolicy: string | null;
  clientCount: number | null;
}

/** Round-trip ping used by /readyz. Returns latency in milliseconds. */
export async function pingRedis(): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await redis.ping();
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

/**
 * Reads `maxmemory-policy`. Returns null when the provider blocks CONFIG GET,
 * which some managed tiers do — that is a "cannot verify", not a failure.
 */
export async function getMaxmemoryPolicy(): Promise<string | null> {
  try {
    const result = (await redis.config("GET", "maxmemory-policy")) as unknown;
    // Reply is a flat [name, value] array, or an object on RESP3.
    if (Array.isArray(result)) {
      return typeof result[1] === "string" ? result[1] : null;
    }
    if (result && typeof result === "object") {
      const value = (result as Record<string, unknown>)["maxmemory-policy"];
      return typeof value === "string" ? value : null;
    }
    return null;
  } catch (err) {
    log.debug({ err }, "CONFIG GET maxmemory-policy is not permitted on this Redis");
    return null;
  }
}

/** Live client count, to keep an eye on a managed tier's connection cap. */
export async function getClientCount(): Promise<number | null> {
  try {
    const list = await redis.client("LIST");
    if (typeof list !== "string") return null;
    return list.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (err) {
    log.debug({ err }, "CLIENT LIST is not permitted on this Redis");
    return null;
  }
}

/**
 * Boot-time verification. Aborts the process on an eviction policy that could
 * discard scheduled jobs, because the failure it prevents is invisible: emails
 * simply never send, with nothing in any log to explain why.
 */
export async function assertRedisReady(): Promise<RedisReadiness> {
  const latencyMs = await pingRedis();
  const [maxmemoryPolicy, clientCount] = await Promise.all([
    getMaxmemoryPolicy(),
    getClientCount(),
  ]);

  if (maxmemoryPolicy === null) {
    log.warn(
      "could not read maxmemory-policy (provider restriction). Ensure eviction is disabled: " +
        "an evicted BullMQ delayed-set entry silently loses a scheduled email.",
    );
  } else if (maxmemoryPolicy !== "noeviction") {
    const message =
      `Redis maxmemory-policy is "${maxmemoryPolicy}", but this service requires "noeviction". ` +
      "Any allkeys-* policy lets Redis evict BullMQ delayed-set entries, which silently " +
      "destroys scheduled emails. Fix the policy, or set REDIS_ASSERT_NOEVICTION=false to " +
      "override deliberately.";

    if (env.REDIS_ASSERT_NOEVICTION) {
      log.fatal({ maxmemoryPolicy }, message);
      throw new Error(message);
    }
    log.warn({ maxmemoryPolicy }, `${message} (assertion disabled)`);
  }

  log.info(
    {
      latencyMs: Math.round(latencyMs * 100) / 100,
      maxmemoryPolicy: maxmemoryPolicy ?? "unknown",
      clientCount: clientCount ?? "unknown",
      keyPrefix: env.REDIS_PREFIX,
    },
    "redis ready",
  );

  return { latencyMs, maxmemoryPolicy, clientCount };
}

export async function disconnectRedis(): Promise<void> {
  // `quit` waits for pending replies; `disconnect` would drop them.
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
  log.info("redis connection closed");
}
