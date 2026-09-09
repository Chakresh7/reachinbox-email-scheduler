import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app";
import { env } from "../../src/config/env";
import { disconnectPrisma } from "../../src/lib/prisma";
import { disconnectRedis } from "../../src/lib/redis";
import { closeProducerQueues } from "../../src/queues/close";

const run = Boolean(process.env.RUN_INTEGRATION) && Boolean(env.DEV_USER_ID);

describe.skipIf(!run)("auth session fallback", () => {
  it("GET /api/auth/me returns the DEV_USER_ID identity without a Google cookie", async () => {
    const response = await request(app).get("/api/auth/me").expect(200);
    expect(response.body.data).toMatchObject({
      id: env.DEV_USER_ID,
      email: expect.any(String),
      name: expect.any(String),
      isAdmin: expect.any(Boolean),
    });
  });

  it("POST /api/auth/logout clears the session cookie", async () => {
    await request(app).post("/api/auth/logout").expect(204);
  });

  it("GET /api/slack/install without Slack credentials returns FEATURE_NOT_CONFIGURED", async () => {
    const response = await request(app).get("/api/slack/install");
    if (env.features.slack) {
      expect(response.status).toBe(302);
      expect(String(response.headers.location)).toMatch(/slack\.com\/oauth/);
      return;
    }
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FEATURE_NOT_CONFIGURED");
  });

  it("POST /api/slack/test without a connection is INVALID_STATE_TRANSITION", async () => {
    const status = await request(app).get("/api/slack/status").expect(200);
    if (status.body.data.connected) return;
    const response = await request(app).post("/api/slack/test");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_STATE_TRANSITION");
  });
});

afterAll(async () => {
  await Promise.allSettled([closeProducerQueues(), disconnectPrisma(), disconnectRedis()]);
});
