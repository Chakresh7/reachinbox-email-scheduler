import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Worker } from "bullmq";
import { app } from "../../src/app";
import { ensureIndices } from "../../src/bootstrap/ensureIndices";
import { env } from "../../src/config/env";
import { emailsIndexName, esClient, isSearchConfigured } from "../../src/lib/elasticsearch";
import { prisma, disconnectPrisma } from "../../src/lib/prisma";
import { disconnectRedis } from "../../src/lib/redis";
import { setMailSenderForTests } from "../../src/mailer/types";
import { searchViaPostgres } from "../../src/modules/search/search.service";
import { campaignExpandQueue } from "../../src/queues/campaignExpand.queue";
import { emailSendQueue } from "../../src/queues/emailSend.queue";
import { searchIndexQueue } from "../../src/queues/searchIndex.queue";
import { startCampaignExpandWorker } from "../../src/workers/campaignExpand.worker";
import { startEmailSendWorker } from "../../src/workers/emailSend.worker";
import { startSearchIndexWorker } from "../../src/workers/searchIndex.worker";

const run = Boolean(process.env.RUN_INTEGRATION) && Boolean(env.DEV_USER_ID);

describe.skipIf(!run)("search API", () => {
  let expand: Worker;
  let send: Worker;
  let index: Worker | undefined;

  beforeAll(async () => {
    setMailSenderForTests({
      async send() {
        return {
          messageId: `<search-${Date.now()}@ethereal.email>`,
          previewUrl: "https://ethereal.email/message/test",
          response: "250 OK",
        };
      },
    });
    if (isSearchConfigured) {
      await ensureIndices();
      index = startSearchIndexWorker();
    }
    expand = startCampaignExpandWorker();
    send = startEmailSendWorker();
    await Promise.all([
      expand.waitUntilReady(),
      send.waitUntilReady(),
      index?.waitUntilReady() ?? Promise.resolve(),
    ]);
  });

  afterAll(async () => {
    setMailSenderForTests(null);
    await expand?.close();
    await send?.close();
    await index?.close();
    await Promise.allSettled([
      emailSendQueue.close(),
      campaignExpandQueue.close(),
      searchIndexQueue.close(),
      disconnectPrisma(),
      disconnectRedis(),
    ]);
  });

  it("finds scheduled and sent rows by subject and recipient", async () => {
    const key = `search-${Date.now()}`;
    const subject = `Searchable ${key}`;
    const csv = `alpha-${key}@example.com\nbeta-${key}@example.com\n`;
    const created = await request(app)
      .post("/api/campaigns")
      .set("Idempotency-Key", key)
      .field("subject", subject)
      .field("body", "Search body")
      .field("startAt", new Date().toISOString())
      .field("delayBetweenMs", "0")
      .attach("file", Buffer.from(csv), "leads.csv")
      .expect(202);

    const campaignId = created.body.data.campaignId as string;
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const n = await prisma.emailJob.count({ where: { campaignId } });
      if (n === 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await prisma.emailJob.count({ where: { campaignId } })).toBe(2);

    const pg = await searchViaPostgres({
      userId: env.DEV_USER_ID,
      q: key,
      page: 1,
      limit: 25,
    });
    expect(pg.degraded).toBe(true);
    expect(pg.hits.length).toBeGreaterThanOrEqual(2);

    if (isSearchConfigured && esClient) {
      const refreshDeadline = Date.now() + 25_000;
      let hits: unknown[] = [];
      let degraded = true;
      while (Date.now() < refreshDeadline) {
        await esClient.indices.refresh({ index: emailsIndexName() }).catch(() => undefined);
        const res = await request(app).get("/api/search").query({ q: key, limit: 25 });
        if (res.status === 200 && res.body.meta?.degraded === false && (res.body.data?.length ?? 0) >= 2) {
          hits = res.body.data;
          degraded = res.body.meta.degraded;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      expect(degraded).toBe(false);
      expect(hits.length).toBeGreaterThanOrEqual(2);
      const byRecipient = await request(app)
        .get("/api/search")
        .query({ q: `alpha-${key}`, limit: 25 })
        .expect(200);
      expect(byRecipient.body.meta.degraded).toBe(false);
      expect(byRecipient.body.data.length).toBeGreaterThanOrEqual(1);
    } else {
      const res = await request(app).get("/api/search").query({ q: key, limit: 25 }).expect(200);
      expect(res.body.meta.degraded).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("rebuilds from Postgres without duplicating documents", async () => {
    if (!isSearchConfigured) {
      const res = await request(app).post("/api/admin/reindex").expect(503);
      expect(res.body.error.code).toBe("FEATURE_NOT_CONFIGURED");
      return;
    }

    const first = await request(app).post("/api/admin/reindex").expect(200);
    expect(first.body.data.indexed).toBeGreaterThanOrEqual(0);
    const second = await request(app).post("/api/admin/reindex").expect(200);
    expect(second.body.data.indexed).toBe(first.body.data.indexed);

    if (esClient) {
      await esClient.indices.refresh({ index: emailsIndexName() }).catch(() => undefined);
    }
  });
});
