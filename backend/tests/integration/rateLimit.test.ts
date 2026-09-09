import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { reconcileEmailJobs } from "../../src/bootstrap/reconcile";
import { app } from "../../src/app";
import { env } from "../../src/config/env";
import { emailSendJobId, paceSenderKey, rlSenderKey } from "../../src/config/constants";
import { prisma, disconnectPrisma } from "../../src/lib/prisma";
import { disconnectRedis, redis } from "../../src/lib/redis";
import { hourEpoch } from "../../src/ratelimit";
import { setMailSenderForTests } from "../../src/mailer/types";
import { campaignExpandQueue } from "../../src/queues/campaignExpand.queue";
import { emailSendQueue } from "../../src/queues/emailSend.queue";
import { searchIndexQueue } from "../../src/queues/searchIndex.queue";
import { releaseSlot, reserveSlot } from "../../src/ratelimit";
import { startCampaignExpandWorker } from "../../src/workers/campaignExpand.worker";
import { startEmailSendWorker } from "../../src/workers/emailSend.worker";
import type { Worker } from "bullmq";

const run = Boolean(process.env.RUN_INTEGRATION) && Boolean(env.DEV_USER_ID);

describe.skipIf(!run)("rate limiter (live Redis)", () => {
  const futureNow = (Math.floor(Math.random() * 40_000) + 8_000) * 3_600_000;
  const senderId = randomUUID();

  it("grants exactly 200 of 500 concurrent reservations", async () => {
    const attempts = Array.from({ length: 500 }, () =>
      reserveSlot({
        senderId,
        globalLimit: 200,
        senderLimit: 200,
        minDelayMs: 0,
        maxInlineWaitMs: 60_000,
        nowMs: futureNow,
        windowMs: 3_600_000,
      }),
    );
    const results = await Promise.all(attempts);
    const allow = results.filter((r) => r.kind === "ALLOW").length;
    const denied = results.filter((r) => r.kind === "DENIED").length;
    expect(allow).toBe(200);
    expect(denied).toBe(300);
  });

  it("does not increment counters on PACE, and releaseSlot never goes negative", async () => {
    const pacedSender = randomUUID();
    const first = await reserveSlot({
      senderId: pacedSender,
      globalLimit: 1000,
      senderLimit: 1000,
      minDelayMs: 10_000,
      maxInlineWaitMs: 1,
      nowMs: futureNow,
      windowMs: 3_600_000,
    });
    expect(first.kind).toBe("ALLOW");

    const second = await reserveSlot({
      senderId: pacedSender,
      globalLimit: 1000,
      senderLimit: 1000,
      minDelayMs: 10_000,
      maxInlineWaitMs: 1,
      nowMs: futureNow + 50,
      windowMs: 3_600_000,
    });
    expect(second.kind).toBe("PACE");

    await releaseSlot(pacedSender, futureNow, 3_600_000);
    await releaseSlot(pacedSender, futureNow, 3_600_000);
    await releaseSlot(pacedSender, futureNow, 3_600_000);

    const third = await reserveSlot({
      senderId: pacedSender,
      globalLimit: 1000,
      senderLimit: 1000,
      minDelayMs: 0,
      maxInlineWaitMs: 60_000,
      nowMs: futureNow,
      windowMs: 3_600_000,
    });
    expect(third.kind).toBe("ALLOW");
  });
});

describe.skipIf(!run)("email-send respects per-sender hourly limit", () => {
  let expand: Worker;
  let send: Worker | undefined;
  const recorded: string[] = [];
  let previousLimit: number | null = null;
  let senderId: string | null = null;

  beforeAll(async () => {
    setMailSenderForTests({
      async send(message) {
        recorded.push(message.to);
        return {
          messageId: `<rl-${Date.now()}@ethereal.email>`,
          previewUrl: "https://ethereal.email/message/test",
          response: "250 OK",
        };
      },
    });
    const sender = await prisma.sender.findFirst({
      where: { userId: env.DEV_USER_ID, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!sender) throw new Error("seed senders first");
    senderId = sender.id;
    previousLimit = sender.maxEmailsPerHour;
    // Keep a high sender cap while expanding so pre-spread does not park
    // recipients 3–5 in the next hour before Lua can deny them.
    await prisma.sender.update({ where: { id: sender.id }, data: { maxEmailsPerHour: 200 } });
    await prisma.sender.updateMany({
      where: { userId: env.DEV_USER_ID, id: { not: sender.id } },
      data: { isActive: false },
    });

    expand = startCampaignExpandWorker();
    await expand.waitUntilReady();
  });

  afterAll(async () => {
    setMailSenderForTests(null);
    if (senderId) {
      await prisma.sender.update({
        where: { id: senderId },
        data: { maxEmailsPerHour: previousLimit },
      });
      await prisma.sender.updateMany({
        where: { userId: env.DEV_USER_ID },
        data: { isActive: true },
      });
    }
    await expand?.close();
    await send?.close();
  });

  it("sends 2 and defers the rest when the sender hourly cap is 2", async () => {
    recorded.length = 0;
    const key = `rl-${Date.now()}`;
    const csv = "a1@example.com\na2@example.com\na3@example.com\na4@example.com\na5@example.com\n";
    const created = await request(app)
      .post("/api/campaigns")
      .set("Idempotency-Key", key)
      .field("subject", `Rate limit ${key}`)
      .field("body", "Hello")
      .field("startAt", new Date().toISOString())
      .field("delayBetweenMs", "0")
      .field("hourlyLimit", "200")
      .attach("file", Buffer.from(csv), "leads.csv")
      .expect(202);

    const campaignId = created.body.data.campaignId as string;
    const expandDeadline = Date.now() + 20_000;
    while (Date.now() < expandDeadline) {
      const n = await prisma.emailJob.count({ where: { campaignId } });
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });
      if (n === 5 && campaign?.status === "scheduled") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await prisma.emailJob.count({ where: { campaignId } })).toBe(5);
    const expanded = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(expanded?.status).toBe("scheduled");
    const rows = await prisma.emailJob.findMany({ where: { campaignId }, select: { id: true } });
    for (const row of rows) {
      expect(await emailSendQueue.getJob(emailSendJobId(row.id))).toBeTruthy();
    }

    await prisma.sender.update({
      where: { id: senderId! },
      data: { maxEmailsPerHour: 2 },
    });
    const epoch = hourEpoch(Date.now(), env.RATE_LIMIT_WINDOW_MS);
    await redis.del(rlSenderKey(senderId!, epoch), paceSenderKey(senderId!));

    send = startEmailSendWorker();
    await send.waitUntilReady();

    const deadline = Date.now() + 40_000;
    let sent = 0;
    let deferred = 0;
    while (Date.now() < deadline) {
      sent = await prisma.emailJob.count({ where: { campaignId, status: "sent" } });
      deferred = await prisma.emailJob.count({ where: { campaignId, status: "rate_limited" } });
      if (sent === 2 && deferred === 3) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(sent).toBe(2);
    expect(deferred).toBe(3);
    expect(recorded).toHaveLength(2);

    const events = await prisma.rateLimitEvent.findMany({
      where: { senderId: senderId ?? undefined },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(events[0]?.jobsDeferred).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!run)("reconciler", () => {
  it("restores a missing delayed job by deterministic id and is idempotent", async () => {
    const sender = await prisma.sender.findFirst({
      where: { userId: env.DEV_USER_ID, isActive: true },
    });
    expect(sender).toBeTruthy();
    if (!sender) return;

    const campaign = await prisma.campaign.create({
      data: {
        userId: env.DEV_USER_ID,
        subject: "Reconcile",
        body: "x",
        startAt: new Date(Date.now() + 60_000),
        delayBetweenMs: 2000,
        totalRecipients: 1,
        status: "scheduled",
        recipients: [{ email: "recon@example.com", name: null }],
      },
    });

    const job = await prisma.emailJob.create({
      data: {
        campaignId: campaign.id,
        userId: env.DEV_USER_ID,
        senderId: sender.id,
        recipientEmail: "recon@example.com",
        sequenceIndex: 0,
        scheduledAt: new Date(Date.now() + 120_000),
        originalScheduledAt: new Date(),
        status: "scheduled",
        dedupeKey: `recon-${campaign.id}`,
      },
    });

    const bullId = emailSendJobId(job.id);
    const existing = await emailSendQueue.getJob(bullId);
    if (existing) await existing.remove();

    const first = await reconcileEmailJobs();
    expect(first.restored).toBeGreaterThanOrEqual(1);
    expect(await emailSendQueue.getJob(bullId)).toBeTruthy();

    const second = await reconcileEmailJobs();
    expect(second.restored).toBe(0);
    expect(await emailSendQueue.getJob(bullId)).toBeTruthy();
  });
});

describe.skipIf(!run)("bull-board auth", () => {
  it("rejects unauthenticated visitors", async () => {
    const res = await request(app).get("/admin/queues");
    expect(res.status).toBe(401);
  });
});

afterAll(async () => {
  await Promise.allSettled([
    emailSendQueue.close(),
    campaignExpandQueue.close(),
    searchIndexQueue.close(),
    disconnectPrisma(),
    disconnectRedis(),
  ]);
});
