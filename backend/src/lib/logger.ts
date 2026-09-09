import pino from "pino";
import { env } from "../config/env";

/**
 * Structured logging. Pretty in development, newline-delimited JSON everywhere
 * else so it can be shipped to a log aggregator without reformatting.
 *
 * The redaction list is not decorative: SMTP passwords, Slack webhook URLs,
 * OAuth codes and session cookies all pass through this process, and a leaked
 * webhook URL is a working credential for anyone who reads the logs.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "reachinbox-scheduler" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.smtpPass",
      "*.smtpPassEncrypted",
      "*.webhookUrl",
      "*.webhookUrlEncrypted",
      "*.accessToken",
      "*.refreshToken",
      "*.clientSecret",
      "*.code",
      "password",
      "webhookUrl",
      "ENCRYPTION_KEY",
      "SESSION_JWT_SECRET",
      "DATABASE_URL",
      "REDIS_URL",
    ],
    censor: "[redacted]",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(env.isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,service",
            singleLine: false,
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;

/** Child logger tagged with a subsystem name, e.g. `worker:email-send`. */
export function childLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ component, ...bindings });
}
