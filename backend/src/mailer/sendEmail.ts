import nodemailer from "nodemailer";
import { childLogger } from "../lib/logger";
import { evictTransporter, getTransporter } from "./transporterPool";
import {
  classifySmtpError,
  getTestMailSender,
  isSmtpConnectionError,
  type OutboundEmail,
  type SendResult,
} from "./types";

const log = childLogger("mailer:send");

async function dispatch(senderId: string, message: OutboundEmail) {
  const transporter = await getTransporter(senderId);
  return transporter.sendMail({
    from: message.fromName ? `"${message.fromName}" <${message.from}>` : message.from,
    to: message.toName ? `"${message.toName}" <${message.to}>` : message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

export async function sendEmail(senderId: string, message: OutboundEmail): Promise<SendResult> {
  const stub = getTestMailSender();
  if (stub) return stub.send(message);

  let info: Awaited<ReturnType<typeof dispatch>>;
  try {
    info = await dispatch(senderId, message);
  } catch (err) {
    if (!isSmtpConnectionError(err)) throw err;
    log.warn({ err, senderId }, "smtp connection failed; rebuilding transporter");
    evictTransporter(senderId);
    info = await dispatch(senderId, message);
  }

  const previewUrl = nodemailer.getTestMessageUrl(info);
  return {
    messageId: info.messageId,
    previewUrl: typeof previewUrl === "string" ? previewUrl : null,
    response: typeof info.response === "string" ? info.response : "",
  };
}

export { classifySmtpError };
export type { OutboundEmail, SendResult } from "./types";
