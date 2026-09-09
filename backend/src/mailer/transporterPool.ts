import nodemailer from "nodemailer";
import { env } from "../config/env";
import { decrypt } from "../lib/crypto";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";

const log = childLogger("mailer");

type AnyTransporter = ReturnType<typeof nodemailer.createTransport>;

const pool = new Map<string, AnyTransporter>();

function isEtherealHost(host: string): boolean {
  return host.toLowerCase().includes("ethereal.email");
}

export function evictTransporter(senderId: string): void {
  const existing = pool.get(senderId);
  if (!existing) return;
  pool.delete(senderId);
  try {
    existing.close();
  } catch (err) {
    log.warn({ err, senderId }, "failed to close evicted transporter");
  }
}

export async function getTransporter(senderId: string): Promise<AnyTransporter> {
  const existing = pool.get(senderId);
  if (existing) return existing;

  const sender = await prisma.sender.findUnique({ where: { id: senderId } });
  if (!sender) {
    throw new Error(`Sender ${senderId} not found`);
  }

  const password = decrypt(sender.smtpPassEncrypted);
  const ethereal = isEtherealHost(sender.smtpHost);
  // Ethereal is a shared test SMTP. Several parallel CONNs from a Render
  // free instance time out; one pooled socket per sender is enough because
  // the Lua limiter already serialises sends to 2s.
  const transporter = nodemailer.createTransport({
    pool: true,
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: { user: sender.smtpUser, pass: password },
    maxConnections: ethereal ? 1 : Math.min(env.WORKER_CONCURRENCY, 5),
    maxMessages: ethereal ? 250 : 100,
    connectionTimeout: 60_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });

  pool.set(senderId, transporter);
  return transporter;
}

export async function closeAllTransporters(): Promise<void> {
  const closing = [...pool.entries()].map(async ([id, transporter]) => {
    try {
      transporter.close();
    } catch (err) {
      log.warn({ err, senderId: id }, "failed to close transporter");
    }
  });
  pool.clear();
  await Promise.all(closing);
  log.info("smtp transporters closed");
}
