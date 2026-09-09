import { closeAllTransporters } from "./mailer/transporterPool";
import { reconcileEmailJobs } from "./bootstrap/reconcile";
import { installShutdownHandlers, onShutdown } from "./bootstrap/shutdown";
import { env } from "./config/env";
import { disconnectElasticsearch } from "./lib/elasticsearch";
import { childLogger } from "./lib/logger";
import { disconnectPrisma, pingPostgres } from "./lib/prisma";
import { assertRedisReady, disconnectRedis } from "./lib/redis";
import { closeProducerQueues } from "./queues";
import { startCampaignExpandWorker } from "./workers/campaignExpand.worker";
import { startEmailSendWorker } from "./workers/emailSend.worker";

const log = childLogger("worker");

async function main(): Promise<void> {
  installShutdownHandlers();

  const postgresLatency = await pingPostgres();
  log.info({ latencyMs: Math.round(postgresLatency * 100) / 100 }, "postgres ready");
  await assertRedisReady();

  if (env.RECONCILE_ON_BOOT) {
    await reconcileEmailJobs();
  }

  const expandWorker = startCampaignExpandWorker();
  const sendWorker = startEmailSendWorker();

  log.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      expandBatchSize: env.EXPAND_BATCH_SIZE,
    },
    "workers registered",
  );

  onShutdown({
    name: "email-send-worker",
    timeoutMs: 20_000,
    handler: () => sendWorker.close(),
  });
  onShutdown({
    name: "campaign-expand-worker",
    timeoutMs: 20_000,
    handler: () => expandWorker.close(),
  });
  onShutdown({ name: "smtp-pool", handler: closeAllTransporters });
  onShutdown({ name: "queues", handler: closeProducerQueues });
  onShutdown({ name: "prisma", handler: disconnectPrisma });
  onShutdown({ name: "elasticsearch", handler: disconnectElasticsearch });
  onShutdown({ name: "redis", handler: disconnectRedis });
}

void main().catch((err: unknown) => {
  log.fatal({ err }, "failed to start worker");
  process.exit(1);
});
