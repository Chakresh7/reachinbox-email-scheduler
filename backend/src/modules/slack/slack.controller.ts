import type { Request, Response } from "express";
import { AppError, ErrorCode, badRequest, invalidState } from "../../lib/errors";
import { env, requireFeatureConfig } from "../../config/env";
import { randomToken } from "../../lib/crypto";
import { requireUser } from "../../middleware/requireAuth";
import {
  SLACK_STATE_COOKIE,
  clearOAuthCookies,
  requireMatchingState,
  setOAuthCookie,
  signSlackOAuthState,
  verifySlackOAuthState,
} from "../auth/session.service";
import { loadActiveWebhook, postIncomingWebhook, testBlockKit } from "./notify.service";
import {
  disconnectSlack,
  exchangeSlackCode,
  getSlackStatus,
  slackAuthorizeUrl,
  upsertSlackIntegration,
} from "./slack.service";

export async function install(req: Request, res: Response): Promise<void> {
  requireFeatureConfig("slack");
  const user = requireUser(req);
  const nonce = randomToken();
  const state = signSlackOAuthState(user.id, nonce);
  setOAuthCookie(res, SLACK_STATE_COOKIE, state);
  res.redirect(302, slackAuthorizeUrl(req, state));
}

export async function callback(req: Request, res: Response): Promise<void> {
  const slackError = typeof req.query.error === "string" ? req.query.error : undefined;
  if (slackError) {
    res.redirect(302, `${env.frontendOrigin}/dashboard?slack=error`);
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (!code) throw badRequest("Missing Slack authorization code");

  const cookieState =
    typeof req.cookies?.[SLACK_STATE_COOKIE] === "string" ? req.cookies[SLACK_STATE_COOKIE] : undefined;
  requireMatchingState(cookieState, state);

  const claims = verifySlackOAuthState(state ?? "");
  if (!claims) throw badRequest("Invalid Slack OAuth state");

  const result = await exchangeSlackCode(req, code);
  await upsertSlackIntegration(claims.userId, result);
  clearOAuthCookies(res);
  res.redirect(302, `${env.frontendOrigin}/dashboard?slack=connected`);
}

export async function status(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  res.json({ data: await getSlackStatus(user.id) });
}

export async function disconnect(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  await disconnectSlack(user.id);
  res.status(204).end();
}

export async function test(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const webhook = await loadActiveWebhook(user.id);
  if (!webhook) {
    throw new AppError(400, ErrorCode.INVALID_STATE_TRANSITION, "Slack is not connected");
  }

  const result = await postIncomingWebhook(webhook.webhookUrl, testBlockKit());
  if (!result.ok) {
    const slackHint = result.body.trim().slice(0, 80);
    throw invalidState(
      slackHint
        ? `Slack webhook returned HTTP ${result.status} (${slackHint})`
        : `Slack webhook returned HTTP ${result.status}`,
    );
  }
  res.json({ data: { ok: true } });
}
