export function hourEpoch(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function nextWindowStart(nowMs: number, windowMs: number): number {
  return hourEpoch(nowMs, windowMs) + windowMs;
}

export function overflowScheduledAt(input: {
  nowMs: number;
  windowMs: number;
  rank: number;
  effectiveDelayMs: number;
  jitterMs: number;
}): Date {
  if (input.rank < 1) {
    throw new Error("overflow rank must be >= 1");
  }
  if (input.effectiveDelayMs < 0) {
    throw new Error("effective delay must be >= 0");
  }
  const start = nextWindowStart(input.nowMs, input.windowMs);
  const paced = (input.rank - 1) * input.effectiveDelayMs;
  return new Date(start + paced + input.jitterMs);
}

export function jitterMs(maxInclusive = 250): number {
  return Math.floor(Math.random() * (maxInclusive + 1));
}
