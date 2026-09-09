import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { badRequest } from "../../lib/errors";
import { requireUser } from "../../middleware/requireAuth";
import * as campaigns from "./campaigns.service";

const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function fileFrom(req: Request): Buffer {
  const file = (req as Request & { file?: { buffer: Buffer; size: number } }).file;
  if (!file) throw badRequest("A CSV or text file field named `file` is required");
  if (file.size > env.MAX_CSV_BYTES) {
    throw badRequest(`File exceeds MAX_CSV_BYTES (${env.MAX_CSV_BYTES})`);
  }
  return file.buffer;
}

export async function previewCsv(req: Request, res: Response): Promise<void> {
  const parsed = await campaigns.previewCsv(fileFrom(req));
  res.json({
    data: {
      totalRows: parsed.totalRows,
      validEmails: parsed.recipients.length,
      duplicates: parsed.duplicateCount,
      invalidRows: parsed.invalidRows,
    },
  });
}

export async function create(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const subject = String(req.body.subject ?? "").trim();
  const body = String(req.body.body ?? "");
  const startAtRaw = String(req.body.startAt ?? "");
  const delayBetweenMs = Number(req.body.delayBetweenMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS);
  const hourlyRaw = req.body.hourlyLimit;
  const hourlyLimit =
    hourlyRaw === undefined || hourlyRaw === null || hourlyRaw === ""
      ? null
      : Number(hourlyRaw);

  if (!subject) throw badRequest("subject is required");
  if (!body.trim()) throw badRequest("body is required");
  const startAt = new Date(startAtRaw);
  if (Number.isNaN(startAt.getTime())) throw badRequest("startAt must be an ISO-8601 timestamp");
  if (!Number.isFinite(delayBetweenMs) || delayBetweenMs < 0) {
    throw badRequest("delayBetweenMs must be a non-negative number");
  }
  if (hourlyLimit !== null && (!Number.isInteger(hourlyLimit) || hourlyLimit < 1)) {
    throw badRequest("hourlyLimit must be a positive integer");
  }

  let senderIds: string[] | undefined;
  if (typeof req.body.senderIds === "string" && req.body.senderIds.trim()) {
    try {
      const parsed = JSON.parse(req.body.senderIds) as unknown;
      if (Array.isArray(parsed)) senderIds = parsed.map(String);
    } catch {
      senderIds = String(req.body.senderIds)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const idempotencyKey = req.header("idempotency-key")?.trim() || undefined;
  const result = await campaigns.createCampaign({
    userId: user.id,
    subject,
    body,
    startAt,
    delayBetweenMs,
    hourlyLimit,
    senderIds,
    csv: fileFrom(req),
    idempotencyKey,
  });

  res.status(202).json({ data: result });
}

export async function list(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { page, limit } = pagination.parse(req.query);
  const result = await campaigns.listCampaigns(user.id, page, limit);
  res.json(result);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const id = z.string().uuid().parse(req.params.id);
  res.json({ data: await campaigns.getCampaign(user.id, id) });
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const id = z.string().uuid().parse(req.params.id);
  res.json({ data: await campaigns.cancelCampaign(user.id, id) });
}
