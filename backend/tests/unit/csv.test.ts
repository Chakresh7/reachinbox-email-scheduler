import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRecipientCsv } from "../../src/modules/campaigns/csv.service";

describe("parseRecipientCsv", () => {
  it("parses a headerless single column", () => {
    const result = parseRecipientCsv("a@x.com\nb@x.com\n");
    expect(result.recipients.map((r) => r.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(result.invalidRows).toEqual([]);
    expect(result.duplicateCount).toBe(0);
  });

  it("parses a headered file with name and email columns in any order", () => {
    const csv = "Name,Email\nAda Lovelace,ada@example.com\nGrace Hopper,grace@example.com\n";
    const result = parseRecipientCsv(csv);
    expect(result.recipients).toEqual([
      { email: "ada@example.com", name: "Ada Lovelace" },
      { email: "grace@example.com", name: "Grace Hopper" },
    ]);
  });

  it("accepts CRLF and quoted fields", () => {
    const csv = "email,name\r\n\"a@x.com\",\"Doe, Jane\"\r\n";
    const result = parseRecipientCsv(csv);
    expect(result.recipients).toEqual([{ email: "a@x.com", name: "Doe, Jane" }]);
  });

  it("lowercases and dedupes, keeping the first name", () => {
    const csv = "A@X.com\na@x.com\nA@x.COM\n";
    const result = parseRecipientCsv(csv);
    expect(result.recipients).toEqual([{ email: "a@x.com", name: null }]);
    expect(result.duplicateCount).toBe(2);
  });

  it("reports invalid addresses without dropping valid ones", () => {
    const csv = "good@x.com\nnot-an-email\nbad@\nok@y.com\n";
    const result = parseRecipientCsv(csv);
    expect(result.recipients.map((r) => r.email)).toEqual(["good@x.com", "ok@y.com"]);
    expect(result.invalidRows.map((r) => r.reason)).toEqual(["invalid_email", "invalid_email"]);
  });

  it("returns empty lists for an empty file", () => {
    const result = parseRecipientCsv("");
    expect(result.recipients).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it("caps at maxRecipients and records overflow rows", () => {
    const csv = "a@x.com\nb@x.com\nc@x.com\n";
    const result = parseRecipientCsv(csv, { maxRecipients: 2 });
    expect(result.recipients).toHaveLength(2);
    expect(result.invalidRows.some((r) => r.reason.startsWith("exceeds_max"))).toBe(true);
  });

  it("handles 10k unique rows", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `user${i}@example.com`);
    const result = parseRecipientCsv(lines.join("\n"));
    expect(result.recipients).toHaveLength(10_000);
    expect(result.invalidRows).toEqual([]);
    const key = createHash("sha256")
      .update(result.recipients.map((r) => r.email).join(","))
      .digest("hex");
    expect(key).toHaveLength(64);
  });
});
