export interface OutboundEmail {
  from: string;
  fromName: string;
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
  response: string;
}

export type SmtpErrorKind = "permanent" | "transient";

export interface MailSender {
  send(message: OutboundEmail): Promise<SendResult>;
}

/** Test double injection — production code never calls this. */
let testSender: MailSender | null = null;

export function setMailSenderForTests(sender: MailSender | null): void {
  testSender = sender;
}

export function getTestMailSender(): MailSender | null {
  return testSender;
}

/**
 * Permanent vs transient SMTP failures.
 *
 * Permanent: do not retry (invalid recipient, 5xx from the provider).
 * Transient: BullMQ backoff (timeouts, connection resets, 4xx greylisting).
 */
export function classifySmtpError(err: unknown): SmtpErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const responseCode =
    typeof err === "object" && err !== null && "responseCode" in err
      ? Number((err as { responseCode?: unknown }).responseCode)
      : NaN;

  if (
    code === "ECONNECTION" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "EENVELOPE"
  ) {
    return "transient";
  }
  if (Number.isFinite(responseCode) && responseCode >= 400 && responseCode < 500) {
    return "transient";
  }
  if (Number.isFinite(responseCode) && responseCode >= 500) {
    return "permanent";
  }
  if (/invalid mailbox|user unknown|recipient rejected|550|553/i.test(message)) {
    return "permanent";
  }
  return "transient";
}
