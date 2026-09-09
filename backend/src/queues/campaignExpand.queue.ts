import { Queue } from "bullmq";
import { campaignExpandJobId, defaultJobOptions, JobName, QueueName } from "../config/constants";
import { sharedQueueConnection, queuePrefix } from "./connection";
import type { CampaignExpandJobData } from "./types";

export const campaignExpandQueue = new Queue<CampaignExpandJobData>(QueueName.campaignExpand, {
  connection: sharedQueueConnection,
  prefix: queuePrefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  },
});

export async function enqueueCampaignExpand(
  campaignId: string,
  batchIndex: number,
): Promise<void> {
  try {
    await campaignExpandQueue.add(
      JobName.expandBatch,
      { campaignId, batchIndex },
      { jobId: campaignExpandJobId(campaignId, batchIndex) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists|duplicated/i.test(message)) throw err;
  }
}
