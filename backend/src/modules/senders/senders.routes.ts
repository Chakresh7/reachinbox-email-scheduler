import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { requireIdentity, requireUser } from "../../middleware/requireAuth";
import { env } from "../../config/env";

export const sendersRouter = Router();
sendersRouter.use(requireIdentity);

sendersRouter.get("/", (req, res, next) => {
  void listSenders(req, res).catch(next);
});

async function listSenders(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const senders = await prisma.sender.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      displayName: true,
      isActive: true,
      maxEmailsPerHour: true,
      lastVerifiedAt: true,
      smtpHost: true,
      smtpPort: true,
    },
  });
  res.json({
    data: senders.map((s) => ({
      ...s,
      lastVerifiedAt: s.lastVerifiedAt?.toISOString() ?? null,
      effectiveHourlyLimit: s.maxEmailsPerHour ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    })),
  });
}
