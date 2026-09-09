import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

/**
 * Assigns every request a correlation id and attaches a child logger.
 *
 * An inbound `x-request-id` is honoured so a trace can be followed across the
 * frontend and API, but it is length-capped: the value is echoed in a response
 * header, and reflecting unbounded client input is how header-injection and log
 * flooding start.
 */
const MAX_INBOUND_ID_LENGTH = 128;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header("x-request-id");
  const id =
    inbound && inbound.length <= MAX_INBOUND_ID_LENGTH && /^[\w.:-]+$/.test(inbound)
      ? inbound
      : randomUUID();

  req.id = id;
  req.log = logger.child({ requestId: id });
  res.setHeader("x-request-id", id);
  next();
}

/**
 * Access log emitted on response finish, so it records the real status code and
 * duration rather than guessing before the handler runs.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const log = req.log ?? logger;
    const payload = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };

    // Health probes are frequent and uninteresting at info level.
    if (req.path === "/healthz" || req.path === "/readyz") {
      log.debug(payload, "request");
    } else if (res.statusCode >= 500) {
      log.error(payload, "request failed");
    } else if (res.statusCode >= 400) {
      log.warn(payload, "request rejected");
    } else {
      log.info(payload, "request");
    }
  });

  next();
}
