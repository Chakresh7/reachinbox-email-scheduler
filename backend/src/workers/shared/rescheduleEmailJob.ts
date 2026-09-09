import type { Job } from "bullmq";
import { DelayedError } from "bullmq";
import { env } from "../../config/env";
import { decrypt } from "../../lib/crypto";
import { childLogger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import {
  hourEpoch,
  jitterMs,
  nextOverflowRank,
  nextWindowStart,
  overflowScheduledAt,
  tryClaimRateLimitNotify,
  type DenyReason,
} from "../../ratelimit";

const log = childLogger("worker:reschedule");

export interface RescheduleLock {
  job: Job;
  token?: string;
}

async function recordRateLimitEvent(input: {
  userId: string;
  senderId: string;
  hourWindow: Date;
  limitValue: number;
}): Promise<void> {
  await prisma.rateLimitEvent.upsert({
    where: {
      senderId_hourWindow: {
        senderId: input.senderId,
        hourWindow: input.hourWindow,
      },
    },
    create: {
      userId: input.userId,
      senderId: input.senderId,
      hourWindow: input.hourWindow,
      limitValue: input.limitValue,
      jobsDeferred: 1,
    },
    update: {
      jobsDeferred: { increment: 1 },
    },
  });
}

async function maybeNotifySlack(senderId: string, hourWindow: Date, jobsDeferred: number): Promise<void> {
  const sender = await prisma.sender.findUnique({
    where: { id: senderId },
    select: { email: true, userId: true, displayName: true },
  });
  if (!sender) return;

  const integration = await prisma.slackIntegration.findUnique({
    where: { userId: sender.userId },
  });
  if (!integration || integration.revokedAt) {
    log.info({ senderId }, "rate-limit hit; Slack not connected, skipping notify");
    return;
  }

  let webhookUrl: string;
  try {
    webhookUrl = decrypt(integration.webhookUrlEncrypted);
  } catch (err) {
    log.error({ err, senderId }, "could not decrypt Slack webhook");
    await prisma.rateLimitEvent.updateMany({
      where: { senderId, hourWindow },
      data: { notifyError: "decrypt_failed" },
    });
    return;
  }

  const hourLabel = hourWindow.toISOString().slice(0, 13);
  const body = {
    text:
      `Hourly send limit reached for ${sender.displayName} <${sender.email}> ` +
      `(window ${hourLabel}Z). ${jobsDeferred} email(s) deferred to the next hour.`,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Slack webhook HTTP ${response.status}`);
    }
    await prisma.rateLimitEvent.updateMany({
      where: { senderId, hourWindow },
      data: { notifiedAt: new Date(), notifyError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, senderId }, "Slack rate-limit notify failed");
    await prisma.rateLimitEvent.updateMany({
      where: { senderId, hourWindow },
      data: { notifyError: message },
    });
  }
}

/**
 * Hourly limit exhausted: park the row in the next window, already paced, and
 * move the BullMQ job without consuming a retry.
 */
export async function rescheduleToNextWindow(input: {
  emailJobId: string;
  senderId: string;
  userId: string;
  senderLimit: number;
  effectiveDelayMs: number;
  reason: DenyReason;
  nowMs?: number;
  lock: RescheduleLock;
}): Promise<never> {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = env.RATE_LIMIT_WINDOW_MS;
  const nextStart = nextWindowStart(nowMs, windowMs);
  const rank = await nextOverflowRank(input.senderId, nextStart);
  const scheduledAt = overflowScheduledAt({
    nowMs,
    windowMs,
    rank,
    effectiveDelayMs: input.effectiveDelayMs,
    jitterMs: jitterMs(),
  });

  await prisma.emailJob.update({
    where: { id: input.emailJobId },
    data: {
      status: "rate_limited",
      scheduledAt,
      rescheduleCount: { increment: 1 },
      claimedAt: null,
    },
  });

  if (input.reason === "SENDER_HOURLY_LIMIT") {
    const exhaustedWindow = new Date(hourEpoch(nowMs, windowMs));
    await recordRateLimitEvent({
      userId: input.userId,
      senderId: input.senderId,
      hourWindow: exhaustedWindow,
      limitValue: input.senderLimit,
    });
    const shouldNotify = await tryClaimRateLimitNotify(input.senderId, exhaustedWindow.getTime());
    if (shouldNotify) {
      const event = await prisma.rateLimitEvent.findUnique({
        where: { senderId_hourWindow: { senderId: input.senderId, hourWindow: exhaustedWindow } },
        select: { jobsDeferred: true },
      });
      await maybeNotifySlack(input.senderId, exhaustedWindow, event?.jobsDeferred ?? 1);
    }
  }

  log.info(
    {
      emailJobId: input.emailJobId,
      senderId: input.senderId,
      reason: input.reason,
      rank,
      scheduledAt: scheduledAt.toISOString(),
    },
    "job deferred to next hour window",
  );

  await input.lock.job.moveToDelayed(scheduledAt.getTime(), input.lock.token);
  throw new DelayedError();
}

/** Pacing wait is too long to hold a concurrency slot. Counters were not incremented. */
export async function delayForPacing(lock: RescheduleLock, waitMs: number): Promise<never> {
  const when = Date.now() + Math.max(1, waitMs);
  await lock.job.moveToDelayed(when, lock.token);
  throw new DelayedError();
}
