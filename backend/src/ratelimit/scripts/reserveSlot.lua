-- KEYS[1] rl:global:{hourEpoch}
-- KEYS[2] rl:sender:{senderId}:{hourEpoch}
-- KEYS[3] pace:sender:{senderId}
-- ARGV[1] globalLimit
-- ARGV[2] senderLimit
-- ARGV[3] minDelayMs
-- ARGV[4] maxInlineWaitMs
-- ARGV[5] nowMs
-- ARGV[6] windowMs
-- ARGV[7] windowTtlSec
--
-- Returns a Redis array:
--   { "DENIED", "GLOBAL_HOURLY_LIMIT"|"SENDER_HOURLY_LIMIT", msToNextWindow }
--   { "PACE", "PACING", waitMs }
--   { "ALLOW", waitMs }
-- Counters are only mutated on ALLOW.

local globalKey = KEYS[1]
local senderKey = KEYS[2]
local paceKey = KEYS[3]

local globalLimit = tonumber(ARGV[1])
local senderLimit = tonumber(ARGV[2])
local minDelayMs = tonumber(ARGV[3])
local maxInlineWaitMs = tonumber(ARGV[4])
local nowMs = tonumber(ARGV[5])
local windowMs = tonumber(ARGV[6])
local windowTtlSec = tonumber(ARGV[7])

local function msToNextWindow()
  local nextStart = (math.floor(nowMs / windowMs) + 1) * windowMs
  return nextStart - nowMs
end

local g = tonumber(redis.call("GET", globalKey) or "0")
if g >= globalLimit then
  return { "DENIED", "GLOBAL_HOURLY_LIMIT", tostring(msToNextWindow()) }
end

local s = tonumber(redis.call("GET", senderKey) or "0")
if s >= senderLimit then
  return { "DENIED", "SENDER_HOURLY_LIMIT", tostring(msToNextWindow()) }
end

local nextAllowed = tonumber(redis.call("GET", paceKey) or "0")
local waitMs = math.max(0, nextAllowed - nowMs)
if waitMs > maxInlineWaitMs then
  return { "PACE", "PACING", tostring(waitMs) }
end

local gAfter = redis.call("INCR", globalKey)
if gAfter == 1 then
  redis.call("EXPIRE", globalKey, windowTtlSec)
end

local sAfter = redis.call("INCR", senderKey)
if sAfter == 1 then
  redis.call("EXPIRE", senderKey, windowTtlSec)
end

local paceUntil = math.max(nowMs, nextAllowed) + minDelayMs
local paceTtlMs = minDelayMs * 4 + 60000
redis.call("SET", paceKey, tostring(paceUntil), "PX", paceTtlMs)

return { "ALLOW", tostring(waitMs) }
