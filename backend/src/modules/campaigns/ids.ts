import { createHash, randomUUID } from "node:crypto";

export function recipientDedupeKey(campaignId: string, email: string): string {
  return createHash("sha256").update(`${campaignId}:${email.toLowerCase()}`).digest("hex");
}

export function newId(): string {
  return randomUUID();
}
