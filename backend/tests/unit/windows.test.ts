import { describe, expect, it } from "vitest";
import { hourEpoch, nextWindowStart, overflowScheduledAt } from "../../src/ratelimit/windows";

const HOUR = 3_600_000;
const now = Date.parse("2026-09-09T13:15:00.000Z");

describe("hour windows", () => {
  it("snaps now to the start of the UTC hour", () => {
    expect(hourEpoch(now, HOUR)).toBe(Date.parse("2026-09-09T13:00:00.000Z"));
    expect(nextWindowStart(now, HOUR)).toBe(Date.parse("2026-09-09T14:00:00.000Z"));
  });

  it("places rank 1 at the next window start plus jitter", () => {
    const at = overflowScheduledAt({
      nowMs: now,
      windowMs: HOUR,
      rank: 1,
      effectiveDelayMs: 2000,
      jitterMs: 40,
    });
    expect(at.getTime()).toBe(Date.parse("2026-09-09T14:00:00.040Z"));
  });

  it("paces later ranks by effectiveDelay", () => {
    const at = overflowScheduledAt({
      nowMs: now,
      windowMs: HOUR,
      rank: 4,
      effectiveDelayMs: 2000,
      jitterMs: 0,
    });
    expect(at.getTime()).toBe(Date.parse("2026-09-09T14:00:00.000Z") + 3 * 2000);
  });
});
