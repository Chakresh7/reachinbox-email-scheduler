import { Queue } from "bullmq";
import { defaultJobOptions, emailSendJobId, JobName, QueueName } from "../config/constants";
import { env } from "../config/env";
import { sharedQueueConnection, queuePrefix } from "./connection";
import type { EmailSendJobData } from "./types";

export const emailSendQueue = new Queue<EmailSendJobData>(QueueName.emailSend, {
  connection: sharedQueueConnection,
  prefix: queuePrefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: env.EMAIL_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: env.EMAIL_JOB_BACKOFF_MS },
  },
});

export function isDuplicateJobError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|duplicated/i.test(message);
}

export async function enqueueEmailSend(emailJobId: string, delayMs: number): Promise<void> {
  try {
    await emailSendQueue.add(
      JobName.sendEmail,
      { emailJobId },
      {
        jobId: emailSendJobId(emailJobId),
        delay: Math.max(0, delayMs),
      },
    );
  } catch (err) {
    if (!isDuplicateJobError(err)) throw err;
  }
}

export async function enqueueEmailSendBulk(
  items: { emailJobId: string; delayMs: number }[],
): Promise<void> {
  if (items.length === 0) return;
  try {
    await emailSendQueue.addBulk(
      items.map((item) => ({
        name: JobName.sendEmail,
        data: { emailJobId: item.emailJobId },
        opts: {
          jobId: emailSendJobId(item.emailJobId),
          delay: Math.max(0, item.delayMs),
          attempts: env.EMAIL_JOB_ATTEMPTS,
          backoff: { type: "exponential", delay: env.EMAIL_JOB_BACKOFF_MS },
        },
      })),
    );
  } catch (err) {
    if (!isDuplicateJobError(err)) throw err;
    for (const item of items) {
      await enqueueEmailSend(item.emailJobId, item.delayMs);
    }
  }
}

export async function removeEmailSendJob(emailJobId: string): Promise<void> {
  const job = await emailSendQueue.getJob(emailSendJobId(emailJobId));
  if (job) await job.remove();
}
