import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { disconnectPrisma } from "../../src/lib/prisma";
import { disconnectRedis } from "../../src/lib/redis";

/**
 * Contract tests driven through the exported Express app, with no listener
 * bound. This proves the app is testable in isolation, which is what makes the
 * Phase 1+ endpoint suite cheap to write.
 *
 * Scope is deliberately limited to routes that touch no dependency. `/readyz`
 * needs a real Postgres and Redis, so it is verified against the live cloud
 * services in the Phase 0 exit checks rather than mocked into meaninglessness
 * here.
 *
 * Importing the app constructs the datastore clients as a module side effect,
 * so they are closed below or Vitest would hang on open handles.
 */
afterAll(async () => {
  await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
});

describe("GET /healthz", () => {
  it("reports liveness without touching any dependency", async () => {
    const response = await request(app).get("/healthz").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      version: expect.any(String),
      pid: expect.any(Number),
      uptimeSeconds: expect.any(Number),
    });
  });

  it("echoes a correlation id on every response", async () => {
    const response = await request(app).get("/healthz").expect(200);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("honours a caller-supplied correlation id", async () => {
    const response = await request(app)
      .get("/healthz")
      .set("x-request-id", "trace-abc-123")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("trace-abc-123");
  });

  it("replaces a malformed correlation id rather than reflecting it", async () => {
    // Reflecting unbounded client input into a response header is how header
    // injection and log flooding start.
    const response = await request(app)
      .get("/healthz")
      .set("x-request-id", "bad id with spaces")
      .expect(200);

    expect(response.headers["x-request-id"]).not.toBe("bad id with spaces");
  });
});

describe("error envelope", () => {
  it("returns the standard shape for an unknown route", async () => {
    const response = await request(app).get("/api/does-not-exist").expect(404);

    expect(response.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Cannot GET /api/does-not-exist",
        requestId: expect.any(String),
      },
    });
  });

  it("does not leak the x-powered-by header", async () => {
    const response = await request(app).get("/healthz").expect(200);
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("applies security headers from helmet", async () => {
    const response = await request(app).get("/healthz").expect(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});
