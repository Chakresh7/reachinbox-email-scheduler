import { featureNotConfigured } from "../../lib/errors";
import { indexDocuments, isSearchConfigured } from "../../lib/elasticsearch";
import { prisma } from "../../lib/prisma";
import { toSearchDocument } from "./document";

const BATCH = 500;

export interface ReindexResult {
  indexed: number;
  batches: number;
}

/**
 * Stream every email_jobs row into Elasticsearch. Admin-only rebuild after
 * an outage; `_id` upserts so it is safe to run twice.
 */
export async function reindexAllEmailJobs(): Promise<ReindexResult> {
  if (!isSearchConfigured) {
    throw featureNotConfigured("Elasticsearch is not configured. Set SEARCH_ENABLED and ELASTICSEARCH_URL.");
  }

  let indexed = 0;
  let batches = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.emailJob.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      take: BATCH,
      include: {
        campaign: { select: { subject: true, body: true } },
        sender: { select: { email: true } },
      },
    });
    if (rows.length === 0) break;

    indexed += await indexDocuments(rows.map(toSearchDocument));
    batches += 1;
    cursor = rows[rows.length - 1]?.id;
    if (rows.length < BATCH) break;
  }

  return { indexed, batches };
}
