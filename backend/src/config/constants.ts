import { env } from "./env";

/**
 * Queue names, job ids and Redis key builders.
 *
 * Every Redis key the scheduler writes goes through here so a typo cannot
 * silently create a second, unused namespace. Rate-limit keys share REDIS_PREFIX
 * with BullMQ so one Redis can host multiple environments.
 */

export const QueueName = {
  campaignExpand: "campaign-expand",
  emailSend: "email-send",
  searchIndex: "search-index",
} as const;

export const JobName = {
  expandBatch: "expand-batch",
  sendEmail: "send-email",
  indexEmail: "index-email",
} as const;

export function emailSendJobId(emailJobId: string): string {
  // BullMQ 6 forbids `:` in custom ids unless there are exactly three
  // segments (repeatable-job form). `email:<uuid>` is two segments and
  // throws "Custom Id cannot contain :". The trailing `:send` keeps the
  // id deterministic and unique per email_jobs row.
  return `email:${emailJobId}:send`;
}

export function campaignExpandJobId(campaignId: string, batchIndex: number): string {
  return `expand:${campaignId}:${batchIndex}`;
}

export function searchIndexJobId(emailJobId: string): string {
  return `index:${emailJobId}:doc`;
}

export function searchIndexBulkJobId(campaignId: string, batchIndex: number): string {
  return `bulk:${campaignId}:${batchIndex}`;
}

export function idempotencyRedisKey(hash: string): string {
  return `idem:api:${hash}`;
}

const k = `${env.REDIS_PREFIX}:`;

export function rlGlobalKey(hourEpoch: number): string {
  return `${k}rl:global:${hourEpoch}`;
}

export function rlSenderKey(senderId: string, hourEpoch: number): string {
  return `${k}rl:sender:${senderId}:${hourEpoch}`;
}

export function paceSenderKey(senderId: string): string {
  return `${k}pace:sender:${senderId}`;
}

export function overflowKey(senderId: string, hourEpoch: number): string {
  return `${k}overflow:${senderId}:${hourEpoch}`;
}

export function rateLimitNotifyKey(senderId: string, hourEpoch: number): string {
  return `${k}notif:rl:${senderId}:${hourEpoch}`;
}

export function reconcileLastKey(): string {
  return `${k}reconcile:last`;
}

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const RATE_LIMIT_NOTIFY_TTL_SECONDS = 7_200;
export const OVERFLOW_KEY_TTL_SECONDS = 7_200;

export const defaultJobOptions = {
  removeOnComplete: { age: 86_400, count: 5000 },
  removeOnFail: { age: 604_800 },
} as const;
