import { UnrecoverableError, Worker } from "bullmq";
import { env } from "../config/env";
import { QueueName } from "../config/constants";
import { indexDocuments, isSearchConfigured } from "../lib/elasticsearch";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { createWorkerConnection } from "../lib/redis";
import { toSearchDocument } from "../modules/search/document";
import type { SearchIndexJobData } from "../queues/types";

const log = childLogger("worker:search-index");

const INCLUDE = {
  campaign: { select: { subject: true, body: true } },
  sender: { select: { email: true } },
} as const;

export function startSearchIndexWorker(): Worker<SearchIndexJobData> {
  const worker = new Worker<SearchIndexJobData>(
    QueueName.searchIndex,
    async (job) => processSearchIndexJob(job.data),
    {
      connection: createWorkerConnection("search-index"),
      prefix: env.REDIS_PREFIX,
      concurrency: 3,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  );

  worker.on("failed", (job, err) => {
    log.error({ err, jobId: job?.id }, "search-index failed");
  });
  worker.on("stalled", (jobId) => log.warn({ jobId }, "search-index stalled"));
  return worker;
}

export async function processSearchIndexJob(data: SearchIndexJobData): Promise<{ indexed: number }> {
  if (!isSearchConfigured) {
    throw new UnrecoverableError("search is not configured");
  }

  const ids = "emailJobIds" in data ? data.emailJobIds : [data.emailJobId];
  const rows = await prisma.emailJob.findMany({
    where: { id: { in: ids } },
    include: INCLUDE,
  });
  if (rows.length === 0) return { indexed: 0 };

  const indexed = await indexDocuments(rows.map(toSearchDocument));
  log.debug({ indexed, requested: ids.length }, "indexed email documents");
  return { indexed };
}
