import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { env } from "../src/config/env";
import { encrypt } from "../src/lib/crypto";
import { disconnectPrisma, prisma } from "../src/lib/prisma";
import { disconnectRedis } from "../src/lib/redis";

const DEV_GOOGLE_SUB = "dev:local";
const DEV_EMAIL = "dev@localhost";

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
    throw new Error("ETHEREAL_ACCOUNTS is not valid JSON");
  }
}

async function createAccount(index: number): Promise<EtherealAccount> {
  const precreated = parsePrecreatedAccounts();
  if (precreated[index]) return precreated[index];

  // Nodemailer's createTestAccount caches the first result in-process
  // (ETHEREAL_CACHE defaults to on), so N senders must hit the same API it uses.
  const response = await fetch("https://api.nodemailer.com/user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestor: "reachinbox-scheduler", version: "0.1.0" }),
  });
  const data = (await response.json()) as {
    status?: string;
    error?: string;
    user?: string;
    pass?: string;
  };
  if (data.status !== "success" || !data.user || !data.pass) {
    const account = await nodemailer.createTestAccount();
    return { user: account.user, pass: account.pass, email: account.user };
  }
  return { user: data.user, pass: data.pass, email: data.user };
}

async function verifyAccount(account: EtherealAccount): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: env.ETHEREAL_HOST,
    port: env.ETHEREAL_PORT,
    secure: false,
    auth: { user: account.user, pass: account.pass },
  });
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { googleSub: DEV_GOOGLE_SUB },
    update: { name: "Local Developer", email: DEV_EMAIL, isAdmin: true },
    create: {
      googleSub: DEV_GOOGLE_SUB,
      email: DEV_EMAIL,
      name: "Local Developer",
      isAdmin: true,
    },
  });

  const existingSenders = await prisma.sender.findMany({
    where: { userId: user.id },
    select: { email: true },
  });
  const usedEmails = new Set(existingSenders.map((s) => s.email.toLowerCase()));
  console.log(`dev user id: ${user.id}`);
  console.log(`existing senders: ${usedEmails.size}; target ${env.SEED_SENDER_COUNT}`);

  let attempts = 0;
  const maxAttempts = env.SEED_SENDER_COUNT * 6;
  while (usedEmails.size < env.SEED_SENDER_COUNT && attempts < maxAttempts) {
    attempts += 1;
    const accountIndex = usedEmails.size;
    let account: EtherealAccount;
    try {
      account = await createAccount(accountIndex);
    } catch (err) {
      const fallback = parsePrecreatedAccounts();
      if (fallback.length === 0) throw err;
      console.warn("createTestAccount failed; using ETHEREAL_ACCOUNTS fallback", err);
      account = fallback[accountIndex % fallback.length] as EtherealAccount;
    }

    const email = (account.email ?? account.user).toLowerCase();
    if (usedEmails.has(email)) {
      console.warn(`Ethereal returned a duplicate account (${email}); retrying`);
      continue;
    }

    await verifyAccount(account);
    await prisma.sender.upsert({
      where: { userId_email: { userId: user.id, email } },
      update: {
        displayName: `Ethereal ${accountIndex + 1}`,
        smtpHost: env.ETHEREAL_HOST,
        smtpPort: env.ETHEREAL_PORT,
        smtpUser: account.user,
        smtpPassEncrypted: encrypt(account.pass),
        isActive: true,
        lastVerifiedAt: new Date(),
      },
      create: {
        userId: user.id,
        email,
        displayName: `Ethereal ${accountIndex + 1}`,
        smtpHost: env.ETHEREAL_HOST,
        smtpPort: env.ETHEREAL_PORT,
        smtpUser: account.user,
        smtpPassEncrypted: encrypt(account.pass),
        isActive: true,
        lastVerifiedAt: new Date(),
      },
    });
    usedEmails.add(email);
    console.log(`  sender ${usedEmails.size}: ${email}`);
  }

  if (usedEmails.size < env.SEED_SENDER_COUNT) {
    throw new Error(
      `Only created ${usedEmails.size}/${env.SEED_SENDER_COUNT} unique Ethereal senders. ` +
        "Set ETHEREAL_ACCOUNTS in backend/.env with pre-created accounts.",
    );
  }

  const senders = await prisma.sender.findMany({
    where: { userId: user.id, isActive: true },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nDEV_USER_ID=${user.id}`);
  persistDevUserId(user.id);
  console.log(`senders (${senders.length}):`);
  for (const sender of senders) {
    console.log(`  ${sender.id}  ${sender.email}`);
  }

  await disconnectPrisma();
  await disconnectRedis();
}

/** Writes DEV_USER_ID into backend/.env when the key is missing or empty. */
function persistDevUserId(userId: string): void {
  const envPath = path.resolve(__dirname, "../.env");
  if (!existsSync(envPath)) {
    console.log(`backend/.env not found — add DEV_USER_ID=${userId} yourself.`);
    return;
  }

  const original = readFileSync(envPath, "utf8");
  if (new RegExp(`^DEV_USER_ID=${userId}\\s*$`, "m").test(original)) {
    return;
  }

  const emptyOrMissing = !/^DEV_USER_ID=/m.test(original) || /^DEV_USER_ID=\s*$/m.test(original);
  if (!emptyOrMissing) {
    console.log("DEV_USER_ID is already set in backend/.env (left unchanged).");
    return;
  }

  const next = /^DEV_USER_ID=/m.test(original)
    ? original.replace(/^DEV_USER_ID=.*$/m, `DEV_USER_ID=${userId}`)
    : `${original.trimEnd()}\nDEV_USER_ID=${userId}\n`;
  writeFileSync(envPath, next, "utf8");
  console.log("Wrote DEV_USER_ID to backend/.env. Restart the API and worker so they pick it up.");
}

void main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectPrisma().catch(() => undefined);
  await disconnectRedis().catch(() => undefined);
  process.exit(1);
});
