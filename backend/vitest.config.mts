import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/health.test.ts"],
    globals: false,
    /**
     * Config is validated at import time and aborts the process on a bad value,
     * so tests need a complete, valid environment before any module loads.
     * These are set here rather than in a .env.test file so the suite is
     * hermetic: it cannot accidentally run against a real database because a
     * developer's local file happened to be present.
     *
     * `test.env` is applied before module resolution, and dotenv does not
     * override already-set variables, so a real backend/.env cannot leak in.
     */
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/reachinbox_test",
      DIRECT_URL: "postgresql://test:test@127.0.0.1:5432/reachinbox_test",
      // Deliberately an unused port: unit and contract tests must not depend on
      // a live Redis. Phase 2's rate-limiter tests will use a real one.
      REDIS_URL: "redis://127.0.0.1:6399",
      SESSION_JWT_SECRET: "test-session-secret-that-is-long-enough-for-validation",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      SEARCH_ENABLED: "false",
      FRONTEND_URL: "http://localhost:5173",
    },
    // Windows + real network clients: fail rather than hang forever.
    testTimeout: 15_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/generated/**",
        "src/server.ts",
        "src/worker.ts",
        "src/scripts/**",
        "src/types/**",
      ],
    },
  },
});
