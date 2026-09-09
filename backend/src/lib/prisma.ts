import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { childLogger } from "./logger";

/**
 * Prisma client singleton.
 *
 * Prisma 7 removed the Rust query engine, so a driver adapter is mandatory and
 * the connection string is passed here rather than in schema.prisma. Two URLs
 * exist and this is the *pooled* one:
 *
 *   DATABASE_URL -> pooled endpoint (PgBouncer on Neon), used here at runtime.
 *   DIRECT_URL   -> unpooled endpoint, used by the CLI for migrations only.
 *
 * Pool sizing follows DESIGN.md §9: `WORKER_CONCURRENCY + 4` per process, so
 * scaling workers horizontally stays well under the database's connection cap
 * instead of exhausting it at replica three.
 */

const log = childLogger("prisma");

const poolMax = env.WORKER_CONCURRENCY + 4;

const adapter = new PrismaPg(
  {
    connectionString: env.DATABASE_URL,
    max: poolMax,
    // `pg` defaults to no connection timeout at all, which turns an unreachable
    // database into a request that hangs forever instead of failing.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  },
  {
    onPoolError: (error) => log.error({ err: error }, "postgres pool error"),
    onConnectionError: (error) => log.error({ err: error }, "postgres connection error"),
  },
);

export const prisma = new PrismaClient({
  adapter,
  log: env.isDev
    ? [
        { emit: "event", level: "query" },
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ]
    : [
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ],
});

if (env.isDev) {
  prisma.$on("query", (event) => {
    log.debug({ durationMs: event.duration, query: event.query }, "prisma query");
  });
}
prisma.$on("warn", (event) => log.warn({ target: event.target }, event.message));
prisma.$on("error", (event) => log.error({ target: event.target }, event.message));

/** Round-trip ping used by /readyz. Returns latency in milliseconds. */
export async function pingPostgres(): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await prisma.$queryRaw`SELECT 1`;
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  log.info("postgres pool closed");
}

export const postgresPoolMax = poolMax;
