/**
 * Error taxonomy.
 *
 * Every error the API returns carries a stable, machine-readable `code`, so the
 * frontend can branch on behaviour without string-matching human prose, and so
 * messages can be reworded without breaking clients.
 */

export const ErrorCode = {
  // 4xx
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  OAUTH_STATE_MISMATCH: "OAUTH_STATE_MISMATCH",
  FEATURE_NOT_CONFIGURED: "FEATURE_NOT_CONFIGURED",
  NO_ACTIVE_SENDER: "NO_ACTIVE_SENDER",
  CSV_NO_VALID_RECIPIENTS: "CSV_NO_VALID_RECIPIENTS",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",

  // 5xx
  INTERNAL: "INTERNAL",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  SMTP_FAILURE: "SMTP_FAILURE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  /** Structured detail safe to show a client (e.g. field-level issues). */
  details?: unknown;
  /** Underlying error, kept for logs. Never serialised to a response. */
  cause?: unknown;
  /** Seconds the client should wait before retrying (sets Retry-After). */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  /** True for errors we raised deliberately; false for unexpected crashes. */
  readonly isOperational = true;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace?.(this, AppError);
  }
}

/* ── Constructors for the cases that actually occur ────────────────────────── */

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, ErrorCode.VALIDATION_FAILED, message, { details });

export const unauthenticated = (message = "Authentication required") =>
  new AppError(401, ErrorCode.UNAUTHENTICATED, message);

export const forbidden = (message = "You do not have access to this resource") =>
  new AppError(403, ErrorCode.FORBIDDEN, message);

export const notFound = (resource = "Resource") =>
  new AppError(404, ErrorCode.NOT_FOUND, `${resource} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, ErrorCode.CONFLICT, message, { details });

export const tooManyRequests = (message: string, retryAfterSeconds?: number) =>
  new AppError(429, ErrorCode.TOO_MANY_REQUESTS, message, { retryAfterSeconds });

export const featureNotConfigured = (message: string) =>
  new AppError(503, ErrorCode.FEATURE_NOT_CONFIGURED, message);

export const dependencyUnavailable = (message: string, cause?: unknown) =>
  new AppError(503, ErrorCode.DEPENDENCY_UNAVAILABLE, message, { cause });

export const csvNoValidRecipients = (details?: unknown) =>
  new AppError(
    400,
    ErrorCode.CSV_NO_VALID_RECIPIENTS,
    "No valid email addresses were found in the uploaded file",
    { details },
  );

export const noActiveSender = (message = "No active SMTP sender is configured for this user") =>
  new AppError(400, ErrorCode.NO_ACTIVE_SENDER, message);

export const invalidState = (message: string) =>
  new AppError(409, ErrorCode.INVALID_STATE_TRANSITION, message);

/* ── Helpers ───────────────────────────────────────────────────────────────── */

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Best-effort message extraction from an `unknown` catch binding. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
