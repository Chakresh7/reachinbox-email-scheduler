import { describe, expect, it } from "vitest";
import {
  computeScheduledAt,
  effectiveDelayMs,
  effectiveHourlyLimit,
  estimateCompletionAt,
} from "../../src/modules/campaigns/schedule.service";

const start = new Date("2026-01-01T12:00:00.000Z");
const HOUR = 3_600_000;

describe("computeScheduledAt", () => {
  it("clamps a requested delay below the floor", () => {
    expect(effectiveDelayMs(0, 2000)).toBe(2000);
    const at = computeScheduledAt({
      startAt: start,
      index: 3,
      delayBetweenMs: 0,
      minDelayMs: 2000,
      hourlyLimit: 200,
      windowMs: HOUR,
    });
    expect(at.getTime()).toBe(start.getTime() + 3 * 2000);
  });

  it("places index == hourlyLimit into the next hour window", () => {
    const lastInWindow = computeScheduledAt({
      startAt: start,
      index: 199,
      delayBetweenMs: 2000,
      minDelayMs: 2000,
      hourlyLimit: 200,
      windowMs: HOUR,
    });
    const firstNextWindow = computeScheduledAt({
      startAt: start,
      index: 200,
      delayBetweenMs: 2000,
      minDelayMs: 2000,
      hourlyLimit: 200,
      windowMs: HOUR,
    });
    expect(lastInWindow.getTime()).toBe(start.getTime() + 199 * 2000);
    expect(firstNextWindow.getTime()).toBe(start.getTime() + HOUR);
  });

  it("spreads 1000 recipients at 200/hour across 5 hour windows", () => {
    const times = Array.from({ length: 1000 }, (_, i) =>
      computeScheduledAt({
        startAt: start,
        index: i,
        delayBetweenMs: 2000,
        minDelayMs: 2000,
        hourlyLimit: 200,
        windowMs: HOUR,
      }).getTime(),
    );
    const last = times[999] as number;
    expect(last).toBe(start.getTime() + 4 * HOUR);
    expect(times[200]).toBe(start.getTime() + HOUR);
    expect(new Set(times.slice(0, 200).map((t) => Math.floor((t - start.getTime()) / HOUR)))).toEqual(
      new Set([0]),
    );
  });

  it("estimateCompletionAt uses the last index", () => {
    const end = estimateCompletionAt({
      startAt: start,
      recipientCount: 5,
      delayBetweenMs: 2000,
      minDelayMs: 2000,
      hourlyLimit: 200,
      windowMs: HOUR,
    });
    expect(end.getTime()).toBe(start.getTime() + 4 * 2000);
  });

  it("effectiveHourlyLimit is the min of campaign, sender and env", () => {
    expect(effectiveHourlyLimit(50, 200, 1000)).toBe(50);
    expect(effectiveHourlyLimit(null, 200, 1000)).toBe(200);
    expect(effectiveHourlyLimit(undefined, undefined, 1000)).toBe(1000);
  });
});
