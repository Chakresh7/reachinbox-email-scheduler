import type { Prisma } from "../../generated/prisma/client";
import { z } from "zod";
import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { notFound } from "../../lib/errors";
import { requireUser } from "../../middleware/requireAuth";

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  campaignId: z.string().uuid().optional(),
  senderId: z.string().uuid().optional(),
});

function paginationMeta(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
}

function toSummary(row: {
  id: string;
  campaignId: string;
  recipientEmail: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  rescheduleCount: number;
  previewUrl: string | null;
  lastError: string | null;
  campaign: { subject: string };
  sender: { email: string };
}) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    recipientEmail: row.recipientEmail,
    subject: row.campaign.subject,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    senderEmail: row.sender.email,
    rescheduleCount: row.rescheduleCount,
    previewUrl: row.previewUrl,
    lastError: row.lastError,
  };
}

export async function listScheduled(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { page, limit, campaignId, senderId } = listQuery.parse(req.query);
  const where: Prisma.EmailJobWhereInput = {
    userId: user.id,
    status: { in: ["scheduled", "rate_limited", "claimed"] },
  };
  if (campaignId) where.campaignId = campaignId;
  if (senderId) where.senderId = senderId;
  const [total, rows] = await Promise.all([
    prisma.emailJob.count({ where }),
    prisma.emailJob.findMany({
      where,
      orderBy: { scheduledAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { campaign: { select: { subject: true } }, sender: { select: { email: true } } },
    }),
  ]);
  res.json({ data: rows.map(toSummary), meta: paginationMeta(page, limit, total) });
}

export async function listSent(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { page, limit, campaignId, senderId } = listQuery.parse(req.query);
  const where: Prisma.EmailJobWhereInput = {
    userId: user.id,
    status: { in: ["sent", "failed"] },
  };
  if (campaignId) where.campaignId = campaignId;
  if (senderId) where.senderId = senderId;
  const [total, rows] = await Promise.all([
    prisma.emailJob.count({ where }),
    prisma.emailJob.findMany({
      where,
      orderBy: { sentAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { campaign: { select: { subject: true } }, sender: { select: { email: true } } },
    }),
  ]);
  res.json({ data: rows.map(toSummary), meta: paginationMeta(page, limit, total) });
}

export async function getById(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const id = z.string().uuid().parse(req.params.id);
  const row = await prisma.emailJob.findFirst({
    where: { id, userId: user.id },
    include: { campaign: true, sender: { select: { email: true, displayName: true } } },
  });
  if (!row) throw notFound("Email");
  res.json({
    data: {
      ...toSummary({ ...row, campaign: { subject: row.campaign.subject } }),
      body: row.campaign.body,
      attemptCount: row.attemptCount,
      originalScheduledAt: row.originalScheduledAt.toISOString(),
    },
  });
}

export async function stats(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const grouped = await prisma.emailJob.groupBy({
    by: ["status"],
    where: { userId: user.id },
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  res.json({ data: { byStatus } });
}
