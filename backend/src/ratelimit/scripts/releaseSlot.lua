-- KEYS[1] rl:global:{hourEpoch}
-- KEYS[2] rl:sender:{senderId}:{hourEpoch}
-- Compensating DECR when a reserved slot did not result in a send.
-- Floors at 0 so a double-release cannot wrap the counter.

local function decrFloor(key)
  local current = tonumber(redis.call("GET", key) or "0")
  if current > 0 then
    redis.call("DECR", key)
  end
end

decrFloor(KEYS[1])
decrFloor(KEYS[2])
return 1
