import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { forbidden } from "./lib/errors";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { requestId, requestLogger } from "./middleware/requestId";
import { campaignsRouter } from "./modules/campaigns/campaigns.routes";
import { emailsRouter } from "./modules/emails/emails.routes";
import { healthRouter } from "./modules/health/health.routes";
import { sendersRouter } from "./modules/senders/senders.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { createQueueBoardRouter, protectQueueBoard } from "./queues/board";

/**
 * Express application assembly.
 *
 * Exported without calling `listen` so tests can drive it through supertest
 * without binding a port. `server.ts` owns the socket.
 *
 * Middleware order is load-bearing: correlation id first so every later log
 * line carries it, error handler last so it can catch everything before it.
 */
export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in production, so req.ip and secure-cookie detection
  // read X-Forwarded-* instead of seeing the proxy as the client.
  if (env.isProd) {
    app.set("trust proxy", 1);
  }
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(requestLogger);

  app.use(
    helmet({
      // The API serves JSON to a separately-hosted SPA; a restrictive CSP here
      // protects nothing and would only complicate bull-board's UI, which
      // ships its own inline assets.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      // Explicit allowlist, never a wildcard: `origin: "*"` is incompatible
      // with credentialed requests, and the session lives in a cookie.
      origin: (origin, callback) => {
        if (!origin || env.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(forbidden(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "Idempotency-Key"],
      exposedHeaders: ["X-Request-Id", "Retry-After"],
      maxAge: 86_400,
    }),
  );

  // Bounded body sizes. CSV uploads go through multer with its own limit
  // (MAX_CSV_BYTES) rather than being parsed as JSON.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());

  // Health probes are mounted at the root, outside /api, so orchestrators and
  // the load balancer do not depend on API versioning.
  app.use(healthRouter);

  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/emails", emailsRouter);
  app.use("/api/senders", sendersRouter);
  app.use("/api/admin", adminRouter);
  app.use("/admin/queues", (req, res, next) => {
    void protectQueueBoard(req, res, next);
  }, createQueueBoardRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
