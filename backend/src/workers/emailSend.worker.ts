import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { env } from "../config/env";
import { QueueName } from "../config/constants";
import { errorMessage } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { createWorkerConnection } from "../lib/redis";
import { classifySmtpError, sendEmail } from "../mailer/sendEmail";
import { effectiveDelayMs, effectiveHourlyLimit } from "../modules/campaigns/schedule.service";
import type { EmailSendJobData } from "../queues/types";
import { enqueueSearchIndex } from "../queues/searchIndex.queue";
import { releaseSlot, reserveSlot } from "../ratelimit";
import { claimEmailJob } from "./shared/claimEmailJob";
import {
  delayForPacing,
  rescheduleToNextWindow,
  type RescheduleLock,
} from "./shared/rescheduleEmailJob";

const log = childLogger("worker:email-send");

const TERMINAL = new Set(["sent", "cancelled"]);

export function startEmailSendWorker(): Worker<EmailSendJobData> {
  const worker = new Worker<EmailSendJobData>(
    QueueName.emailSend,
    async (job, token) => processEmailSendJob(job.data.emailJobId, { job, token }),
    {
      connection: createWorkerConnection("email-send"),
      prefix: env.REDIS_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
      stalledInterval: 30_000,
      maxStalledCount: 2,
      // Stampede guard only. Per-sender and global hourly limits live in Lua.
      limiter: { max: 50, duration: 1_000 },
    },
  );

  worker.on("failed", (job, err) => {
    if (err instanceof DelayedError) return;
    log.error({ err, jobId: job?.id, emailJobId: job?.data.emailJobId }, "email-send failed");
  });
  worker.on("stalled", (jobId) => log.warn({ jobId }, "email-send stalled"));
  return worker;
}

export async function processEmailSendJob(
  emailJobId: string,
  lock?: RescheduleLock,
): Promise<{ emailJobId: string; skipped?: string }> {
  const row = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: {
      campaign: true,
      sender: true,
    },
  });

  if (!row) return { emailJobId, skipped: "deleted" };
  if (TERMINAL.has(row.status)) return { emailJobId, skipped: "already" };
  if (row.campaign.status === "cancelled") {
    if (row.status !== "cancelled") {
      await prisma.emailJob.update({
        where: { id: row.id },
        data: { status: "cancelled" },
      });
    }
    return { emailJobId, skipped: "cancelled" };
  }

  const minDelayMs = env.MIN_DELAY_BETWEEN_EMAILS_MS;
  const senderLimit = effectiveHourlyLimit(
    row.campaign.hourlyLimit,
    row.sender.maxEmailsPerHour,
    env.MAX_EMAILS_PER_HOUR_PER_SENDER,
  );
  const reserved = await reserveSlot({
    senderId: row.senderId,
    globalLimit: env.MAX_EMAILS_PER_HOUR,
    senderLimit,
    minDelayMs,
    maxInlineWaitMs: env.MAX_INLINE_WAIT_MS,
  });

  if (reserved.kind === "DENIED") {
    if (!lock) {
      throw new Error(`rate limited (${reserved.reason}) without a BullMQ lock token`);
    }
    await rescheduleToNextWindow({
      emailJobId: row.id,
      senderId: row.senderId,
      userId: row.userId,
      senderLimit,
      effectiveDelayMs: effectiveDelayMs(row.campaign.delayBetweenMs, minDelayMs),
      reason: reserved.reason,
      lock,
    });
  }

  if (reserved.kind === "PACE") {
    if (!lock) {
      throw new Error("pacing delay without a BullMQ lock token");
    }
    await delayForPacing(lock, reserved.waitMs);
  }

  if (reserved.kind !== "ALLOW") {
    throw new Error(`reserveSlot returned ${reserved.kind} after reschedule should have thrown`);
  }

  const claimed = await claimEmailJob(row.id);
  if (!claimed) {
    await releaseSlot(row.senderId);
    const latest = await prisma.emailJob.findUnique({ where: { id: row.id } });
    if (latest && TERMINAL.has(latest.status)) return { emailJobId, skipped: "already" };
    return { emailJobId, skipped: "lost_claim" };
  }

  if (reserved.waitMs > 0) {
    await sleep(reserved.waitMs);
  }

  try {
    const result = await sendEmail(row.senderId, {
      from: row.sender.email,
      fromName: row.sender.displayName,
      to: row.recipientEmail,
      toName: row.recipientName,
      subject: row.campaign.subject,
      text: row.campaign.body,
    });

    await prisma.emailJob.update({
      where: { id: row.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        providerMessageId: result.messageId,
        previewUrl: result.previewUrl,
        lastError: null,
      },
    });
    await refreshCampaignStatus(row.campaignId);
    void enqueueSearchIndex(row.id).catch((err: unknown) => {
      log.error({ err, emailJobId: row.id }, "search-index enqueue after send failed");
    });
    return { emailJobId };
  } catch (err) {
    if (err instanceof DelayedError) throw err;

    const kind = classifySmtpError(err);
    const message = errorMessage(err);
    await releaseSlot(row.senderId);

    if (kind === "permanent") {
      await prisma.emailJob.update({
        where: { id: row.id },
        data: { status: "failed", lastError: message, sentAt: new Date() },
      });
      await refreshCampaignStatus(row.campaignId);
      void enqueueSearchIndex(row.id).catch((err: unknown) => {
        log.error({ err, emailJobId: row.id }, "search-index enqueue after failed send failed");
      });
      throw new UnrecoverableError(message);
    }

    await prisma.emailJob.update({
      where: { id: row.id },
      data: { status: "scheduled", lastError: message, claimedAt: null },
    });
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function refreshCampaignStatus(campaignId: string): Promise<void> {
  const remaining = await prisma.emailJob.count({
    where: {
      campaignId,
      status: { in: ["scheduled", "rate_limited", "claimed"] },
    },
  });
  const sentOrFailed = await prisma.emailJob.count({
    where: { campaignId, status: { in: ["sent", "failed"] } },
  });

  if (remaining === 0 && sentOrFailed > 0) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: { not: "cancelled" } },
      data: { status: "completed" },
    });
    return;
  }
  if (sentOrFailed > 0) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ["scheduled", "expanding"] } },
      data: { status: "running" },
    });
  }
}
