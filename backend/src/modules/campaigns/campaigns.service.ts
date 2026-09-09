import type { Prisma } from "../../generated/prisma/client";
import { env } from "../../config/env";
import {
  badRequest,
  conflict,
  csvNoValidRecipients,
  invalidState,
  noActiveSender,
  notFound,
} from "../../lib/errors";
import { readIdempotentResponse, writeIdempotentResponse } from "../../lib/idempotency";
import { prisma } from "../../lib/prisma";
import { enqueueCampaignExpand } from "../../queues/campaignExpand.queue";
import { emailSendJobId } from "../../config/constants";
import { emailSendQueue, removeEmailSendJob } from "../../queues/emailSend.queue";
import { parseRecipientCsv, type Recipient } from "./csv.service";
import {
  effectiveDelayMs,
  effectiveHourlyLimit,
  estimateCompletionAt,
} from "./schedule.service";

export interface CreateCampaignInput {
  userId: string;
  subject: string;
  body: string;
  startAt: Date;
  delayBetweenMs: number;
  hourlyLimit: number | null;
  senderIds?: string[];
  csv: Buffer;
  idempotencyKey?: string;
}

export interface CreateCampaignResult {
  campaignId: string;
  totalRecipients: number;
  validCount: number;
  invalidRows: { row: number; value: string; reason: string }[];
  duplicateCount: number;
  estimatedCompletionAt: string;
}

function asRecipients(value: unknown): Recipient[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Recipient =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Recipient).email === "string",
  );
}

export async function previewCsv(csv: Buffer) {
  return parseRecipientCsv(csv, { maxRecipients: env.MAX_RECIPIENTS_PER_CAMPAIGN });
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  if (input.idempotencyKey) {
    const replay = await readIdempotentResponse<CreateCampaignResult>(
      `${input.userId}:${input.idempotencyKey}`,
    );
    if (replay) return replay;
  }

  const parsed = parseRecipientCsv(input.csv, { maxRecipients: env.MAX_RECIPIENTS_PER_CAMPAIGN });
  if (parsed.recipients.length === 0) {
    throw csvNoValidRecipients({ invalidRows: parsed.invalidRows });
  }

  const now = Date.now();
  if (input.startAt.getTime() < now - 60_000) {
    throw badRequest("startAt cannot be more than 60 seconds in the past");
  }

  const senders = await prisma.sender.findMany({
    where: {
      userId: input.userId,
      isActive: true,
      ...(input.senderIds && input.senderIds.length > 0 ? { id: { in: input.senderIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (senders.length === 0) {
    throw noActiveSender("No active sender. Run `npm run seed:senders`.");
  }

  const delayBetweenMs = effectiveDelayMs(input.delayBetweenMs, env.MIN_DELAY_BETWEEN_EMAILS_MS);
  const hourlyLimit = effectiveHourlyLimit(
    input.hourlyLimit,
    senders[0]?.maxEmailsPerHour,
    env.MAX_EMAILS_PER_HOUR_PER_SENDER,
  );
  const estimated = estimateCompletionAt({
    startAt: input.startAt,
    recipientCount: parsed.recipients.length,
    delayBetweenMs,
    minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
    hourlyLimit,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
  });

  let campaign;
  try {
    campaign = await prisma.campaign.create({
      data: {
        userId: input.userId,
        subject: input.subject,
        body: input.body,
        startAt: input.startAt,
        delayBetweenMs,
        hourlyLimit: input.hourlyLimit,
        totalRecipients: parsed.recipients.length,
        status: "expanding",
        recipients: parsed.recipients as unknown as Prisma.InputJsonValue,
        idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      const existing = await prisma.campaign.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        if (existing.status === "expanding" || existing.status === "failed") {
          await enqueueCampaignExpand(existing.id, 0);
        }
        const body: CreateCampaignResult = {
          campaignId: existing.id,
          totalRecipients: existing.totalRecipients,
          validCount: existing.totalRecipients,
          invalidRows: parsed.invalidRows,
          duplicateCount: parsed.duplicateCount,
          estimatedCompletionAt: estimated.toISOString(),
        };
        if (input.idempotencyKey) {
          await writeIdempotentResponse(`${input.userId}:${input.idempotencyKey}`, body);
        }
        return body;
      }
      throw conflict("A campaign with that idempotency key already exists");
    }
    throw err;
  }

  try {
    await enqueueCampaignExpand(campaign.id, 0);
  } catch (err) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "failed" },
    });
    throw err;
  }

  const result: CreateCampaignResult = {
    campaignId: campaign.id,
    totalRecipients: parsed.recipients.length,
    validCount: parsed.recipients.length,
    invalidRows: parsed.invalidRows,
    duplicateCount: parsed.duplicateCount,
    estimatedCompletionAt: estimated.toISOString(),
  };

  if (input.idempotencyKey) {
    await writeIdempotentResponse(`${input.userId}:${input.idempotencyKey}`, result);
  }

  return result;
}

export async function listCampaigns(userId: string, page: number, limit: number) {
  const where = { userId };
  const [total, rows] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        subject: true,
        status: true,
        startAt: true,
        delayBetweenMs: true,
        hourlyLimit: true,
        totalRecipients: true,
        expandedCount: true,
        createdAt: true,
      },
    }),
  ]);

  const ids = rows.map((r) => r.id);
  const grouped =
    ids.length === 0
      ? []
      : await prisma.emailJob.groupBy({
          by: ["campaignId", "status"],
          where: { campaignId: { in: ids } },
          _count: { _all: true },
        });

  const counts = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const current = counts.get(row.campaignId) ?? {};
    current[row.status] = row._count._all;
    counts.set(row.campaignId, current);
  }

  return {
    data: rows.map((row) => ({
      ...row,
      startAt: row.startAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      counts: counts.get(row.id) ?? {},
    })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}

export async function getCampaign(userId: string, id: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id, userId } });
  if (!campaign) throw notFound("Campaign");

  const grouped = await prisma.emailJob.groupBy({
    by: ["status"],
    where: { campaignId: id },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  return {
    id: campaign.id,
    subject: campaign.subject,
    body: campaign.body,
    status: campaign.status,
    startAt: campaign.startAt.toISOString(),
    delayBetweenMs: campaign.delayBetweenMs,
    hourlyLimit: campaign.hourlyLimit,
    totalRecipients: campaign.totalRecipients,
    expandedCount: campaign.expandedCount,
    createdAt: campaign.createdAt.toISOString(),
    counts,
  };
}

export async function cancelCampaign(userId: string, id: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id, userId } });
  if (!campaign) throw notFound("Campaign");
  if (campaign.status === "cancelled") {
    throw invalidState("Campaign is already cancelled");
  }
  if (campaign.status === "completed") {
    throw invalidState("Completed campaigns cannot be cancelled");
  }

  const pending = await prisma.emailJob.findMany({
    where: {
      campaignId: id,
      status: { in: ["scheduled", "rate_limited"] },
    },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.campaign.update({ where: { id }, data: { status: "cancelled" } }),
    prisma.emailJob.updateMany({
      where: { campaignId: id, status: { in: ["scheduled", "rate_limited"] } },
      data: { status: "cancelled" },
    }),
  ]);

  await Promise.all(
    pending.map(async (job) => {
      try {
        await removeEmailSendJob(job.id);
      } catch {
        const queued = await emailSendQueue.getJob(emailSendJobId(job.id));
        if (queued) await queued.remove();
      }
    }),
  );

  return { id, status: "cancelled" as const, cancelledJobs: pending.length };
}

export function parseRecipientsJson(value: unknown): Recipient[] {
  return asRecipients(value);
}
