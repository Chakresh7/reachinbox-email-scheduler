/**
 * API contract types.
 *
 * Deliberately duplicated from the backend rather than shared through a
 * workspace package: a `packages/shared` build step costs more than it saves at
 * this size (DESIGN.md §1). The trade-off is that these must be kept in step by
 * hand, so every type here mirrors one response shape exactly.
 */

/* ── Envelope ──────────────────────────────────────────────────────────────── */

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "TOO_MANY_REQUESTS"
  | "OAUTH_STATE_MISMATCH"
  | "FEATURE_NOT_CONFIGURED"
  | "NO_ACTIVE_SENDER"
  | "CSV_NO_VALID_RECIPIENTS"
  | "INVALID_STATE_TRANSITION"
  | "INTERNAL"
  | "DEPENDENCY_UNAVAILABLE"
  | "SMTP_FAILURE"
  | "NETWORK";

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

/* ── Health ────────────────────────────────────────────────────────────────── */

export type DependencyState = "ok" | "degraded" | "down" | "not_configured";

export interface DependencyReport {
  status: DependencyState;
  critical: boolean;
  latencyMs?: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ReadinessReport {
  status: "ok" | "degraded" | "unavailable";
  uptimeSeconds: number;
  version: string;
  environment: string;
  checkedAt: string;
  dependencies: {
    postgres: DependencyReport;
    redis: DependencyReport;
    elasticsearch: DependencyReport;
  };
}

/* ── Domain (populated across later phases; shapes fixed now) ──────────────── */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

/** Mirrors the EmailJobStatus enum in the Prisma schema. */
export type EmailStatus =
  | "scheduled"
  | "rate_limited"
  | "claimed"
  | "sent"
  | "failed"
  | "cancelled"
  | "needs_review";

export interface EmailJobSummary {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  senderEmail: string;
  /** How many hour windows this email was pushed by the rate limiter. */
  rescheduleCount: number;
  previewUrl: string | null;
  lastError: string | null;
}

export interface CampaignSummary {
  id: string;
  subject: string;
  status: "draft" | "expanding" | "scheduled" | "running" | "completed" | "cancelled" | "failed";
  startAt: string;
  delayBetweenMs: number;
  hourlyLimit: number | null;
  totalRecipients: number;
  createdAt: string;
  counts: Record<EmailStatus, number>;
}

export interface SlackStatus {
  connected: boolean;
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
}

export interface SearchHit {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  senderEmail: string;
  rescheduleCount: number;
}

export interface SearchMeta extends PageMeta {
  took: number;
  degraded: boolean;
}

export interface SearchResponse {
  data: SearchHit[];
  meta: SearchMeta;
}
