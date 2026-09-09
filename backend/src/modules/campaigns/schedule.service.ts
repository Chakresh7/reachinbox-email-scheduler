export interface ScheduleInput {
  startAt: Date;
  index: number;
  delayBetweenMs: number;
  minDelayMs: number;
  /** Effective emails-per-hour cap for this sender/campaign. Must be >= 1. */
  hourlyLimit: number;
  windowMs: number;
}

/**
 * Intended send time for recipient `index` (0-based).
 *
 * Two offsets compete; the later one wins:
 *   pace   = index × delay          (min gap between individual sends)
 *   window = floor(index / limit) × 1 hour
 *
 * The window term is what keeps a 1000-recipient campaign with a 200/hour cap
 * from piling onto hour 1 and then being individually deferred. Runtime Redis
 * counters (Phase 2) remain the authority when other campaigns share a sender.
 */
export function computeScheduledAt(input: ScheduleInput): Date {
  if (input.index < 0) {
    throw new Error("sequence index must be >= 0");
  }
  if (input.hourlyLimit < 1) {
    throw new Error("hourly limit must be >= 1");
  }
  if (input.windowMs < 1) {
    throw new Error("rate-limit window must be >= 1ms");
  }

  const effectiveDelay = Math.max(input.delayBetweenMs, input.minDelayMs);
  const paceOffsetMs = input.index * effectiveDelay;
  const windowOffsetMs = Math.floor(input.index / input.hourlyLimit) * input.windowMs;
  return new Date(input.startAt.getTime() + Math.max(paceOffsetMs, windowOffsetMs));
}

export function effectiveDelayMs(requestedDelayMs: number, minDelayMs: number): number {
  return Math.max(requestedDelayMs, minDelayMs);
}

export function effectiveHourlyLimit(
  campaignLimit: number | null | undefined,
  senderLimit: number | null | undefined,
  envLimit: number,
): number {
  const candidates = [envLimit];
  if (typeof campaignLimit === "number" && campaignLimit > 0) candidates.push(campaignLimit);
  if (typeof senderLimit === "number" && senderLimit > 0) candidates.push(senderLimit);
  return Math.min(...candidates);
}

export function estimateCompletionAt(options: {
  startAt: Date;
  recipientCount: number;
  delayBetweenMs: number;
  minDelayMs: number;
  hourlyLimit: number;
  windowMs: number;
}): Date {
  if (options.recipientCount <= 0) return options.startAt;
  return computeScheduledAt({
    ...options,
    index: options.recipientCount - 1,
  });
}
