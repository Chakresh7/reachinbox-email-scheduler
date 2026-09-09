import { describe, expect, it } from "vitest";
import { dateRangeField } from "../../src/modules/search/dateRange";

describe("dateRangeField", () => {
  it("uses scheduledAt when no statuses are given", () => {
    expect(dateRangeField(undefined)).toBe("scheduledAt");
    expect(dateRangeField([])).toBe("scheduledAt");
  });

  it("uses sentAt only when every status is sent or failed", () => {
    expect(dateRangeField(["sent"])).toBe("sentAt");
    expect(dateRangeField(["failed", "sent"])).toBe("sentAt");
  });

  it("uses scheduledAt for pending or mixed statuses", () => {
    expect(dateRangeField(["scheduled"])).toBe("scheduledAt");
    expect(dateRangeField(["scheduled", "sent"])).toBe("scheduledAt");
    expect(dateRangeField(["rate_limited"])).toBe("scheduledAt");
  });
});
