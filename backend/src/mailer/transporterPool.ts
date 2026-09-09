import nodemailer from "nodemailer";
import { env } from "../config/env";
import { decrypt } from "../lib/crypto";
import { childLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";

const log = childLogger("mailer");

type AnyTransporter = ReturnType<typeof nodemailer.createTransport>;

const pool = new Map<string, AnyTransporter>();

export async function getTransporter(senderId: string): Promise<AnyTransporter> {
  const existing = pool.get(senderId);
  if (existing) return existing;

  const sender = await prisma.sender.findUnique({ where: { id: senderId } });
  if (!sender) {
    throw new Error(`Sender ${senderId} not found`);
  }

  const password = decrypt(sender.smtpPassEncrypted);
  const transporter = nodemailer.createTransport({
    pool: true,
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: { user: sender.smtpUser, pass: password },
    maxConnections: Math.min(env.WORKER_CONCURRENCY, 5),
    maxMessages: 100,
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
