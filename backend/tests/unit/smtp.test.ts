import { describe, expect, it } from "vitest";
import { classifySmtpError } from "../../src/mailer/types";

describe("classifySmtpError", () => {
  it("treats 5xx and unknown-recipient as permanent", () => {
    expect(classifySmtpError({ responseCode: 550, message: "user unknown" })).toBe("permanent");
    expect(classifySmtpError(new Error("550 5.1.1 Recipient rejected"))).toBe("permanent");
  });

  it("treats timeouts and connection resets as transient", () => {
    expect(classifySmtpError({ code: "ETIMEDOUT" })).toBe("transient");
    expect(classifySmtpError({ code: "ECONNRESET" })).toBe("transient");
    expect(classifySmtpError({ responseCode: 421 })).toBe("transient");
    expect(classifySmtpError({ command: "CONN", message: "Connection timeout" })).toBe("transient");
  });
});
