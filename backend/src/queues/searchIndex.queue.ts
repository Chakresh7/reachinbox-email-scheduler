import { Queue } from "bullmq";
import {
  defaultJobOptions,
  JobName,
  QueueName,
  searchIndexBulkJobId,
  searchIndexJobId,
} from "../config/constants";
import { isSearchConfigured } from "../lib/elasticsearch";
import { sharedQueueConnection, queuePrefix } from "./connection";
import type { SearchIndexJobData } from "./types";

export const searchIndexQueue = new Queue<SearchIndexJobData>(QueueName.searchIndex, {
  connection: sharedQueueConnection,
  prefix: queuePrefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
  },
});

function isDuplicate(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|duplicated/i.test(message);
}

/** Single-doc index. Skips entirely when search is not configured. */
export async function enqueueSearchIndex(emailJobId: string): Promise<void> {
  if (!isSearchConfigured) return;
  const jobId = searchIndexJobId(emailJobId);
  const existing = await searchIndexQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove();
    } else {
      return;
    }
  }
  try {
    await searchIndexQueue.add(JobName.indexEmail, { emailJobId }, { jobId });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
}

/** One BullMQ job for a 500-row expand batch. Thin ids only. */
export async function enqueueSearchIndexBulk(
  emailJobIds: string[],
  campaignId: string,
  batchIndex: number,
): Promise<void> {
  if (!isSearchConfigured || emailJobIds.length === 0) return;
  try {
    await searchIndexQueue.add(
      JobName.indexEmail,
      { emailJobIds, campaignId, batchIndex },
      { jobId: searchIndexBulkJobId(campaignId, batchIndex) },
    );
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
}
