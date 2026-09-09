import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { forbidden, unauthenticated } from "../lib/errors";
import { prisma } from "../lib/prisma";
import { SESSION_COOKIE, sessionMatchesTokenVersion, verifySessionToken } from "../modules/auth/session.service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const userSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  isAdmin: true,
  tokenVersion: true,
} as const;

function toIdentity(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}): Express.AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    isAdmin: user.isAdmin,
  };
}

async function loadDevFallbackUser(): Promise<Express.AuthenticatedUser | null> {
  if (env.isProd || !UUID_RE.test(env.DEV_USER_ID)) return null;
  const user = await prisma.user.findUnique({
    where: { id: env.DEV_USER_ID },
    select: userSelect,
  });
  return user ? toIdentity(user) : null;
}

/**
 * Resolves req.user from the `sid` JWT, then (non-prod only) DEV_USER_ID.
 *
 * Production never impersonates: a missing or stale cookie is a 401.
 */
export async function requireIdentity(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user) {
      next();
      return;
    }

    const sid = typeof req.cookies?.[SESSION_COOKIE] === "string" ? req.cookies[SESSION_COOKIE] : undefined;
    const claims = sid ? verifySessionToken(sid) : null;
    if (claims) {
      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: userSelect,
      });
      if (user && sessionMatchesTokenVersion(claims, user.tokenVersion)) {
        req.user = toIdentity(user);
        next();
        return;
      }
    }

    const fallback = await loadDevFallbackUser();
    if (fallback) {
      req.user = fallback;
      next();
      return;
    }

    if (!env.isProd && UUID_RE.test(env.DEV_USER_ID) && !fallback) {
      next(
        unauthenticated(
          "DEV_USER_ID does not match a user. Run `npm run seed:senders` in backend/.",
        ),
      );
      return;
    }

    next(unauthenticated());
  } catch (err) {
    next(err);
  }
}

export function requireUser(req: Request): Express.AuthenticatedUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}

export function isAdminUser(user: Express.AuthenticatedUser): boolean {
  if (user.isAdmin) return true;
  return env.adminEmails.includes(user.email.toLowerCase());
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await requireIdentity(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    try {
      const user = requireUser(req);
      if (!isAdminUser(user)) {
        next(forbidden("Admin access required"));
        return;
      }
      next();
    } catch (inner) {
      next(inner);
    }
  });
}
