import type { Request, Response } from "express";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { requireUser } from "../../middleware/requireAuth";
import { searchEmails } from "./search.service";

const STATUSES = [
  "scheduled",
  "rate_limited",
  "claimed",
  "sent",
  "failed",
  "cancelled",
  "needs_review",
] as const;

const querySchema = z.object({
  q: z.string().trim().optional(),
  status: z.string().trim().optional(),
  senderId: z.string().uuid().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function parseStatuses(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  for (const value of values) {
    if (!STATUSES.includes(value as (typeof STATUSES)[number])) {
      throw new Error(`invalid status: ${value}`);
    }
  }
  return values;
}

function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
  return date;
}

export async function search(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const parsed = querySchema.parse(req.query);
  let statuses: string[] | undefined;
  let from: Date | undefined;
  let to: Date | undefined;
  try {
    statuses = parseStatuses(parsed.status);
    from = parseDate(parsed.from, "from");
    to = parseDate(parsed.to, "to");
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "invalid query");
  }

  const result = await searchEmails({
    userId: user.id,
    q: parsed.q,
    statuses,
    senderId: parsed.senderId,
    from,
    to,
    page: parsed.page,
    limit: parsed.limit,
  });

  res.json({
    data: result.hits,
    meta: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit) || 1,
      took: result.took,
      degraded: result.degraded,
    },
  });
}
