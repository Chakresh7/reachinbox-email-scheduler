import { env, requireFeatureConfig } from "../../config/env";
import { encrypt } from "../../lib/crypto";
import { badRequest, dependencyUnavailable } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

export interface SlackOAuthResult {
  slackTeamId: string;
  slackTeamName: string;
  channelId: string | null;
  channelName: string | null;
  webhookUrl: string;
  scope: string;
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: {
    url?: string;
    channel?: string;
    channel_id?: string;
  };
  scope?: string;
}

export function slackAuthorizeUrl(state: string): string {
  requireFeatureConfig("slack");
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID ?? "",
    scope: env.SLACK_SCOPES,
    redirect_uri: env.SLACK_REDIRECT_URI ?? "",
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(code: string): Promise<SlackOAuthResult> {
  requireFeatureConfig("slack");
  let response: Response;
  try {
    response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID ?? "",
        client_secret: env.SLACK_CLIENT_SECRET ?? "",
        code,
        redirect_uri: env.SLACK_REDIRECT_URI ?? "",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw dependencyUnavailable("Could not reach Slack OAuth", err);
  }

  if (!response.ok) {
    throw dependencyUnavailable(`Slack OAuth HTTP ${response.status}`);
  }

  const json = (await response.json()) as SlackOAuthResponse;
  if (!json.ok) {
    throw badRequest(`Slack OAuth failed: ${json.error ?? "unknown_error"}`);
  }

  const webhookUrl = json.incoming_webhook?.url;
  const teamId = json.team?.id;
  const teamName = json.team?.name;
  if (!webhookUrl || !teamId || !teamName) {
    throw badRequest("Slack OAuth did not return an incoming webhook");
  }

  return {
    slackTeamId: teamId,
    slackTeamName: teamName,
    channelId: json.incoming_webhook?.channel_id ?? null,
    channelName: json.incoming_webhook?.channel ?? null,
    webhookUrl,
    scope: json.scope ?? env.SLACK_SCOPES,
  };
}

export async function upsertSlackIntegration(userId: string, result: SlackOAuthResult): Promise<void> {
  await prisma.slackIntegration.upsert({
    where: { userId },
    create: {
      userId,
      slackTeamId: result.slackTeamId,
      slackTeamName: result.slackTeamName,
      channelId: result.channelId,
      channelName: result.channelName,
      webhookUrlEncrypted: encrypt(result.webhookUrl),
      scope: result.scope,
      revokedAt: null,
      lastError: null,
    },
    update: {
      slackTeamId: result.slackTeamId,
      slackTeamName: result.slackTeamName,
      channelId: result.channelId,
      channelName: result.channelName,
      webhookUrlEncrypted: encrypt(result.webhookUrl),
      scope: result.scope,
      revokedAt: null,
      lastError: null,
      connectedAt: new Date(),
    },
  });
}

export async function getSlackStatus(userId: string): Promise<{
  connected: boolean;
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
}> {
  const row = await prisma.slackIntegration.findUnique({ where: { userId } });
  if (!row || row.revokedAt) {
    return { connected: false, teamName: null, channelName: null, connectedAt: null };
  }
  return {
    connected: true,
    teamName: row.slackTeamName,
    channelName: row.channelName,
    connectedAt: row.connectedAt.toISOString(),
  };
}

export async function disconnectSlack(userId: string): Promise<void> {
  await prisma.slackIntegration.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
