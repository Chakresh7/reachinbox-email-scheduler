import type { ConnectionOptions } from "bullmq";
import { env } from "../config/env";
import { redis } from "../lib/redis";

/**
 * BullMQ connection options.
 *
 * Queue producers share the existing ioredis client (commands only). Workers
 * must not: a Worker issues blocking commands and BullMQ duplicates the
 * connection internally, which is why createWorkerConnection exists.
 */
export const queuePrefix = env.REDIS_PREFIX;

export const sharedQueueConnection = redis;

/** Options object form, used when a Worker needs a dedicated blocking connection. */
export function workerConnectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}
