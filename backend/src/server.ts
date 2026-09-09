import type { Server } from "node:http";
import { app } from "./app";
import { ensureIndices } from "./bootstrap/ensureIndices";
import { installShutdownHandlers, onShutdown } from "./bootstrap/shutdown";
import { env } from "./config/env";
import { disconnectElasticsearch, getElasticsearchInfo, isSearchConfigured } from "./lib/elasticsearch";
import { childLogger } from "./lib/logger";
import { disconnectPrisma, pingPostgres, postgresPoolMax } from "./lib/prisma";
import { assertRedisReady, disconnectRedis } from "./lib/redis";
import { closeProducerQueues } from "./queues";

/**
 * API entrypoint.
 *
 * Dependencies are verified *before* the port opens. Booting first and
 * discovering a bad Redis password on the first scheduled email is how a
 * deploy looks healthy and silently is not.
 */

const log = childLogger("server");

async function verifyDependencies(): Promise<void> {
  const postgresLatency = await pingPostgres();
  log.info(
    { latencyMs: Math.round(postgresLatency * 100) / 100, poolMax: postgresPoolMax },
    "postgres ready",
  );

  // Throws on an unsafe eviction policy: see lib/redis.ts for why that is fatal.
  await assertRedisReady();

  if (isSearchConfigured) {
    try {
      const info = await getElasticsearchInfo();
      log.info(info, "elasticsearch ready");
      await ensureIndices();
    } catch (err) {
      // Non-fatal on purpose. Search degrades to Postgres (DESIGN.md §12); the
      // API must stay available.
      log.warn({ err }, "elasticsearch unreachable at boot; search will fall back to Postgres");
    }
  }
}

function logFeatureSummary(): void {
  log.info(
    {
      google: env.features.google ? "configured" : "missing credentials",
      slack: env.features.slack ? "configured" : "missing credentials",
      search: env.features.search ? "configured" : "disabled or unconfigured",
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      maxPerHourGlobal: env.MAX_EMAILS_PER_HOUR,
      maxPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    },
    "feature and limit summary",
  );
}

async function main(): Promise<void> {
  installShutdownHandlers();

  await verifyDependencies();
  logFeatureSummary();

  const server: Server = app.listen(env.PORT, () => {
    log.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        allowedOrigins: env.allowedOrigins,
      },
      `API listening on http://localhost:${env.PORT}`,
    );
  });

  // Cap how long a slow client can hold a socket open during shutdown.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Order matters: stop accepting connections before tearing down the pools
  // those connections might still be using.
  onShutdown({
    name: "http-server",
    timeoutMs: 20_000,
    handler: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  });
  onShutdown({ name: "queues", handler: closeProducerQueues });
  onShutdown({ name: "prisma", handler: disconnectPrisma });
  onShutdown({ name: "elasticsearch", handler: disconnectElasticsearch });
  onShutdown({ name: "redis", handler: disconnectRedis });
}

void main().catch((err: unknown) => {
  log.fatal({ err }, "failed to start API");
  process.exit(1);
});
