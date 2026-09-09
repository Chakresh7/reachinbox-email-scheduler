# Demo recording shot list (≤ 5 minutes)

You record this. Do not commit the video file.

Use **Google login**, not the `DEV_USER_ID` fallback. Keep `backend/.env` off screen.

Hosted login (same app, ClickUp URL): [https://reachinbox-7vtq.onrender.com](https://reachinbox-7vtq.onrender.com). First hit after idle can take about a minute. Worker restart is still easier on `localhost`.

## Prep (before you hit record)

1. `npm run dev` — API `:4000`, worker, frontend `:5173`.
2. Slack already connected to a channel you can show (or connect in the first 30s).
3. Ethereal senders seeded; Infrastructure panel green.
4. A tiny CSV ready (`a@example.com` / `b@example.com`), one line per address.
5. Optional: BullMQ board credentials if you will show `/admin/queues`.

## Timeline

| Time | Shot | What to say / show |
|---|---|---|
| **0:00** | Login | Open `http://localhost:5173`, **Continue with Google**, land on dashboard. Point at header **name, email, avatar**. |
| **0:30** | Slack | **Connect Slack** if needed. **Test Slack** — switch to Slack and show the live Block Kit message. |
| **0:50** | Compose | **Compose New Email**: subject, body, drop CSV, **detected count**, delay **2** seconds, start ~now, **Schedule**. Toast `Scheduled N recipients`. |
| **1:40** | Tables | **Scheduled** tab: new rows. After send, **Sent** + **Preview** (Ethereal). |
| **2:20** | Search | Search by subject, then recipient. Clear the box — full list returns. |
| **2:40** | Restart | Compose **~3 minutes out**. Stop the **worker** only (`Ctrl+C` on the worker pane, or kill that process). Wait until the start time has passed. Start the worker again. Rows move to Sent **once** — nothing replayed from Day 1. |
| **3:40** | Rate limit + Slack | Compose with **hourly limit = 1** (or run `npx tsx tests/live/rateLimitFive.ts` from `backend/` after setting that sender’s `maxEmailsPerHour` to 2). Show `rate_limited` / Deferred on Scheduled, then the **Slack** limit-hit message (one per sender per hour). |
| **4:40** | Optional close | `/admin/queues` delayed/waiting counts. Logout. Stop. |

## If time is tight

Cut Search (2:20) or the queues board. **Do not cut** Google login, Compose, Sent + Preview, restart, or Slack on a limit hit — those are the enumerated demo beats.

## Notes

- Delay floor is **2 seconds** (`MIN_DELAY_BETWEEN_EMAILS_MS`).
- Restart proves BullMQ delayed jobs in Redis, not a cron replay.
- `POST /api/slack/test` is allowed as a Slack proof if the hourly window does not fire in time; still try a real limit hit for the bonus load beat.
