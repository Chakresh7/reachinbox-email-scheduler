import type { Request, Response } from "express";
import { env } from "../../config/env";
import { badRequest } from "../../lib/errors";
import { requireUser } from "../../middleware/requireAuth";
import { exchangeGoogleCode, startGoogleAuth, upsertGoogleUser } from "./google.service";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_VERIFIER_COOKIE,
  clearOAuthCookies,
  clearSessionCookie,
  requireMatchingState,
  setOAuthCookie,
  setSessionCookie,
} from "./session.service";

export function features(_req: Request, res: Response): void {
  res.json({
    data: {
      google: env.features.google,
      slack: env.features.slack,
    },
  });
}

export function startGoogle(req: Request, res: Response): void {
  const started = startGoogleAuth(req);
  setOAuthCookie(res, GOOGLE_STATE_COOKIE, started.state);
  setOAuthCookie(res, GOOGLE_VERIFIER_COOKIE, started.verifier);
  res.redirect(302, started.url);
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const googleError = typeof req.query.error === "string" ? req.query.error : undefined;
  if (googleError) {
    res.redirect(302, `${env.frontendOrigin}/login?error=${encodeURIComponent(googleError)}`);
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code) throw badRequest("Missing Google authorization code");

  const cookieState =
    typeof req.cookies?.[GOOGLE_STATE_COOKIE] === "string" ? req.cookies[GOOGLE_STATE_COOKIE] : undefined;
  const verifier =
    typeof req.cookies?.[GOOGLE_VERIFIER_COOKIE] === "string"
      ? req.cookies[GOOGLE_VERIFIER_COOKIE]
      : undefined;
  requireMatchingState(cookieState, state);
  if (!verifier) throw badRequest("Missing PKCE verifier cookie");

  const profile = await exchangeGoogleCode(req, code, verifier);
  const user = await upsertGoogleUser(profile);

  setSessionCookie(res, user.id, user.tokenVersion);
  clearOAuthCookies(res);
  res.redirect(302, `${env.frontendOrigin}/dashboard`);
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  res.json({
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
    },
  });
}

export function logout(_req: Request, res: Response): void {
  clearSessionCookie(res);
  clearOAuthCookies(res);
  res.status(204).end();
}
