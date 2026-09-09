/**
 * Load check: schedule 1000 recipients and assert ingest + pre-spread.
 *
 * Does not wait for 1000 Ethereal sends. startAt is ~24h ahead so the worker
 * does not start SMTP during the measurement. Cancel at the end unless
 * SKIP_CANCEL=1.
 *
 * Requires API + worker and DEV_USER_ID (same as tests/live/sendFive.ts).
 *   npm --prefix backend run load:1000
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(__dirname, "../../.env") });

const api = process.env.API_PUBLIC_URL ?? "http://localhost:4000";
const COUNT = 1000;
const DELAY_MS = 2000;
const HOURLY_LIMIT = 200;
const EXPAND_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;

interface CreateCampaignResult {
  campaignId: string;
  totalRecipients: number;
  validCount: number;
  expandedCount?: number;
}

interface CampaignDetail {
  id: string;
  status: string;
  expandedCount: number;
  totalRecipients: number;
  delayBetweenMs: number;
  startAt: string;
}

interface EmailRow {
  scheduledAt: string;
}

function csvOf(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`load-${String(i).padStart(4, "0")}@example.com`);
  }
  return `${lines.join("\n")}\n`;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function asData<T>(body: unknown): T {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new Error(`Unexpected response: ${JSON.stringify(body)}`);
  }
  return (body as { data: T }).data;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const form = new FormData();
  form.set("subject", "Phase 6 load 1000");
  form.set("body", "Ingest/expand/pacing check — not a live Ethereal blast.");
  form.set("startAt", startAt.toISOString());
  form.set("delayBetweenMs", String(DELAY_MS));
  form.set("hourlyLimit", String(HOURLY_LIMIT));
  form.set("file", new Blob([csvOf(COUNT)], { type: "text/csv" }), "load-1000.csv");

  const postStarted = Date.now();
  const createdRes = await fetch(`${api}/api/campaigns`, {
    method: "POST",
    headers: { "Idempotency-Key": `load-1000-${Date.now()}` },
    body: form,
  });
  const apiMs = Date.now() - postStarted;
  const createdBody = await readJson(createdRes);
  if (createdRes.status !== 202) {
    console.error(createdRes.status, createdBody);
    process.exit(1);
  }
  const created = asData<CreateCampaignResult>(createdBody);
  if (created.validCount !== COUNT) {
    console.error(`expected ${COUNT} valid recipients, got ${created.validCount}`);
    process.exit(1);
  }

  const expandStarted = Date.now();
  let campaign: CampaignDetail | null = null;
  while (Date.now() - expandStarted < EXPAND_TIMEOUT_MS) {
    const getRes = await fetch(`${api}/api/campaigns/${created.campaignId}`);
    const getBody = await readJson(getRes);
    if (!getRes.ok) {
      console.error(getRes.status, getBody);
      process.exit(1);
    }
    campaign = asData<CampaignDetail>(getBody);
    if (campaign.expandedCount >= COUNT) break;
    await sleep(250);
  }
  const expandMs = Date.now() - expandStarted;
  if (!campaign || campaign.expandedCount < COUNT) {
    console.error("expand timed out", campaign);
    process.exit(1);
  }

  const rows: EmailRow[] = [];
  let page = 1;
  for (;;) {
    const listUrl = `${api}/api/emails/scheduled?campaignId=${created.campaignId}&page=${page}&limit=${PAGE_SIZE}`;
    const listRes = await fetch(listUrl);
    const listBody = (await readJson(listRes)) as {
      data?: EmailRow[];
      meta?: { totalPages: number };
    };
    if (!listRes.ok) {
      console.error(listRes.status, listBody);
      process.exit(1);
    }
    rows.push(...(listBody.data ?? []));
    const totalPages = listBody.meta?.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }

  const times = rows
    .map((row) => new Date(row.scheduledAt).getTime())
    .sort((a, b) => a - b);
  if (times.length !== COUNT) {
    console.error(`expected ${COUNT} scheduled rows, got ${times.length}`);
    process.exit(1);
  }

  const firstHourEnd = startAt.getTime() + 60 * 60 * 1000;
  const hour1 = times.filter((t) => t < firstHourEnd);
  const hour1Count = hour1.length;

  // Pre-spread parks overflow at the next hour *boundary*, so overall min gap
  // is 0. The 2s delay is the spacing inside the first window.
  let hour1MinGapMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < hour1.length; i += 1) {
    const gap = (hour1[i] ?? 0) - (hour1[i - 1] ?? 0);
    if (gap < hour1MinGapMs) hour1MinGapMs = gap;
  }
  if (hour1.length < 2) hour1MinGapMs = 0;

  const summary = {
    campaignId: created.campaignId,
    apiMs,
    expandMs,
    recipients: COUNT,
    expandedCount: campaign.expandedCount,
    hour1MinGapMs,
    hour1Count,
    hourlyLimit: HOURLY_LIMIT,
    delayMs: DELAY_MS,
    startAt: startAt.toISOString(),
  };

  const failures: string[] = [];
  if (hour1MinGapMs < DELAY_MS) {
    failures.push(`hour1MinGapMs ${hour1MinGapMs} < ${DELAY_MS}`);
  }
  if (hour1Count > HOURLY_LIMIT) {
    failures.push(`hour1Count ${hour1Count} > ${HOURLY_LIMIT}`);
  }

  if (process.env.SKIP_CANCEL !== "1") {
    const cancelRes = await fetch(`${api}/api/campaigns/${created.campaignId}/cancel`, {
      method: "POST",
    });
    if (!cancelRes.ok) {
      console.error("cancel failed", cancelRes.status, await readJson(cancelRes));
      process.exit(1);
    }
    Object.assign(summary, { cancelled: true });
  }

  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) {
    console.error("asserts failed:", failures.join("; "));
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
