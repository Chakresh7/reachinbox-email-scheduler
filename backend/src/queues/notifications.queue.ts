import { Queue } from "bullmq";
import {
  defaultJobOptions,
  JobName,
  notifyRateLimitJobId,
  QueueName,
} from "../config/constants";
import { sharedQueueConnection, queuePrefix } from "./connection";
import type { NotificationJobData } from "./types";

export const notificationsQueue = new Queue<NotificationJobData>(QueueName.notifications, {
  connection: sharedQueueConnection,
  prefix: queuePrefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 4,
    backoff: { type: "exponential", delay: 5_000 },
  },
});

function isDuplicate(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|duplicated/i.test(message);
}

export async function enqueueRateLimitNotification(data: NotificationJobData): Promise<void> {
  const hourEpoch = Date.parse(data.hourWindowIso);
  const jobId = notifyRateLimitJobId(data.senderId, hourEpoch);
  try {
    await notificationsQueue.add(JobName.notifyRateLimit, data, { jobId });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
}
