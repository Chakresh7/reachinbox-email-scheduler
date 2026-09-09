import type { CookieOptions, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { oauthStateMismatch } from "../../lib/errors";
import { safeEqual } from "../../lib/crypto";

export const SESSION_COOKIE = "sid";
export const GOOGLE_STATE_COOKIE = "oauth_google_state";
export const GOOGLE_VERIFIER_COOKIE = "oauth_google_pkce";
export const SLACK_STATE_COOKIE = "oauth_slack_state";

const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export interface SessionClaims {
  sub: string;
  v: number;
}

export interface SlackOAuthState {
  typ: "slack_oauth";
  userId: string;
  nonce: string;
}

function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.isProd,
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

function oauthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.isProd,
    maxAge: OAUTH_COOKIE_MAX_AGE_MS,
  };
}

function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.isProd,
  };
}

export function signSessionToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, v: tokenVersion } satisfies SessionClaims, env.SESSION_JWT_SECRET, {
    expiresIn: `${env.SESSION_TTL_DAYS}d`,
  });
}

export function verifySessionToken(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, env.SESSION_JWT_SECRET);
    if (typeof payload !== "object" || payload === null) return null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const v = "v" in payload && typeof payload.v === "number" ? payload.v : null;
    if (!sub || v === null) return null;
    return { sub, v };
  } catch {
    return null;
  }
}

/** JWT `v` must match `users.token_version` or the session is dead. */
export function sessionMatchesTokenVersion(claims: SessionClaims, tokenVersion: number): boolean {
  return claims.v === tokenVersion;
}

export function setSessionCookie(res: Response, userId: string, tokenVersion: number): void {
  res.cookie(SESSION_COOKIE, signSessionToken(userId, tokenVersion), sessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, clearCookieOptions());
}

export function setOAuthCookie(res: Response, name: string, value: string): void {
  res.cookie(name, value, oauthCookieOptions());
}

export function clearOAuthCookies(res: Response): void {
  const opts = clearCookieOptions();
  res.clearCookie(GOOGLE_STATE_COOKIE, opts);
  res.clearCookie(GOOGLE_VERIFIER_COOKIE, opts);
  res.clearCookie(SLACK_STATE_COOKIE, opts);
}

export function requireMatchingState(
  cookieValue: string | undefined,
  queryValue: string | undefined,
): void {
  if (!cookieValue || !queryValue || !safeEqual(cookieValue, queryValue)) {
    throw oauthStateMismatch();
  }
}

export function signSlackOAuthState(userId: string, nonce: string): string {
  return jwt.sign(
    { typ: "slack_oauth", userId, nonce } satisfies SlackOAuthState,
    env.SESSION_JWT_SECRET,
    { expiresIn: "10m" },
  );
}

export function verifySlackOAuthState(token: string): SlackOAuthState | null {
  try {
    const payload = jwt.verify(token, env.SESSION_JWT_SECRET);
    if (typeof payload !== "object" || payload === null) return null;
    const typ = "typ" in payload ? payload.typ : null;
    const userId = "userId" in payload && typeof payload.userId === "string" ? payload.userId : null;
    const nonce = "nonce" in payload && typeof payload.nonce === "string" ? payload.nonce : null;
    if (typ !== "slack_oauth" || !userId || !nonce) return null;
    return { typ: "slack_oauth", userId, nonce };
  } catch {
    return null;
  }
}
