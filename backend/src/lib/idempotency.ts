import { createHash } from "node:crypto";
import { IDEMPOTENCY_TTL_SECONDS, idempotencyRedisKey } from "../config/constants";
import { redis } from "../lib/redis";

export function hashIdempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function readIdempotentResponse<T>(rawKey: string): Promise<T | null> {
  const stored = await redis.get(idempotencyRedisKey(hashIdempotencyKey(rawKey)));
  if (!stored) return null;
  return JSON.parse(stored) as T;
}

export async function writeIdempotentResponse(rawKey: string, body: unknown): Promise<void> {
  await redis.set(
    idempotencyRedisKey(hashIdempotencyKey(rawKey)),
    JSON.stringify(body),
    "EX",
    IDEMPOTENCY_TTL_SECONDS,
  );
}
