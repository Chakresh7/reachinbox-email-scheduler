import { describe, expect, it } from "vitest";
import { notifyRateLimitJobId } from "../../src/config/constants";
import { AppError } from "../../src/lib/errors";
import {
  requireMatchingState,
  sessionMatchesTokenVersion,
  signSessionToken,
  signSlackOAuthState,
  verifySessionToken,
  verifySlackOAuthState,
} from "../../src/modules/auth/session.service";

describe("session JWT", () => {
  it("round-trips user id and token version", () => {
    const token = signSessionToken("11111111-1111-4111-8111-111111111111", 3);
    const claims = verifySessionToken(token);
    expect(claims).toEqual({
      sub: "11111111-1111-4111-8111-111111111111",
      v: 3,
    });
  });

  it("rejects a tampered token", () => {
    const token = signSessionToken("11111111-1111-4111-8111-111111111111", 1);
    expect(verifySessionToken(`${token}x`)).toBeNull();
    expect(verifySessionToken("not-a-jwt")).toBeNull();
  });

  it("rejects a session whose tokenVersion no longer matches", () => {
    const token = signSessionToken("11111111-1111-4111-8111-111111111111", 1);
    const claims = verifySessionToken(token);
    expect(claims).not.toBeNull();
    expect(sessionMatchesTokenVersion(claims!, 1)).toBe(true);
    expect(sessionMatchesTokenVersion(claims!, 2)).toBe(false);
  });
});

describe("OAuth state", () => {
  it("accepts identical cookie and query values", () => {
    expect(() => requireMatchingState("abc", "abc")).not.toThrow();
  });

  it("rejects a mismatched or missing state", () => {
    expect(() => requireMatchingState("abc", "abd")).toThrow(AppError);
    expect(() => requireMatchingState("abc", undefined)).toThrow(AppError);
    expect(() => requireMatchingState(undefined, "abc")).toThrow(AppError);
    try {
      requireMatchingState("one", "two");
    } catch (err) {
        expect(err).toMatchObject({ code: "OAUTH_STATE_MISMATCH", statusCode: 400 });
    }
  });

  it("round-trips Slack install state and rejects a swapped user", () => {
    const token = signSlackOAuthState("user-a", "nonce-1");
    const claims = verifySlackOAuthState(token);
    expect(claims).toEqual({ typ: "slack_oauth", userId: "user-a", nonce: "nonce-1" });
    expect(verifySlackOAuthState(`${token}x`)).toBeNull();
  });
});

describe("notifyRateLimitJobId", () => {
  it("has exactly three colon-separated segments", () => {
    const id = notifyRateLimitJobId("2c1a0c6e-6c4a-4f3a-9b1e-7f0d2a1b3c4d", 1_704_067_200_000);
    const parts = id.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("notif");
    expect(parts[1]).toBe("2c1a0c6e-6c4a-4f3a-9b1e-7f0d2a1b3c4d");
    expect(parts[2]).toBe("1704067200000");
  });
});
