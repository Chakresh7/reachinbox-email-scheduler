import "dotenv/config";
import { z } from "zod";

/**
 * Single source of truth for configuration.
 *
 * Nothing else in the codebase reads `process.env`. Parsing happens once, at
 * import time, and a bad value aborts the process with every failure listed at
 * once — a config typo should be a ten-second discovery, not a forty-minute one
 * after the first email silently fails to send.
 *
 * Variables are grouped by whether the process can run without them:
 *
 *   Required  — the API/worker cannot function at all (datastores, secrets).
 *   Feature   — gate a specific capability (Google, Slack, Elasticsearch).
 *               Optional here, verified by `requireFeatureConfig` at the point
 *               of use, and reported in the startup feature summary. This keeps
 *               a developer without Slack credentials from being unable to boot,
 *               while still failing loudly if they hit the Slack routes.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

/** Positive integer from a string env var. */
const intFromEnv = (label: string, opts: { min?: number; max?: number } = {}) => {
  let schema = z.coerce.number({ error: `${label} must be a number` }).int(`${label} must be an integer`);
  if (opts.min !== undefined) schema = schema.min(opts.min, `${label} must be >= ${opts.min}`);
  if (opts.max !== undefined) schema = schema.max(opts.max, `${label} must be <= ${opts.max}`);
  return schema;
};

const boolFromEnv = (label: string) =>
  z
    .enum(["true", "false", "1", "0"], { error: `${label} must be one of: true, false, 1, 0` })
    .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  // ── Core ──────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intFromEnv("PORT", { min: 1, max: 65535 }).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Comma-separated list of browser origins allowed to send credentialed requests. */
  FRONTEND_URL: nonEmpty("FRONTEND_URL").default("http://localhost:5173"),
  API_PUBLIC_URL: nonEmpty("API_PUBLIC_URL").default("http://localhost:4000"),

  // ── Datastores (required) ─────────────────────────────────────────────────
  /** Pooled connection, used at runtime by the Prisma driver adapter. */
  DATABASE_URL: nonEmpty("DATABASE_URL").refine(
    (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
    "DATABASE_URL must be a postgres:// or postgresql:// connection string",
  ),
  /** Unpooled connection, used by the Prisma CLI for migrations. */
  DIRECT_URL: z.string().trim().optional(),
  REDIS_URL: nonEmpty("REDIS_URL").refine(
    (v) => v.startsWith("redis://") || v.startsWith("rediss://"),
    "REDIS_URL must be a redis:// or rediss:// connection string",
  ),
  /** Namespaces every BullMQ key, so one Redis can host multiple environments. */
  REDIS_PREFIX: nonEmpty("REDIS_PREFIX").default("reachinbox"),
  /**
   * Redis must not evict keys: dropping an entry from a BullMQ delayed set
   * silently destroys a scheduled email. Asserted at boot in lib/redis.ts.
   * Only disable on a managed tier that forbids CONFIG GET.
   */
  REDIS_ASSERT_NOEVICTION: boolFromEnv("REDIS_ASSERT_NOEVICTION").default(true),

  // ── Security (required) ───────────────────────────────────────────────────
  SESSION_JWT_SECRET: nonEmpty("SESSION_JWT_SECRET").min(
    32,
    "SESSION_JWT_SECRET must be at least 32 characters",
  ),
  /** 32 bytes as 64 hex chars — the AES-256-GCM key for at-rest secrets. */
  ENCRYPTION_KEY: nonEmpty("ENCRYPTION_KEY").regex(
    /^[0-9a-fA-F]{64}$/,
    "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate with: openssl rand -hex 32",
  ),
  SESSION_TTL_DAYS: intFromEnv("SESSION_TTL_DAYS", { min: 1, max: 365 }).default(7),
  DEV_USER_ID: z.string().trim().default(""),

  // ── Elasticsearch (feature) ───────────────────────────────────────────────
  SEARCH_ENABLED: boolFromEnv("SEARCH_ENABLED").default(true),
  ELASTICSEARCH_URL: z.string().trim().optional(),
  ELASTICSEARCH_API_KEY: z.string().trim().optional(),
  ELASTICSEARCH_USERNAME: z.string().trim().optional(),
  ELASTICSEARCH_PASSWORD: z.string().trim().optional(),
  ELASTICSEARCH_INDEX: nonEmpty("ELASTICSEARCH_INDEX").default("emails"),

  // ── Google OAuth (feature) ────────────────────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
  GOOGLE_REDIRECT_URI: z.string().trim().optional(),

  // ── Slack OAuth (feature) ─────────────────────────────────────────────────
  SLACK_CLIENT_ID: z.string().trim().optional(),
  SLACK_CLIENT_SECRET: z.string().trim().optional(),
  SLACK_REDIRECT_URI: z.string().trim().optional(),
  SLACK_SCOPES: nonEmpty("SLACK_SCOPES").default("incoming-webhook"),

  // ── SMTP / Ethereal ───────────────────────────────────────────────────────
  ETHEREAL_HOST: nonEmpty("ETHEREAL_HOST").default("smtp.ethereal.email"),
  ETHEREAL_PORT: intFromEnv("ETHEREAL_PORT", { min: 1, max: 65535 }).default(587),
  /** Optional pre-created accounts, so a reviewer can skip the network call. */
  ETHEREAL_ACCOUNTS: z.string().trim().default("[]"),
  SEED_SENDER_COUNT: intFromEnv("SEED_SENDER_COUNT", { min: 1, max: 20 }).default(3),

  // ── Scheduler, throughput, rate limits ────────────────────────────────────
  WORKER_CONCURRENCY: intFromEnv("WORKER_CONCURRENCY", { min: 1, max: 100 }).default(5),
  /** Documented floor between individual sends. Campaigns cannot go below it. */
  MIN_DELAY_BETWEEN_EMAILS_MS: intFromEnv("MIN_DELAY_BETWEEN_EMAILS_MS", { min: 0 }).default(2000),
  MAX_EMAILS_PER_HOUR: intFromEnv("MAX_EMAILS_PER_HOUR", { min: 1 }).default(1000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: intFromEnv("MAX_EMAILS_PER_HOUR_PER_SENDER", { min: 1 }).default(200),
  /** Above this pacing wait, a job re-delays itself instead of holding a slot. */
  MAX_INLINE_WAIT_MS: intFromEnv("MAX_INLINE_WAIT_MS", { min: 0 }).default(5000),
  RATE_LIMIT_WINDOW_MS: intFromEnv("RATE_LIMIT_WINDOW_MS", { min: 1000 }).default(3_600_000),
  EMAIL_JOB_ATTEMPTS: intFromEnv("EMAIL_JOB_ATTEMPTS", { min: 1, max: 20 }).default(3),
  EMAIL_JOB_BACKOFF_MS: intFromEnv("EMAIL_JOB_BACKOFF_MS", { min: 100 }).default(5000),
  EXPAND_BATCH_SIZE: intFromEnv("EXPAND_BATCH_SIZE", { min: 1, max: 5000 }).default(500),
  STALE_CLAIM_TIMEOUT_MS: intFromEnv("STALE_CLAIM_TIMEOUT_MS", { min: 1000 }).default(300_000),
  RECONCILE_ON_BOOT: boolFromEnv("RECONCILE_ON_BOOT").default(true),
  /** Largest CSV accepted by the compose endpoint, in bytes. */
  MAX_CSV_BYTES: intFromEnv("MAX_CSV_BYTES", { min: 1024 }).default(5 * 1024 * 1024),
  MAX_RECIPIENTS_PER_CAMPAIGN: intFromEnv("MAX_RECIPIENTS_PER_CAMPAIGN", { min: 1 }).default(50_000),

  // ── Admin ─────────────────────────────────────────────────────────────────
  ADMIN_EMAILS: z.string().trim().default(""),
  BULL_BOARD_USER: z.string().trim().optional(),
  BULL_BOARD_PASSWORD: z.string().trim().optional(),
});

type RawEnv = z.infer<typeof envSchema>;

function loadEnv(): RawEnv {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Deliberately console.error rather than the logger: the logger itself
    // depends on this module, and a config failure must be readable even if
    // nothing else has initialised.
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `  - ${key}: ${issue.message}`;
    });
    console.error(
      [
        "",
        "✖ Invalid environment configuration. Refusing to start.",
        "",
        ...lines,
        "",
        "  Copy .env.example to backend/.env and fill in the missing values.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  return parsed.data;
}

const raw = loadEnv();

/** Origins permitted to make credentialed cross-origin requests. */
const allowedOrigins = raw.FRONTEND_URL.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const adminEmails = raw.ADMIN_EMAILS.split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** Which optional capabilities have complete configuration. */
const features = {
  google: Boolean(raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET && raw.GOOGLE_REDIRECT_URI),
  slack: Boolean(raw.SLACK_CLIENT_ID && raw.SLACK_CLIENT_SECRET && raw.SLACK_REDIRECT_URI),
  search: Boolean(raw.SEARCH_ENABLED && raw.ELASTICSEARCH_URL),
  bullBoardBasicAuth: Boolean(raw.BULL_BOARD_USER && raw.BULL_BOARD_PASSWORD),
} as const;

export type FeatureName = keyof typeof features;

export const env = Object.freeze({
  ...raw,
  isDev: raw.NODE_ENV === "development",
  isTest: raw.NODE_ENV === "test",
  isProd: raw.NODE_ENV === "production",
  allowedOrigins,
  adminEmails,
  features,
});

export type Env = typeof env;

/**
 * Guard for a feature-gated code path. Throws a readable error rather than
 * letting an undefined client id reach Google as the string "undefined".
 */
export function requireFeatureConfig(feature: FeatureName): void {
  if (!env.features[feature]) {
    const requirements: Record<FeatureName, string> = {
      google: "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI",
      slack: "SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI",
      search: "SEARCH_ENABLED=true and ELASTICSEARCH_URL",
      bullBoardBasicAuth: "BULL_BOARD_USER, BULL_BOARD_PASSWORD",
    };
    throw new Error(
      `Feature "${feature}" is not configured. Set: ${requirements[feature]} in backend/.env`,
    );
  }
}
