import { env } from "../config/env";
import { emailSendJobId, reconcileLastKey } from "../config/constants";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { enqueueEmailSendBulk, emailSendQueue } from "../queues/emailSend.queue";

const log = childLogger("reconcile");

const BATCH = 500;

export interface ReconcileResult {
  checked: number;
  restored: number;
  staleReset: number;
  ranAt: string;
}

/**
 * One-shot repair: Postgres is intent, Redis is the schedule.
 * Safe to run repeatedly because job ids are deterministic.
 */
export async function reconcileEmailJobs(): Promise<ReconcileResult> {
  const staleBefore = new Date(Date.now() - env.STALE_CLAIM_TIMEOUT_MS);
  const stale = await prisma.emailJob.updateMany({
    where: {
      status: "claimed",
      claimedAt: { lte: staleBefore },
    },
    data: {
      status: "scheduled",
      claimedAt: null,
    },
  });

  let checked = 0;
  let restored = 0;
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.emailJob.findMany({
      where: {
        status: { in: ["scheduled", "rate_limited"] },
        campaign: { status: { not: "cancelled" } },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, scheduledAt: true },
    });
    if (batch.length === 0) break;

    const now = Date.now();
    const missing: { emailJobId: string; delayMs: number }[] = [];
    const found = await Promise.all(
      batch.map(async (row) => {
        const job = await emailSendQueue.getJob(emailSendJobId(row.id));
        return { row, exists: Boolean(job) };
      }),
    );

    for (const item of found) {
      checked += 1;
      if (!item.exists) {
        missing.push({
          emailJobId: item.row.id,
          delayMs: item.row.scheduledAt.getTime() - now,
        });
      }
    }

    await enqueueEmailSendBulk(missing);
    restored += missing.length;
    cursor = batch[batch.length - 1]?.id;
    if (batch.length < BATCH) break;
  }

  const result: ReconcileResult = {
    checked,
    restored,
    staleReset: stale.count,
    ranAt: new Date().toISOString(),
  };

  await redis.set(reconcileLastKey(), JSON.stringify(result), "EX", 86_400);
  log.info(result, "reconcile complete");
  return result;
}

export async function readLastReconcile(): Promise<ReconcileResult | null> {
  const raw = await redis.get(reconcileLastKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReconcileResult;
  } catch {
    return null;
  }
}
