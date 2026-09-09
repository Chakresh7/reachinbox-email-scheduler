import { installShutdownHandlers, onShutdown } from "./bootstrap/shutdown";
import { env } from "./config/env";
import { disconnectElasticsearch } from "./lib/elasticsearch";
import { childLogger } from "./lib/logger";
import { disconnectPrisma, pingPostgres } from "./lib/prisma";
import { assertRedisReady, disconnectRedis } from "./lib/redis";

/**
 * Worker entrypoint.
 *
 * A separate process from the API so the two scale independently, and so the
 * restart demo can stop and start the worker alone while the API keeps serving
 * the dashboard (DESIGN.md §1).
 *
 * Phase 0 boots, verifies dependencies and shuts down cleanly. Phase 1 attaches
 * the queues here:
 *   campaign-expand  fan-out of a campaign into per-recipient email_jobs
 *   email-send       claim, rate-limit, send via Ethereal
 *   search-index     Elasticsearch upserts
 *   notifications    Slack messages on rate-limit hits
 *
 * The BullMQ `Worker` registrations will each add a shutdown task calling
 * `worker.close()`, which waits for in-flight jobs — that wait is precisely
 * what keeps a send from being killed mid-SMTP.
 */

const log = childLogger("worker");

async function main(): Promise<void> {
  installShutdownHandlers();

  const postgresLatency = await pingPostgres();
  log.info({ latencyMs: Math.round(postgresLatency * 100) / 100 }, "postgres ready");

  await assertRedisReady();

  log.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      maxPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      maxPerHourGlobal: env.MAX_EMAILS_PER_HOUR,
      maxInlineWaitMs: env.MAX_INLINE_WAIT_MS,
      reconcileOnBoot: env.RECONCILE_ON_BOOT,
    },
    "worker configuration",
  );

  // Phase 1: register queue workers here, then the reconciler from
  // bootstrap/reconcile.ts, which repairs Redis from Postgres on boot.
  log.warn("no queues registered yet (Phase 1); worker is idle");

  onShutdown({ name: "prisma", handler: disconnectPrisma });
  onShutdown({ name: "elasticsearch", handler: disconnectElasticsearch });
  onShutdown({ name: "redis", handler: disconnectRedis });

  // Keeps the event loop alive while idle. Once BullMQ workers exist their
  // blocking Redis reads hold the process open and this is removed.
  const idleHandle = setInterval(() => undefined, 60_000);
  onShutdown({ name: "idle-timer", handler: () => clearInterval(idleHandle) });
}

void main().catch((err: unknown) => {
  log.fatal({ err }, "failed to start worker");
  process.exit(1);
});
