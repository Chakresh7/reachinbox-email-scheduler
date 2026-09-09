import { decrypt } from "../../lib/crypto";
import { prisma } from "../../lib/prisma";

export interface SlackWebhookPayload {
  text: string;
  blocks?: unknown[];
}

export type SlackWebhookResult =
  | { ok: true }
  | { ok: false; status: number; body: string; retryAfterMs?: number; dead?: boolean };

export function rateLimitBlockKit(input: {
  senderEmail: string;
  limitValue: number;
  jobsDeferred: number;
  nextHourIso: string;
}): SlackWebhookPayload {
  const nextLabel = input.nextHourIso.replace("T", " ").slice(0, 16) + " UTC";
  const text =
    `Hourly limit reached — sender ${input.senderEmail} hit ${input.limitValue}/hour. ` +
    `${input.jobsDeferred} email(s) deferred to ${nextLabel}.`;
  return {
    text,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Hourly send limit reached", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `Sender *${input.senderEmail}* hit the *${input.limitValue}/hour* cap.\n` +
            `*${input.jobsDeferred}* email(s) deferred to *${nextLabel}*.`,
        },
      },
    ],
  };
}

export function testBlockKit(): SlackWebhookPayload {
  return {
    text: "ReachInbox test — Slack incoming webhook is connected.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*ReachInbox test*\nYour incoming webhook is connected. Rate-limit alerts will land in this channel.",
        },
      },
    ],
  };
}

export async function postIncomingWebhook(
  webhookUrl: string,
  payload: SlackWebhookPayload,
): Promise<SlackWebhookResult> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (response.status === 200) return { ok: true };

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const dead =
    response.status === 404 ||
    response.status === 410 ||
    /\bno_service\b/i.test(body);

  return {
    ok: false,
    status: response.status,
    body,
    retryAfterMs: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined,
    dead,
  };
}

export async function loadActiveWebhook(userId: string): Promise<{
  webhookUrl: string;
  integrationId: string;
} | null> {
  const row = await prisma.slackIntegration.findUnique({ where: { userId } });
  if (!row || row.revokedAt) return null;
  return {
    webhookUrl: decrypt(row.webhookUrlEncrypted),
    integrationId: row.id,
  };
}

export async function markIntegrationRevoked(userId: string, lastError: string): Promise<void> {
  await prisma.slackIntegration.updateMany({
    where: { userId },
    data: { revokedAt: new Date(), lastError },
  });
}

export async function markRateLimitNotified(senderId: string, hourWindow: Date): Promise<void> {
  await prisma.rateLimitEvent.updateMany({
    where: { senderId, hourWindow },
    data: { notifiedAt: new Date(), notifyError: null },
  });
}

export async function markRateLimitNotifyError(
  senderId: string,
  hourWindow: Date,
  notifyError: string,
): Promise<void> {
  await prisma.rateLimitEvent.updateMany({
    where: { senderId, hourWindow },
    data: { notifyError },
  });
}
