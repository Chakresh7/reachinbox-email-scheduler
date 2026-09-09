import { UnrecoverableError, Worker } from "bullmq";
import { env } from "../config/env";
import { QueueName } from "../config/constants";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { createWorkerConnection } from "../lib/redis";
import { enqueueCampaignExpand } from "../queues/campaignExpand.queue";
import { enqueueEmailSendBulk } from "../queues/emailSend.queue";
import type { CampaignExpandJobData } from "../queues/types";
import { parseRecipientsJson } from "../modules/campaigns/campaigns.service";
import { newId, recipientDedupeKey } from "../modules/campaigns/ids";
import {
  computeScheduledAt,
  effectiveDelayMs,
  effectiveHourlyLimit,
} from "../modules/campaigns/schedule.service";

const log = childLogger("worker:campaign-expand");

export function startCampaignExpandWorker(): Worker<CampaignExpandJobData> {
  const worker = new Worker<CampaignExpandJobData>(
    QueueName.campaignExpand,
    async (job) => expandBatch(job.data),
    {
      connection: createWorkerConnection("campaign-expand"),
      prefix: env.REDIS_PREFIX,
      concurrency: 2,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  );

  worker.on("failed", (job, err) => {
    log.error({ err, jobId: job?.id, data: job?.data }, "expand batch failed");
    const campaignId = job?.data.campaignId;
    if (campaignId && (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 5)) {
      void prisma.campaign
        .update({ where: { id: campaignId }, data: { status: "failed" } })
        .catch((updateErr: unknown) => log.error({ updateErr, campaignId }, "could not mark campaign failed"));
    }
  });
  worker.on("stalled", (jobId) => log.warn({ jobId }, "expand job stalled"));
  return worker;
}

async function expandBatch(data: CampaignExpandJobData): Promise<{ created: number; done: boolean }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: data.campaignId },
    include: {
      user: { include: { senders: { where: { isActive: true }, orderBy: { createdAt: "asc" } } } },
    },
  });
  if (!campaign) {
    log.warn({ campaignId: data.campaignId }, "campaign missing; skipping expand");
    return { created: 0, done: true };
  }
  if (campaign.status === "cancelled" || campaign.status === "failed") {
    return { created: 0, done: true };
  }

  const senders = campaign.user.senders;
  if (senders.length === 0) {
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "failed" } });
    throw new UnrecoverableError("Campaign has no active senders");
  }

  const recipients = parseRecipientsJson(campaign.recipients);
  const start = data.batchIndex * env.EXPAND_BATCH_SIZE;
  const slice = recipients.slice(start, start + env.EXPAND_BATCH_SIZE);
  if (slice.length === 0) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "scheduled", expandedCount: recipients.length },
    });
    return { created: 0, done: true };
  }

  const delayBetweenMs = effectiveDelayMs(campaign.delayBetweenMs, env.MIN_DELAY_BETWEEN_EMAILS_MS);

  const rows = slice.map((recipient, offset) => {
    const index = start + offset;
    const sender = senders[index % senders.length];
    if (!sender) throw new Error("sender round-robin produced no sender");
    const hourlyLimit = effectiveHourlyLimit(
      campaign.hourlyLimit,
      sender.maxEmailsPerHour,
      env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    );
    const scheduledAt = computeScheduledAt({
      startAt: campaign.startAt,
      index,
      delayBetweenMs,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      hourlyLimit,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
    });
    const id = newId();
    return {
      id,
      campaignId: campaign.id,
      userId: campaign.userId,
      senderId: sender.id,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      sequenceIndex: index,
      scheduledAt,
      originalScheduledAt: scheduledAt,
      status: "scheduled" as const,
      dedupeKey: recipientDedupeKey(campaign.id, recipient.email),
    };
  });

  await prisma.emailJob.createMany({ data: rows, skipDuplicates: true });

  const persisted = await prisma.emailJob.findMany({
    where: {
      campaignId: campaign.id,
      sequenceIndex: { gte: start, lt: start + slice.length },
    },
    select: { id: true, scheduledAt: true },
  });

  const now = Date.now();
  await enqueueEmailSendBulk(
    persisted.map((row) => ({
      emailJobId: row.id,
      delayMs: row.scheduledAt.getTime() - now,
    })),
  );

  const expandedCount = Math.min(start + slice.length, recipients.length);
  const done = expandedCount >= recipients.length;

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      expandedCount,
      status: done ? "scheduled" : "expanding",
    },
  });

  if (!done) {
    await enqueueCampaignExpand(campaign.id, data.batchIndex + 1);
  }

  log.info(
    { campaignId: campaign.id, batchIndex: data.batchIndex, created: rows.length, done },
    "expand batch complete",
  );
  return { created: rows.length, done };
}
