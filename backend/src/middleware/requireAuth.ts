import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { forbidden, unauthenticated } from "../lib/errors";
import { prisma } from "../lib/prisma";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolves req.user.
 *
 * Phase 4 will verify the session JWT. Until then, development and test may
 * impersonate the seeded local user via DEV_USER_ID. Production never does —
 * an unauthenticated request is a 401, not an implicit admin.
 */
export async function requireIdentity(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user) {
      next();
      return;
    }

    const allowDevIdentity = !env.isProd && UUID_RE.test(env.DEV_USER_ID);
    if (!allowDevIdentity) {
      next(unauthenticated());
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: env.DEV_USER_ID },
      select: { id: true, email: true, name: true, avatarUrl: true, isAdmin: true },
    });
    if (!user) {
      next(
        unauthenticated(
          "DEV_USER_ID does not match a user. Run `npm run seed:senders` in backend/.",
        ),
      );
      return;
    }

    req.user = user;
    next();
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
