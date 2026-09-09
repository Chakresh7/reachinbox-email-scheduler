import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { forbidden, unauthenticated } from "../lib/errors";
import { safeEqual } from "../lib/crypto";
import { isAdminUser, requireIdentity, requireUser } from "../middleware/requireAuth";
import { campaignExpandQueue } from "./campaignExpand.queue";
import { emailSendQueue } from "./emailSend.queue";

function unauthorizedBasic(res: Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="ReachInbox queues"');
  res.status(401).json({
    error: { code: "UNAUTHENTICATED", message: "Authentication required" },
  });
}

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/**
 * HTTP Basic when configured; otherwise the same identity as the rest of the API
 * plus an admin check. The board is never public.
 */
export async function protectQueueBoard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (env.features.bullBoardBasicAuth) {
    const creds = parseBasic(req.header("authorization"));
    const user = env.BULL_BOARD_USER ?? "";
    const pass = env.BULL_BOARD_PASSWORD ?? "";
    if (!creds || !safeEqual(creds.user, user) || !safeEqual(creds.pass, pass)) {
      unauthorizedBasic(res);
      return;
    }
    next();
    return;
  }

  await requireIdentity(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    try {
      const identity = requireUser(req);
      if (!isAdminUser(identity)) {
        next(forbidden("Admin access required"));
        return;
      }
      next();
    } catch (inner) {
      next(inner instanceof Error ? inner : unauthenticated());
    }
  });
}

export function createQueueBoardRouter() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [new BullMQAdapter(emailSendQueue), new BullMQAdapter(campaignExpandQueue)],
    serverAdapter,
  });
  return serverAdapter.getRouter();
}
