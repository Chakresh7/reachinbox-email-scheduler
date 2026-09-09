import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (migrations, generate, studio).
 *
 * The connection string is deliberately split in two, and this file owns the
 * DIRECT one:
 *
 *   DIRECT_URL   -> unpooled endpoint, used here by the CLI. Migrations cannot
 *                   run through PgBouncer: prepared statements are not
 *                   compatible with transaction pooling and you get
 *                   `prepared statement "s0" already exists`.
 *   DATABASE_URL -> pooled endpoint, used at runtime by the driver adapter in
 *                   src/lib/prisma.ts. It never appears in this file.
 *
 * `process.env` is read directly rather than via prisma/config's `env()`
 * helper, because `env()` throws on a missing variable and every CLI command
 * loads this file. That would make `prisma generate` fail inside a Docker build,
 * where no database credentials exist or are needed.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
