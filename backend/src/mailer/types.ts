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

function smtpField(err: unknown, key: string): string {
  if (typeof err !== "object" || err === null || !(key in err)) return "";
  return String((err as Record<string, unknown>)[key] ?? "");
}

/** TCP/TLS handshake failures — the pooled transporter is usually dead after these. */
export function isSmtpConnectionError(err: unknown): boolean {
  const code = smtpField(err, "code").toUpperCase();
  const command = smtpField(err, "command").toUpperCase();
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "ECONNECTION" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    command === "CONN" ||
    /connection timeout|greeting never received/i.test(message)
  );
}

/**
 * Dead pooled socket after a timeout often surfaces as EENVELOPE
 * ("Can't send mail - all recipients were rejected") instead of CONN.
 */
export function isSmtpStaleSessionError(err: unknown): boolean {
  const code = smtpField(err, "code").toUpperCase();
  const message = err instanceof Error ? err.message : String(err);
  return (
    isSmtpConnectionError(err) ||
    code === "EENVELOPE" ||
    /all recipients were rejected/i.test(message)
  );
}

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
  const responseCode =
    typeof err === "object" && err !== null && "responseCode" in err
      ? Number((err as { responseCode?: unknown }).responseCode)
      : NaN;

  if (isSmtpStaleSessionError(err)) {
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
