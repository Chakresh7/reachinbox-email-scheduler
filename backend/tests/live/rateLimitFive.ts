/**
 * Demo: 5 recipients on one sender. Lua defers extras when that sender's
 * maxEmailsPerHour is 2. Campaign hourlyLimit stays high so pre-spread does
 * not hide the runtime limiter.
 *
 * `npx tsx tests/live/rateLimitFive.ts` with API + worker up.
 * Does not send 250 live Ethereal messages.
 */
import "dotenv/config";

const api = process.env.API_PUBLIC_URL ?? "http://localhost:4000";

interface SenderRow {
  id: string;
  email: string;
  maxEmailsPerHour: number | null;
}

async function main(): Promise<void> {
  const sendersRes = await fetch(`${api}/api/senders`);
  const sendersBody = (await sendersRes.json()) as { data: SenderRow[] };
  const sender = sendersBody.data[0];
  if (!sender) {
    console.error("No senders. Run npm run seed:senders");
    process.exit(1);
  }

  console.log(`Using sender ${sender.email} (${sender.id}) maxEmailsPerHour=${sender.maxEmailsPerHour}`);
  if ((sender.maxEmailsPerHour ?? 200) > 2) {
    console.warn(
      "Set this sender's maxEmailsPerHour to 2 in Postgres to see 2 sent + 3 rate_limited.",
    );
  }

  const csv = "one@example.com\ntwo@example.com\nthree@example.com\nfour@example.com\nfive@example.com\n";
  const form = new FormData();
  form.set("subject", "Phase 2 rate-limit demo");
  form.set("body", "Only two should send this hour if the sender cap is 2.");
  form.set("startAt", new Date().toISOString());
  form.set("delayBetweenMs", "0");
  form.set("hourlyLimit", "200");
  form.set("senderIds", JSON.stringify([sender.id]));
  form.set("file", new Blob([csv], { type: "text/csv" }), "five.csv");

  const response = await fetch(`${api}/api/campaigns`, {
    method: "POST",
    headers: { "Idempotency-Key": `rl-five-${Date.now()}` },
    body: form,
  });
  const body = await response.json();
  console.log(response.status, body);
  console.log("Watch GET /api/emails/scheduled for rate_limited rows and /admin/queues.");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
