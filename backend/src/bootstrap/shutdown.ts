import { childLogger } from "../lib/logger";

/**
 * Graceful shutdown coordination.
 *
 * This is not ceremony. It is what makes the restart requirement work: on
 * SIGTERM the worker must finish the sends already in flight and stop claiming
 * new ones, so no email is killed mid-SMTP and left in `claimed` with an
 * unknown outcome (DESIGN.md §21). A hard kill is recoverable, but noisier and
 * strictly worse.
 *
 * Handlers run in registration order, each with its own timeout, and the
 * process force-exits if the whole sequence overruns.
 */

const log = childLogger("shutdown");

export interface ShutdownTask {
  name: string;
  /** Run in registration order. Register "stop accepting work" tasks first. */
  handler: () => Promise<void> | void;
  timeoutMs?: number;
}

const tasks: ShutdownTask[] = [];
let shuttingDown = false;

const DEFAULT_TASK_TIMEOUT_MS = 15_000;
const FORCE_EXIT_AFTER_MS = 25_000;

export function onShutdown(task: ShutdownTask): void {
  tasks.push(task);
}

async function runTask(task: ShutdownTask): Promise<void> {
  const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const startedAt = Date.now();

  try {
    await Promise.race([
      Promise.resolve(task.handler()),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`shutdown task "${task.name}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ).unref(),
      ),
    ]);
    log.info({ task: task.name, durationMs: Date.now() - startedAt }, "shutdown task complete");
  } catch (err) {
    // One failing task must not prevent the rest from running: leaving a
    // database pool open because Redis hung is a worse outcome.
    log.error({ err, task: task.name }, "shutdown task failed");
  }
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    log.warn({ signal }, "shutdown already in progress; ignoring repeat signal");
    return;
  }
  shuttingDown = true;
  log.info({ signal, tasks: tasks.length }, "graceful shutdown started");

  // Backstop: if a task hangs past its own timeout despite the race above, the
  // process still exits rather than lingering forever in a stopped state.
  const forceExit = setTimeout(() => {
    log.fatal({ signal }, `shutdown exceeded ${FORCE_EXIT_AFTER_MS}ms; forcing exit`);
    process.exit(1);
  }, FORCE_EXIT_AFTER_MS);
  forceExit.unref();

  for (const task of tasks) {
    await runTask(task);
  }

  clearTimeout(forceExit);
  log.info({ signal }, "graceful shutdown complete");
  process.exit(exitCode);
}

/**
 * Installs signal and fatal-error handlers.
 *
 * An unhandled rejection or uncaught exception leaves the process in an
 * undefined state, so it shuts down rather than continuing to serve traffic
 * with corrupt internals. A supervisor (Docker, systemd) restarts it, and
 * because scheduling state lives in Redis and Postgres, nothing is lost.
 */
export function installShutdownHandlers(): void {
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));

  process.on("unhandledRejection", (reason) => {
    log.fatal({ err: reason }, "unhandled promise rejection; shutting down");
    void shutdown("unhandledRejection", 1);
  });

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception; shutting down");
    void shutdown("uncaughtException", 1);
  });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
