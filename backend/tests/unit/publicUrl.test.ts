import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { oauthCallbackUrl, requestPublicOrigin } from "../../src/lib/publicUrl";

function fakeReq(headers: Record<string, string>, protocol = "http"): Request {
  return {
    protocol,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
}

describe("requestPublicOrigin", () => {
  it("uses the Host header in development", () => {
    const req = fakeReq({ host: "localhost:4000" });
    expect(requestPublicOrigin(req)).toBe("http://localhost:4000");
  });

  it("prefers forwarded proto and host behind a proxy", () => {
    const req = fakeReq(
      {
        host: "10.0.0.8:10000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "reachinbox-7vtq.onrender.com",
      },
      "http",
    );
    expect(requestPublicOrigin(req)).toBe("https://reachinbox-7vtq.onrender.com");
  });

  it("builds the Google callback from the public origin", () => {
    const req = fakeReq({
      host: "reachinbox-7vtq.onrender.com",
      "x-forwarded-proto": "https",
    });
    expect(oauthCallbackUrl(req, "/api/auth/google/callback")).toBe(
      "https://reachinbox-7vtq.onrender.com/api/auth/google/callback",
    );
  });
});
