import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../config/env";
import { AppError, ErrorCode, type ErrorCodeValue, errorMessage, isAppError } from "../lib/errors";
import { logger } from "../lib/logger";

/**
 * The single place an error becomes an HTTP response.
 *
 * Every failure leaves this process in one shape:
 *   { error: { code, message, details?, requestId } }
 *
 * Two rules that matter in production:
 *  - 5xx messages are never echoed to the client outside development. A Prisma
 *    error string can contain table names, column names and connection details.
 *  - Unexpected errors are logged at `error` with the full stack; deliberate
 *    4xx errors are logged at `warn` without one, so real incidents stay
 *    visible instead of drowning in validation noise.
 */

interface ErrorResponseBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Prisma known-request errors carry a `code` like "P2002" (unique violation). */
function translatePrismaError(err: unknown): AppError | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { code?: unknown; name?: unknown; meta?: unknown };
  if (typeof candidate.code !== "string" || !candidate.code.startsWith("P")) return null;

  switch (candidate.code) {
    case "P2002":
      return new AppError(409, ErrorCode.CONFLICT, "That record already exists", {
        details: candidate.meta,
        cause: err,
      });
    case "P2003":
      return new AppError(400, ErrorCode.VALIDATION_FAILED, "Referenced record does not exist", {
        details: candidate.meta,
        cause: err,
      });
    case "P2025":
      return new AppError(404, ErrorCode.NOT_FOUND, "Record not found", { cause: err });
    case "P1001":
    case "P1002":
    case "P1017":
      return new AppError(503, ErrorCode.DEPENDENCY_UNAVAILABLE, "Database is unavailable", {
        cause: err,
      });
    default:
      return null;
  }
}

/** Body-parser and multer failures arrive as plain errors with a `type`/`code`. */
function translateBodyError(err: unknown): AppError | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { type?: unknown; code?: unknown; status?: unknown; message?: unknown };

  if (candidate.type === "entity.too.large" || candidate.code === "LIMIT_FILE_SIZE") {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, "Uploaded payload is too large");
  }
  if (candidate.type === "entity.parse.failed") {
    return new AppError(400, ErrorCode.VALIDATION_FAILED, "Request body is not valid JSON");
  }
  if (candidate.type === "charset.unsupported" || candidate.type === "encoding.unsupported") {
    return new AppError(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, "Unsupported content encoding");
  }
  return null;
}

function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (err instanceof ZodError) {
    return new AppError(400, ErrorCode.VALIDATION_FAILED, "Request validation failed", {
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
      cause: err,
    });
  }

  return (
    translatePrismaError(err) ??
    translateBodyError(err) ??
    new AppError(500, ErrorCode.INTERNAL, "Internal server error", { cause: err })
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express cannot change a response whose headers are already sent; the only
  // safe action is to destroy the socket and let the client see a broken
  // response rather than a corrupted one.
  if (res.headersSent) {
    (req.log ?? logger).error({ err }, "error raised after response headers were sent");
    res.destroy();
    return;
  }

  const appError = toAppError(err);
  const log = req.log ?? logger;

  if (appError.statusCode >= 500) {
    log.error(
      {
        err,
        code: appError.code,
        statusCode: appError.statusCode,
        method: req.method,
        path: req.originalUrl,
      },
      appError.message,
    );
  } else {
    log.warn(
      {
        code: appError.code,
        statusCode: appError.statusCode,
        method: req.method,
        path: req.originalUrl,
        details: appError.details,
      },
      appError.message,
    );
  }

  if (appError.retryAfterSeconds !== undefined) {
    res.setHeader("retry-after", String(appError.retryAfterSeconds));
  }

  const exposeMessage = appError.statusCode < 500 || env.isDev || env.isTest;

  const body: ErrorResponseBody = {
    error: {
      code: appError.code,
      message: exposeMessage ? appError.message : "Internal server error",
      requestId: req.id,
    },
  };
  if (appError.details !== undefined) {
    body.error.details = appError.details;
  }

  res.status(appError.statusCode).json(body);

  // `next` is unused, but a four-argument signature is how Express identifies
  // error middleware. Removing the parameter silently turns this into a
  // regular handler that never runs.
  void next;
}

/** Terminal 404 for unmatched routes, so unknown paths get the same envelope. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Cannot ${req.method} ${req.originalUrl}`,
      requestId: req.id,
    },
  } satisfies ErrorResponseBody);
}

// Note: no `asyncHandler` wrapper here on purpose. Express 5 forwards a
// rejected promise from a handler to error middleware automatically, so async
// route handlers need no wrapping.

export { errorMessage };
