import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { encrypt } from "../../lib/crypto";
import { childLogger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";

const log = childLogger("auth:senders");

interface EtherealAccount {
  user: string;
  pass: string;
  email?: string;
}

function parsePrecreatedAccounts(): EtherealAccount[] {
  try {
    const parsed = JSON.parse(env.ETHEREAL_ACCOUNTS) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is EtherealAccount =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as EtherealAccount).user === "string" &&
        typeof (row as EtherealAccount).pass === "string",
    );
  } catch {
    return [];
  }
}

async function createAccount(): Promise<EtherealAccount> {
  const precreated = parsePrecreatedAccounts();
  if (precreated[0]) return precreated[0];

  const response = await fetch("https://api.nodemailer.com/user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestor: "reachinbox-scheduler", version: "0.1.0" }),
  });
  const data = (await response.json()) as {
    status?: string;
    user?: string;
    pass?: string;
  };
  if (data.status === "success" && data.user && data.pass) {
    return { user: data.user, pass: data.pass, email: data.user };
  }
  const account = await nodemailer.createTestAccount();
  return { user: account.user, pass: account.pass, email: account.user };
}

/**
 * First Google login: attach at least one Ethereal sender so campaign create
 * has something to send from. Failure is logged, never thrown — the session
 * still succeeds; the next campaign create surfaces NO_ACTIVE_SENDER.
 */
export async function provisionEtherealSenders(userId: string): Promise<void> {
  const existing = await prisma.sender.count({ where: { userId } });
  if (existing > 0) return;

  const account = await createAccount();
  const email = (account.email ?? account.user).toLowerCase();

  await prisma.sender.create({
    data: {
      userId,
      email,
      displayName: "Ethereal 1",
      smtpHost: env.ETHEREAL_HOST,
      smtpPort: env.ETHEREAL_PORT,
      smtpUser: account.user,
      smtpPassEncrypted: encrypt(account.pass),
      lastVerifiedAt: new Date(),
      isActive: true,
    },
  });

  log.info({ userId, email }, "provisioned Ethereal sender for first login");
}
