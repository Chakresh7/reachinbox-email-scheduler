import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma, disconnectPrisma } from "../../src/lib/prisma";
import { disconnectRedis } from "../../src/lib/redis";
import { setMailSenderForTests } from "../../src/mailer/types";
import { campaignExpandQueue } from "../../src/queues/campaignExpand.queue";
import { emailSendQueue } from "../../src/queues/emailSend.queue";
import { notificationsQueue } from "../../src/queues/notifications.queue";
import { searchIndexQueue } from "../../src/queues/searchIndex.queue";
import { startCampaignExpandWorker } from "../../src/workers/campaignExpand.worker";
import { processEmailSendJob, startEmailSendWorker } from "../../src/workers/emailSend.worker";
import { claimEmailJob } from "../../src/workers/shared/claimEmailJob";
import type { Worker } from "bullmq";

const run = Boolean(process.env.RUN_INTEGRATION) && Boolean(env.DEV_USER_ID);

describe.skipIf(!run)("campaign schedule pipeline", () => {
  let expand: Worker;
  let send: Worker;
  const recorded: { to: string; subject: string }[] = [];

  beforeAll(async () => {
    setMailSenderForTests({
      async send(message) {
        recorded.push({ to: message.to, subject: message.subject });
        return {
          messageId: `<test-${Date.now()}@ethereal.email>`,
          previewUrl: "https://ethereal.email/message/test",
          response: "250 OK",
        };
      },
    });
    expand = startCampaignExpandWorker();
    send = startEmailSendWorker();
    await Promise.all([expand.waitUntilReady(), send.waitUntilReady()]);
  });

  afterAll(async () => {
    setMailSenderForTests(null);
    await expand?.close();
    await send?.close();
    await Promise.allSettled([
      emailSendQueue.close(),
      campaignExpandQueue.close(),
      searchIndexQueue.close(),
      notificationsQueue.close(),
      disconnectPrisma(),
      disconnectRedis(),
    ]);
  });

  it("schedules unique recipients and sends exactly once", async () => {
    recorded.length = 0;
    const key = `it-${Date.now()}`;
    const subject = `Integration ${key}`;
    const csv = "ok@example.com\nok@example.com\nbad-email\nalso@example.com\n";

    const created = await request(app)
      .post("/api/campaigns")
      .set("Idempotency-Key", key)
      .field("subject", subject)
      .field("body", "Hello")
      .field("startAt", new Date().toISOString())
      .field("delayBetweenMs", "0")
      .attach("file", Buffer.from(csv), "leads.csv")
      .expect(202);

    expect(created.body.data.validCount).toBe(2);
    expect(created.body.data.duplicateCount).toBe(1);

    const replay = await request(app)
      .post("/api/campaigns")
      .set("Idempotency-Key", key)
      .field("subject", subject)
      .field("body", "Hello")
      .field("startAt", new Date().toISOString())
      .field("delayBetweenMs", "0")
      .attach("file", Buffer.from(csv), "leads.csv")
      .expect(202);

    expect(replay.body.data.campaignId).toBe(created.body.data.campaignId);

    const campaignId = created.body.data.campaignId as string;
    const deadline = Date.now() + 25_000;
    let sentCount = 0;
    while (Date.now() < deadline) {
      sentCount = await prisma.emailJob.count({ where: { campaignId, status: "sent" } });
      if (sentCount === 2) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(sentCount).toBe(2);
    expect(recorded.filter((row) => row.subject === subject)).toHaveLength(2);
    const jobs = await prisma.emailJob.findMany({ where: { campaignId } });
    expect(jobs).toHaveLength(2);
  });

  it("claims and sends a job only once under concurrent processors", async () => {
    const sender = await prisma.sender.findFirst({
      where: { userId: env.DEV_USER_ID, isActive: true },
    });
    expect(sender).toBeTruthy();
    if (!sender) return;

    const campaign = await prisma.campaign.create({
      data: {
        userId: env.DEV_USER_ID,
        subject: "Race",
        body: "Once",
        startAt: new Date(),
        delayBetweenMs: 2000,
        totalRecipients: 1,
        status: "scheduled",
        recipients: [{ email: "race@example.com", name: null }],
      },
    });

    const job = await prisma.emailJob.create({
      data: {
        campaignId: campaign.id,
        userId: env.DEV_USER_ID,
        senderId: sender.id,
        recipientEmail: "race@example.com",
        sequenceIndex: 0,
        scheduledAt: new Date(),
        originalScheduledAt: new Date(),
        status: "scheduled",
        dedupeKey: `race-${campaign.id}`,
      },
    });

    recorded.length = 0;
    await send.pause();
    try {
      const [firstClaim, secondClaim] = await Promise.all([
        claimEmailJob(job.id),
        claimEmailJob(job.id),
      ]);
      expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);

      await prisma.emailJob.update({
        where: { id: job.id },
        data: { status: "scheduled", claimedAt: null, attemptCount: 0 },
      });

      const before = recorded.length;
      await Promise.all([processEmailSendJob(job.id), processEmailSendJob(job.id)]);
      expect(recorded.length - before).toBe(1);

      const latest = await prisma.emailJob.findUnique({ where: { id: job.id } });
      expect(latest?.status).toBe("sent");
    } finally {
      await send.resume();
    }
  });
});
