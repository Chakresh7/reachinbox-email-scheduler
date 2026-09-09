import type { Job } from "bullmq";
import { DelayedError } from "bullmq";
import { env } from "../../config/env";
import { childLogger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { enqueueRateLimitNotification } from "../../queues/notifications.queue";
import { enqueueSearchIndex } from "../../queues/searchIndex.queue";
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
  await enqueueSearchIndex(input.emailJobId).catch((err: unknown) => {
    log.error({ err, emailJobId: input.emailJobId }, "search-index enqueue after rate-limit failed");
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
      await enqueueRateLimitNotification({
        type: "RATE_LIMIT_HIT",
        userId: input.userId,
        senderId: input.senderId,
        hourWindowIso: exhaustedWindow.toISOString(),
        limitValue: input.senderLimit,
        jobsDeferred: event?.jobsDeferred ?? 1,
      }).catch((err: unknown) => {
        log.error({ err, senderId: input.senderId }, "notifications enqueue after SETNX failed");
      });
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
