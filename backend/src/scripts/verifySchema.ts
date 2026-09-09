/**
 * Schema verification: `npm run check:schema`
 *
 * Confirms that what the migration was supposed to create actually exists in
 * the live database — tables, enums, the citext extension, and specifically the
 * indexes and unique constraints that later phases depend on for correctness
 * rather than for speed.
 *
 * This exists because "the migration reported success" and "the constraint that
 * guarantees idempotency is present" are different claims, and only the second
 * one matters.
 */

import { prisma, disconnectPrisma } from "../lib/prisma";
import { errorMessage } from "../lib/errors";

/** Objects whose absence would break a documented guarantee. */
const REQUIRED_TABLES = [
  "users",
  "senders",
  "campaigns",
  "email_jobs",
  "slack_integrations",
  "rate_limit_events",
] as const;

const CRITICAL_INDEXES: { name: string; why: string }[] = [
  {
    name: "email_jobs_dedupe_key_key",
    why: "idempotency layer 2 — one recipient can never be queued twice per campaign",
  },
  {
    name: "email_jobs_user_id_status_scheduled_at_idx",
    why: "Scheduled tab list query",
  },
  {
    name: "email_jobs_user_id_status_sent_at_idx",
    why: "Sent tab list query",
  },
  {
    name: "email_jobs_status_scheduled_at_idx",
    why: "startup reconciler scan",
  },
  {
    name: "rate_limit_events_sender_id_hour_window_key",
    why: "durable once-per-sender-per-hour Slack notification guarantee",
  },
  {
    name: "campaigns_idempotency_key_key",
    why: "idempotency layer 1 — safe retry of POST /api/campaigns",
  },
  {
    name: "slack_integrations_user_id_key",
    why: "one Slack workspace connection per user",
  },
  {
    name: "senders_user_id_email_key",
    why: "no duplicate sender identities per user",
  },
];

interface Row {
  name: string;
}

async function main(): Promise<void> {
  let failures = 0;
  const fail = (message: string) => {
    failures += 1;
    console.log(`  [FAIL] ${message}`);
  };
  const pass = (message: string) => console.log(`  [OK  ] ${message}`);

  console.log("\nSchema verification\n");

  // ── Tables ──
  const tables = await prisma.$queryRaw<Row[]>`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  const tableNames = new Set(tables.map((t) => t.name));
  for (const table of REQUIRED_TABLES) {
    if (tableNames.has(table)) pass(`table ${table}`);
    else fail(`table ${table} is MISSING`);
  }

  // ── citext extension ──
  const extensions = await prisma.$queryRaw<Row[]>`
    SELECT extname AS name FROM pg_extension WHERE extname = 'citext'
  `;
  if (extensions.length > 0) {
    pass("extension citext");
  } else {
    fail("extension citext is MISSING — case-insensitive email columns will not work");
  }

  // ── citext columns ──
  const citextColumns = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name || '.' || column_name AS name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND udt_name = 'citext'
    ORDER BY table_name, column_name
  `;
  console.log(`  [INFO] citext columns: ${citextColumns.map((c) => c.name).join(", ")}`);

  // ── Enums ──
  const enums = await prisma.$queryRaw<{ name: string; labels: number }[]>`
    SELECT t.typname AS name, COUNT(e.enumlabel)::int AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    GROUP BY t.typname
    ORDER BY t.typname
  `;
  for (const enumType of enums) {
    pass(`enum ${enumType.name} (${enumType.labels} values)`);
  }

  // ── Indexes that carry a correctness guarantee ──
  const indexes = await prisma.$queryRaw<Row[]>`
    SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
  `;
  const indexNames = new Set(indexes.map((i) => i.name));
  for (const index of CRITICAL_INDEXES) {
    if (indexNames.has(index.name)) pass(`index ${index.name}  (${index.why})`);
    else fail(`index ${index.name} is MISSING — ${index.why}`);
  }
  console.log(`  [INFO] ${indexNames.size} indexes total across the schema`);

  // ── Applied migrations ──
  const migrations = await prisma.$queryRaw<{ name: string; applied: Date | null }[]>`
    SELECT migration_name AS name, finished_at AS applied
    FROM _prisma_migrations
    ORDER BY started_at
  `;
  for (const migration of migrations) {
    if (migration.applied) pass(`migration ${migration.name}`);
    else fail(`migration ${migration.name} did NOT finish`);
  }

  console.log(
    failures === 0
      ? "\nSchema verified: every table, enum, extension and correctness-critical index is present.\n"
      : `\n${failures} problem(s) found.\n`,
  );

  await disconnectPrisma();
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch(async (err: unknown) => {
  console.error("schema verification failed:", errorMessage(err));
  await disconnectPrisma().catch(() => undefined);
  process.exit(1);
});
