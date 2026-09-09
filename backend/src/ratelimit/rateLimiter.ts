import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  overflowKey,
  OVERFLOW_KEY_TTL_SECONDS,
  paceSenderKey,
  RATE_LIMIT_NOTIFY_TTL_SECONDS,
  rateLimitNotifyKey,
  rlGlobalKey,
  rlSenderKey,
} from "../config/constants";
import { env } from "../config/env";
import { redis } from "../lib/redis";
import { hourEpoch } from "./windows";

export type DenyReason = "GLOBAL_HOURLY_LIMIT" | "SENDER_HOURLY_LIMIT";

export type ReserveResult =
  | { kind: "ALLOW"; waitMs: number }
  | { kind: "PACE"; reason: "PACING"; waitMs: number }
  | { kind: "DENIED"; reason: DenyReason; retryAfterMs: number };

export interface ReserveSlotInput {
  senderId: string;
  globalLimit: number;
  senderLimit: number;
  minDelayMs: number;
  maxInlineWaitMs: number;
  nowMs?: number;
  windowMs?: number;
}

type ScriptedRedis = typeof redis & {
  reserveSlot: (
    globalKey: string,
    senderKey: string,
    paceKey: string,
    globalLimit: number,
    senderLimit: number,
    minDelayMs: number,
    maxInlineWaitMs: number,
    nowMs: number,
    windowMs: number,
    windowTtlSec: number,
  ) => Promise<unknown>;
  releaseSlot: (globalKey: string, senderKey: string) => Promise<unknown>;
};

let commandsDefined = false;

function defineCommands(): ScriptedRedis {
  if (!commandsDefined) {
    redis.defineCommand("reserveSlot", {
      numberOfKeys: 3,
      lua: readFileSync(join(__dirname, "scripts", "reserveSlot.lua"), "utf8"),
    });
    redis.defineCommand("releaseSlot", {
      numberOfKeys: 2,
      lua: readFileSync(join(__dirname, "scripts", "releaseSlot.lua"), "utf8"),
    });
    commandsDefined = true;
  }
  return redis as ScriptedRedis;
}

function asStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : String(value)));
}

function parseReserve(raw: unknown): ReserveResult {
  const row = asStrings(raw);
  const kind = row[0];
  if (kind === "ALLOW") {
    return { kind: "ALLOW", waitMs: Number(row[1] ?? 0) };
  }
  if (kind === "PACE") {
    return { kind: "PACE", reason: "PACING", waitMs: Number(row[2] ?? 0) };
  }
  if (kind === "DENIED") {
    const reason = row[1] === "GLOBAL_HOURLY_LIMIT" ? "GLOBAL_HOURLY_LIMIT" : "SENDER_HOURLY_LIMIT";
    return { kind: "DENIED", reason, retryAfterMs: Number(row[2] ?? 0) };
  }
  throw new Error(`Unexpected reserveSlot reply: ${JSON.stringify(row)}`);
}

function windowKeys(senderId: string, nowMs: number, windowMs: number) {
  const epoch = hourEpoch(nowMs, windowMs);
  return {
    epoch,
    globalKey: rlGlobalKey(epoch),
    senderKey: rlSenderKey(senderId, epoch),
    paceKey: paceSenderKey(senderId),
  };
}

/**
 * Atomic reservation. Runs on the shared command client — never on a Worker
 * blocking connection.
 */
export async function reserveSlot(input: ReserveSlotInput): Promise<ReserveResult> {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const keys = windowKeys(input.senderId, nowMs, windowMs);
  const ttlSec = Math.max(60, Math.ceil((windowMs * 2) / 1000));
  const client = defineCommands();
  const raw = await client.reserveSlot(
    keys.globalKey,
    keys.senderKey,
    keys.paceKey,
    input.globalLimit,
    input.senderLimit,
    input.minDelayMs,
    input.maxInlineWaitMs,
    nowMs,
    windowMs,
    ttlSec,
  );
  return parseReserve(raw);
}

export async function releaseSlot(
  senderId: string,
  nowMs: number = Date.now(),
  windowMs: number = env.RATE_LIMIT_WINDOW_MS,
): Promise<void> {
  const keys = windowKeys(senderId, nowMs, windowMs);
  const client = defineCommands();
  await client.releaseSlot(keys.globalKey, keys.senderKey);
}

export async function nextOverflowRank(senderId: string, nextHourEpoch: number): Promise<number> {
  const key = overflowKey(senderId, nextHourEpoch);
  const rank = await redis.incr(key);
  if (rank === 1) {
    await redis.expire(key, OVERFLOW_KEY_TTL_SECONDS);
  }
  return rank;
}

/** Returns true when this caller should send the once-per-sender-per-hour notify. */
export async function tryClaimRateLimitNotify(senderId: string, hourEpochMs: number): Promise<boolean> {
  const result = await redis.set(
    rateLimitNotifyKey(senderId, hourEpochMs),
    "1",
    "EX",
    RATE_LIMIT_NOTIFY_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}
