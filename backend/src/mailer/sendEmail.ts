import nodemailer from "nodemailer";
import { getTransporter } from "./transporterPool";
import { classifySmtpError, getTestMailSender, type OutboundEmail, type SendResult } from "./types";

export async function sendEmail(senderId: string, message: OutboundEmail): Promise<SendResult> {
  const stub = getTestMailSender();
  if (stub) return stub.send(message);

  const transporter = await getTransporter(senderId);
  const info = await transporter.sendMail({
    from: message.fromName ? `"${message.fromName}" <${message.from}>` : message.from,
    to: message.toName ? `"${message.toName}" <${message.to}>` : message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  return {
    messageId: info.messageId,
    previewUrl: typeof previewUrl === "string" ? previewUrl : null,
    response: typeof info.response === "string" ? info.response : "",
  };
}

export { classifySmtpError };
export type { OutboundEmail, SendResult } from "./types";
