/**
 * Live Ethereal demo: `npx tsx tests/live/sendFive.ts`
 *
 * Requires DEV_USER_ID, seeded senders, API + worker running? This script
 * inserts through the HTTP API if API_PUBLIC_URL is up, otherwise tells you to
 * start the stack.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const api = process.env.API_PUBLIC_URL ?? "http://localhost:4000";

async function main(): Promise<void> {
  const csvPath = join(__dirname, "five.csv");
  const csv = readFileSync(csvPath);

  const form = new FormData();
  form.set("subject", "Phase 1 live send");
  form.set("body", "This is a real Ethereal message from the ReachInbox scheduler.");
  form.set("startAt", new Date().toISOString());
  form.set("delayBetweenMs", "2000");
  form.set("hourlyLimit", "200");
  form.set("file", new Blob([csv], { type: "text/csv" }), "five.csv");

  const response = await fetch(`${api}/api/campaigns`, {
    method: "POST",
    headers: { "Idempotency-Key": `live-five-${Date.now()}` },
    body: form,
  });
  const body = await response.json();
  if (!response.ok) {
    console.error(response.status, body);
    process.exit(1);
  }
  console.log("scheduled", body);
  console.log("Watch GET /api/emails/scheduled then /api/emails/sent, and the dashboard.");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
