import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".env") });

/**
 * Live integration suite. Loads backend/.env (Neon + Redis Cloud) and is opt-in:
 *   npm run test:integration
 *
 * SMTP is stubbed. Unit tests stay on the hermetic vitest.config.mts so they
 * cannot accidentally hit production data stores.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SEARCH_ENABLED: "false",
    },
  },
});
