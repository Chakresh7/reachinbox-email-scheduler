import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import type { Job } from "bullmq";
import { env } from "../config/env";
import { QueueName } from "../config/constants";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { createWorkerConnection } from "../lib/redis";
import {
  loadActiveWebhook,
  markIntegrationRevoked,
  markRateLimitNotified,
  markRateLimitNotifyError,
  postIncomingWebhook,
  rateLimitBlockKit,
} from "../modules/slack/notify.service";
import type { NotificationJobData } from "../queues/types";

const log = childLogger("worker:notifications");

export function startNotificationsWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(
    QueueName.notifications,
    async (job, token) => processNotificationJob(job.data, { job, token }),
    {
      connection: createWorkerConnection("notifications"),
      prefix: env.REDIS_PREFIX,
      concurrency: 2,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  );

  worker.on("failed", (job, err) => {
    if (err instanceof DelayedError) return;
    log.error({ err, jobId: job?.id }, "notifications failed");
  });
  worker.on("stalled", (jobId) => log.warn({ jobId }, "notifications stalled"));
  return worker;
}

export async function processNotificationJob(
  data: NotificationJobData,
  lock?: { job: Job; token?: string },
): Promise<{ skipped?: string; notified?: boolean }> {
  const webhook = await loadActiveWebhook(data.userId);
  if (!webhook) {
    return { skipped: "not_connected" };
  }

  const sender = await prisma.sender.findUnique({
    where: { id: data.senderId },
    select: { email: true },
  });
  const hourWindow = new Date(data.hourWindowIso);
  const nextHour = new Date(hourWindow.getTime() + env.RATE_LIMIT_WINDOW_MS);

  const payload = rateLimitBlockKit({
    senderEmail: sender?.email ?? data.senderId,
    limitValue: data.limitValue,
    jobsDeferred: data.jobsDeferred,
    nextHourIso: nextHour.toISOString(),
  });

  let result;
  try {
    result = await postIncomingWebhook(webhook.webhookUrl, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRateLimitNotifyError(data.senderId, hourWindow, message);
    throw err;
  }

  if (result.ok) {
    await markRateLimitNotified(data.senderId, hourWindow);
    return { notified: true };
  }

  if (result.dead) {
    await markIntegrationRevoked(data.userId, `webhook HTTP ${result.status}: ${result.body}`);
    await markRateLimitNotifyError(data.senderId, hourWindow, `dead_webhook:${result.status}`);
    throw new UnrecoverableError(`Slack webhook gone (${result.status})`);
  }

  if (result.status === 429) {
    await markRateLimitNotifyError(data.senderId, hourWindow, "http_429");
    if (lock && result.retryAfterMs) {
      await lock.job.moveToDelayed(Date.now() + result.retryAfterMs, lock.token);
      throw new DelayedError();
    }
    throw new Error("Slack webhook HTTP 429");
  }

  await markRateLimitNotifyError(data.senderId, hourWindow, `http_${result.status}`);
  throw new Error(`Slack webhook HTTP ${result.status}`);
}
