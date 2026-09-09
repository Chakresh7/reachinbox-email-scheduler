import { createHash } from "node:crypto";
import type { Request } from "express";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { env, requireFeatureConfig } from "../../config/env";
import { randomToken } from "../../lib/crypto";
import { badRequest } from "../../lib/errors";
import { childLogger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { oauthCallbackUrl } from "../../lib/publicUrl";
import { provisionEtherealSenders } from "./provisionSenders";

const log = childLogger("auth:google");

export interface GoogleProfile {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface GoogleAuthStart {
  url: string;
  state: string;
  verifier: string;
}

function googleClient(req: Request): OAuth2Client {
  requireFeatureConfig("google");
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    oauthCallbackUrl(req, "/api/auth/google/callback"),
  );
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function startGoogleAuth(req: Request): GoogleAuthStart {
  const state = randomToken();
  const verifier = randomToken();
  const client = googleClient(req);
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account",
    scope: ["openid", "email", "profile"],
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: CodeChallengeMethod.S256,
  });
  return { url, state, verifier };
}

export async function exchangeGoogleCode(
  req: Request,
  code: string,
  verifier: string,
): Promise<GoogleProfile> {
  const client = googleClient(req);
  const { tokens } = await client.getToken({ code, codeVerifier: verifier });
  if (!tokens.id_token) {
    throw badRequest("Google did not return an ID token");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw badRequest("Google ID token is missing sub or email");
  }
  if (payload.email_verified !== true) {
    throw badRequest("Google email is not verified");
  }

  const email = payload.email.toLowerCase();
  const name = payload.name?.trim() || email.split("@")[0] || email;
  return {
    googleSub: payload.sub,
    email,
    name,
    avatarUrl: payload.picture ?? null,
  };
}

export async function upsertGoogleUser(profile: GoogleProfile): Promise<{
  id: string;
  tokenVersion: number;
  created: boolean;
}> {
  const existing = await prisma.user.findUnique({
    where: { googleSub: profile.googleSub },
    select: { id: true },
  });

  const isAdmin = env.adminEmails.includes(profile.email);
  const user = await prisma.user.upsert({
    where: { googleSub: profile.googleSub },
    create: {
      googleSub: profile.googleSub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      isAdmin,
    },
    update: {
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      isAdmin,
    },
    select: { id: true, tokenVersion: true },
  });

  const created = !existing;
  if (created) {
    try {
      await provisionEtherealSenders(user.id);
    } catch (err) {
      log.warn({ err, userId: user.id }, "first-login Ethereal provisioning failed; session still set");
    }
  }

  return { id: user.id, tokenVersion: user.tokenVersion, created };
}
