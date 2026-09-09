import type { Prisma } from "../../generated/prisma/client";
import { emailsIndexName, esClient, isSearchConfigured } from "../../lib/elasticsearch";
import { prisma } from "../../lib/prisma";
import { dateRangeField } from "./dateRange";
import { documentToHit, type EmailSearchDocument, type EmailSearchHit } from "./document";

export interface SearchQuery {
  userId: string;
  q?: string;
  statuses?: string[];
  senderId?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

export interface SearchResult {
  hits: EmailSearchHit[];
  total: number;
  took: number;
  degraded: boolean;
  page: number;
  limit: number;
}

function clampFromSize(page: number, limit: number): { from: number; size: number } {
  const size = Math.min(Math.max(limit, 1), 100);
  const from = (Math.max(page, 1) - 1) * size;
  if (from >= 10_000) {
    return { from: 10_000, size: 0 };
  }
  return { from, size: Math.min(size, 10_000 - from) };
}

function hitFromUnknown(raw: unknown): EmailSearchHit | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as EmailSearchDocument;
  if (typeof doc.id !== "string") return null;
  return documentToHit({
    id: doc.id,
    campaignId: typeof doc.campaignId === "string" ? doc.campaignId : "",
    userId: typeof doc.userId === "string" ? doc.userId : "",
    senderId: typeof doc.senderId === "string" ? doc.senderId : "",
    senderEmail: typeof doc.senderEmail === "string" ? doc.senderEmail : "",
    recipientEmail: typeof doc.recipientEmail === "string" ? doc.recipientEmail : "",
    subject: typeof doc.subject === "string" ? doc.subject : "",
    body: typeof doc.body === "string" ? doc.body : "",
    status: typeof doc.status === "string" ? doc.status : "",
    scheduledAt: typeof doc.scheduledAt === "string" ? doc.scheduledAt : "",
    sentAt: typeof doc.sentAt === "string" ? doc.sentAt : null,
    rescheduleCount: typeof doc.rescheduleCount === "number" ? doc.rescheduleCount : 0,
    createdAt: typeof doc.createdAt === "string" ? doc.createdAt : "",
  });
}

export async function searchEmails(input: SearchQuery): Promise<SearchResult> {
  if (!isSearchConfigured || !esClient) {
    return searchViaPostgres(input);
  }
  try {
    return await searchViaElasticsearch(input);
  } catch {
    return searchViaPostgres(input);
  }
}

async function searchViaElasticsearch(input: SearchQuery): Promise<SearchResult> {
  if (!esClient) return searchViaPostgres(input);

  const { from, size } = clampFromSize(input.page, input.limit);
  const filter: object[] = [{ term: { userId: input.userId } }];
  if (input.statuses && input.statuses.length > 0) {
    filter.push({ terms: { status: input.statuses } });
  }
  if (input.senderId) {
    filter.push({ term: { senderId: input.senderId } });
  }
  const rangeField = dateRangeField(input.statuses);
  if (input.from || input.to) {
    filter.push({
      range: {
        [rangeField]: {
          ...(input.from ? { gte: input.from.toISOString() } : {}),
          ...(input.to ? { lte: input.to.toISOString() } : {}),
        },
      },
    });
  }

  const must: object[] = [];
  if (input.q && input.q.trim()) {
    must.push({
      multi_match: {
        query: input.q.trim(),
        fields: ["subject^3", "body", "recipientEmail.text^2"],
        fuzziness: "AUTO",
      },
    });
  }

  const started = Date.now();
  const result = await esClient.search({
    index: emailsIndexName(),
    from,
    size,
    query: {
      bool: {
        ...(must.length > 0 ? { must } : { must: [{ match_all: {} }] }),
        filter,
      },
    },
    sort: [{ _score: { order: "desc" } }, { sentAt: { order: "desc", missing: "_last" } }],
  });
  const took = result.took ?? Date.now() - started;
  const totalRaw = result.hits.total;
  const total = typeof totalRaw === "number" ? totalRaw : (totalRaw?.value ?? 0);
  const hits = (result.hits.hits ?? [])
    .map((hit) => hitFromUnknown(hit._source))
    .filter((row): row is EmailSearchHit => row !== null);

  return {
    hits,
    total,
    took,
    degraded: false,
    page: input.page,
    limit: input.limit,
  };
}

export async function searchViaPostgres(input: SearchQuery): Promise<SearchResult> {
  const started = Date.now();
  const { from, size } = clampFromSize(input.page, input.limit);
  const where: Prisma.EmailJobWhereInput = { userId: input.userId };
  if (input.statuses && input.statuses.length > 0) {
    where.status = { in: input.statuses as Prisma.EnumEmailJobStatusFilter["in"] };
  }
  if (input.senderId) where.senderId = input.senderId;

  const rangeField = dateRangeField(input.statuses);
  if (input.from || input.to) {
    where[rangeField] = {
      ...(input.from ? { gte: input.from } : {}),
      ...(input.to ? { lte: input.to } : {}),
    };
  }

  const q = input.q?.trim();
  if (q) {
    where.OR = [
      { recipientEmail: { contains: q, mode: "insensitive" } },
      { recipientName: { contains: q, mode: "insensitive" } },
      { campaign: { subject: { contains: q, mode: "insensitive" } } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.emailJob.count({ where }),
    size === 0
      ? Promise.resolve([])
      : prisma.emailJob.findMany({
          where,
          orderBy: [{ sentAt: { sort: "desc", nulls: "last" } }, { scheduledAt: "desc" }],
          skip: from,
          take: size,
          include: {
            campaign: { select: { subject: true } },
            sender: { select: { email: true } },
          },
        }),
  ]);

  return {
    hits: rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      recipientEmail: row.recipientEmail,
      subject: row.campaign.subject,
      status: row.status,
      scheduledAt: row.scheduledAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
      senderEmail: row.sender.email,
      rescheduleCount: row.rescheduleCount,
    })),
    total,
    took: Date.now() - started,
    degraded: true,
    page: input.page,
    limit: input.limit,
  };
}
