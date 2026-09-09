# ReachInbox — Email Job Scheduler

A production-grade email scheduling service and dashboard. Accepts email send
requests over an API, schedules them with **BullMQ delayed jobs** (no cron
anywhere), sends through **Ethereal SMTP** from multiple senders, enforces
Redis-backed per-sender and global hourly rate limits, survives restarts without
losing or duplicating a single email, and makes everything searchable through
Elasticsearch.

> **Status: Phase 6 of 6 complete.** Campaigns schedule, send through Ethereal,
> respect Redis Lua rate limits, and are searchable via Elasticsearch (with a
> Postgres fallback). Google OAuth, Slack incoming-webhooks, live rate-limit
> notifications, and a Compose modal with CSV upload are wired. A 1000-recipient
> load script records ingest/expand/pacing numbers without blasting Ethereal.
> Record the demo from [DEMO.md](./DEMO.md). See
> [Implementation status](#implementation-status).
>
> The complete pre-implementation architecture, including every design decision
> and its rejected alternatives, is in **[DESIGN.md](./DESIGN.md)**.

---

## Table of contents

- [Architecture at a glance](#architecture-at-a-glance)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Setting up Ethereal Email](#setting-up-ethereal-email)
- [Google and Slack OAuth setup](#google-and-slack-oauth-setup)
- [Running the services](#running-the-services)
- [How scheduling works](#how-scheduling-works)
- [How persistence on restart is handled](#how-persistence-on-restart-is-handled)
- [How rate limiting and concurrency are implemented](#how-rate-limiting-and-concurrency-are-implemented)
- [How search works](#how-search-works)
- [Testing](#testing)
- [Features mapped to the assignment](#features-mapped-to-the-assignment)
- [Implementation status](#implementation-status)
- [Submission](#submission)
- [Hosted assignment](./HOSTING.md)
- [Assumptions, shortcuts and trade-offs](#assumptions-shortcuts-and-trade-offs)

---

## Architecture at a glance

```
Browser (React SPA)
      │  httpOnly session cookie, same-origin via dev proxy
      ▼
┌─────────────────────────────────────────────┐
│ API (Express + TypeScript)                  │
│  /api/campaigns  /api/emails  /api/search   │
│  /api/auth/*     /api/slack/*               │
│  /admin/queues   (BullMQ dashboard)         │
└───┬─────────────┬──────────────┬────────────┘
    │ Prisma      │ BullMQ add   │ ES client
    ▼             ▼              ▼
┌────────┐  ┌──────────┐  ┌───────────────┐
│Postgres│  │  Redis   │  │ Elasticsearch │
│ truth  │  │ schedule │  │  search only  │
└────────┘  └────┬─────┘  └───────▲───────┘
    ▲            │                │
    │  ┌─────────▼────────────────┴──────┐
    └──┤ Worker (separate process, N×)    │
       │  campaign-expand · email-send    │
       │  search-index    · notifications │
       └───────────────┬──────────────────┘
                       ▼
              Ethereal SMTP (per sender)
```

**Postgres is the source of truth for intent** (what should be sent, to whom,
when). **Redis is the source of truth for scheduling** (which job fires when).
Recovery always means reconciling the second from the first.

The API and worker are separate processes built from one codebase, so they scale
independently and the worker can be restarted alone to demonstrate persistence.

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 7 (strict, all flags) |
| API | Express 5 |
| Queue | BullMQ 6 on Redis 7 |
| Database | PostgreSQL 16 via Prisma 7 (`@prisma/adapter-pg`) |
| Search | Elasticsearch 9 |
| SMTP | Ethereal Email via Nodemailer 10 |
| Frontend | React 19 + Vite 8 + Tailwind CSS 4 + TanStack Query |
| Auth | Google OAuth 2.0 (server-side code flow), Slack OAuth v2 |
| Tests | Vitest + Supertest |

**No cron of any kind.** No `crontab`, no `node-cron`, no `agenda`, and
deliberately no BullMQ repeatable jobs either — those take a cron expression, so
they are treated as out of bounds too. Scheduling is BullMQ delayed jobs, and
the only recovery sweep runs once at worker boot.

---

## Prerequisites

- **Node.js 20.11+** (developed on 24)
- **PostgreSQL 16** and **Redis 7** — via Docker, or any managed provider
- **Elasticsearch 9** — optional; search falls back to Postgres without it
- An **Ethereal Email** account (free, created by a seed script)

---

## Quick start

```bash
git clone <repo-url> && cd reachinbox-email-scheduler

# 1. Install both packages and generate the Prisma client
npm run setup

# 2. Configure
cp .env.example backend/.env
#    then fill in DATABASE_URL, DIRECT_URL, REDIS_URL, SESSION_JWT_SECRET,
#    ENCRYPTION_KEY. Generate the two secrets with:
#      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Start the datastores (skip if you are using managed services)
npm run infra:up              # postgres + redis
npm run infra:up:search       # optionally add Elasticsearch

# 4. Apply the schema
npm run prisma:migrate

# 5. Verify every dependency before starting anything
npm run check:deps

# 6. Create a local user + 3 real Ethereal senders. Paste DEV_USER_ID into backend/.env.
npm --prefix backend run seed:senders

# 7. Run the API, worker and frontend together
npm run dev
```

Then open **http://localhost:5173**. Sign in with Google (or the non-prod
`DEV_USER_ID` fallback). **Compose New Email** uploads a CSV, shows the detected
address count, and schedules via `POST /api/campaigns`. Scheduled and Sent tabs
poll every 5s; search uses `GET /api/search`.

```bash
curl -F "subject=Hello" -F "body=Hi there" -F "startAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -F "delayBetweenMs=2000" -F "file=@backend/tests/live/five.csv" \
  -H "Idempotency-Key: demo-1" \
  http://localhost:4000/api/campaigns
```

On Windows PowerShell, use `npx tsx tests/live/sendFive.ts` from `backend/` instead.

Useful single checks:

```bash
curl http://localhost:4000/healthz    # liveness, touches no dependency
curl http://localhost:4000/readyz     # readiness, probes all three
```

---

## Environment variables

Every variable is documented in **[.env.example](./.env.example)** and validated
at boot by `backend/src/config/env.ts`, which **refuses to start** on a missing
or malformed value and prints every problem at once:

```
✖ Invalid environment configuration. Refusing to start.

  - DATABASE_URL: Invalid input: expected string, received undefined
  - ENCRYPTION_KEY: must be exactly 64 hex characters (32 bytes)
```

Nothing else in the codebase reads `process.env`.

### The two database URLs

Prisma 7 removed the Rust query engine, so a driver adapter is mandatory and the
connection string is supplied in two places for two different consumers:

| Variable | Endpoint | Used by |
|---|---|---|
| `DATABASE_URL` | **pooled** (PgBouncer on Neon) | the runtime driver adapter |
| `DIRECT_URL` | **unpooled** | the Prisma CLI, for migrations |

Migrations cannot run through a transaction pooler — prepared statements are
incompatible with it and you get `prepared statement "s0" already exists`. With
plain Docker Postgres, set both to the same value.

### Rate limiting and throughput

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_CONCURRENCY` | `5` | jobs processed in parallel per worker process |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | `2000` | **minimum 2 seconds between sends**, per sender |
| `MAX_EMAILS_PER_HOUR` | `1000` | global hourly ceiling |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | per-sender hourly limit |
| `MAX_INLINE_WAIT_MS` | `5000` | longer pacing waits re-delay the job instead of holding a slot |

### `REDIS_ASSERT_NOEVICTION`

Redis must run with `maxmemory-policy=noeviction`. Under any `allkeys-*` policy
Redis is free to evict an entry from a BullMQ delayed set, which **silently
destroys a scheduled email** — no error, no log line, the email simply never
sends. Boot asserts the policy and refuses to start otherwise.

---

## Setting up Ethereal Email

Ethereal is a free fake SMTP service: messages are accepted and rendered but
never delivered, and each one gets a preview URL.

Multiple senders is a hard requirement, so the project provisions several
accounts and stores them in the `senders` table with **AES-256-GCM encrypted**
passwords, rather than creating throwaway accounts in memory that would be lost
on restart.

```bash
npm --prefix backend run seed:senders
```

The script prints `DEV_USER_ID=<uuid>` and writes it into `backend/.env` when
that key is missing or empty. Restart the API and worker afterwards so they
reload the identity. `DEV_USER_ID` is a **non-prod fallback**, not the demo
login: production never impersonates, and a missing session cookie is a 401.
Google login sets an httpOnly `sid` JWT cookie; `POST /api/auth/logout` clears it.

If Ethereal rate-limits account creation, pre-create accounts at
<https://ethereal.email/create> and paste them into `ETHEREAL_ACCOUNTS` as JSON.

Sent emails store their `previewUrl`, which the Sent Emails table links to — so
delivery is verifiable in one click.

---

## Google and Slack OAuth setup

Paste credentials into `backend/.env` and **restart the API**. Empty client IDs
are valid at boot: `GET /api/auth/google` and `GET /api/slack/install` return
`FEATURE_NOT_CONFIGURED` (503) until the values exist. There is no dummy login
and no fake webhook.

### Google Cloud Console

1. [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services
   → Credentials → Create OAuth client ID → **Web application**.
2. Authorised redirect URI (must match `GOOGLE_REDIRECT_URI` exactly):

   ```
   http://localhost:4000/api/auth/google/callback
   ```

3. OAuth consent screen in **Testing** mode; add your Google account under
   **Test users**.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/google/callback`.

Login is a real navigation to `/api/auth/google` (auth-code + PKCE), not an
id_token in JavaScript. The API upserts `users` by `google_sub`, sets an
httpOnly `sid` JWT (`SameSite=Lax`), and redirects to `{FRONTEND_URL}/dashboard`.

**Cookies through the Vite proxy.** The session cookie is issued by the API on
`:4000`. The SPA on `:5173` proxies `/api` to that origin so the browser treats
the cookie as same-site. `credentials: "include"` is set on every `fetch`. Do
not point the frontend at `localhost:4000` directly in development — that would
make the cookie cross-site.

### Slack app

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App →
   **OAuth & Permissions**.
2. Redirect URL (must match `SLACK_REDIRECT_URI` exactly):

   ```
   http://localhost:4000/api/slack/callback
   ```

3. Bot token scopes: **`incoming-webhook` only** (not `chat:write`).
4. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
   `SLACK_REDIRECT_URI=http://localhost:4000/api/slack/callback`.

Dashboard **Connect Slack** is `GET /api/slack/install`. After the user picks a
channel, the incoming-webhook URL is stored AES-256-GCM encrypted. Disconnect
sets `revoked_at`. `POST /api/slack/test` posts one live Block Kit message so
the demo does not have to wait for an hourly limit hit.

### Notifications worker

On `SENDER_HOURLY_LIMIT`, after the SETNX win, `email-send` **enqueues**
`notifications` (`notif:{senderId}:{hourEpoch}` — three `:` segments for
BullMQ 6). It does not `fetch` Slack inline. The notifications worker POSTs
Block Kit; no row or a revoked integration completes as `{ skipped:
"not_connected" }` and does not crash. `DEV_USER_ID` is not the demo login —
use Google for the recorded walkthrough.

---

## Running the services

### Everything at once (recommended for development)

```bash
npm run dev     # API :4000, worker, frontend :5173
```

### Individually

```bash
npm --prefix backend  run dev          # API with reload
npm --prefix backend  run dev:worker   # queue worker with reload
npm --prefix frontend run dev          # Vite dev server
```

The frontend proxies `/api` to `localhost:4000`. That is an auth decision, not a
convenience: the session is an httpOnly cookie, and proxying keeps it
same-origin so a plain `SameSite=Lax` cookie works without HTTPS in development
or running into third-party-cookie restrictions.

### Fully containerised

```bash
docker compose --profile app up -d --build
docker compose --profile app up -d --scale worker=3   # prove multi-instance limits
```

### Tests

```bash
npm --prefix backend run test                 # unit + health contract (no Neon)
# Live Neon + Redis; SMTP is stubbed. Requires DEV_USER_ID from seed:senders.
# PowerShell:
cd backend; $env:RUN_INTEGRATION="1"; npm run test:integration
npx tsx tests/live/sendFive.ts                # 5 real Ethereal messages (API + worker up)
npx tsx tests/live/rateLimitFive.ts           # 5 recipients; cap sender at 2/hour to see deferral
npm --prefix backend run load:1000            # 1000 recipients, future startAt, then cancel
```

The integration suite is opt-in (`RUN_INTEGRATION=1`) so a default `npm test`
cannot write to Neon. SMTP is a recording stub; `sendFive.ts` is the live
Ethereal demo.

### BullMQ dashboard

`http://localhost:4000/admin/queues` (also linked from the dashboard header, and
proxied at `http://localhost:5173/admin/queues`). HTTP Basic when
`BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` are set; otherwise the seeded admin
identity. Unauthenticated requests get 401.

---

## How scheduling works

Implemented in Phase 1. Full detail in [DESIGN.md §6–§7](./DESIGN.md).
**Pre-spread of `scheduled_at` and the Redis Lua limiter are both active.**

1. `POST /api/campaigns` validates the CSV, writes one `campaigns` row (including
   the recipient JSON so a 50k list is not stuffed into Redis), and enqueues a
   **`campaign-expand`** job. Response is `202` in O(1).
2. The expander creates `email_jobs` in batches of 500 (`createMany` +
   `skipDuplicates` on `dedupe_key`) and `addBulk` delayed jobs with
   `jobId = email:<uuid>:send` (BullMQ 6 requires three colon-separated segments).
3. Send time for recipient `i`:

   ```
   scheduledAt = startAt + max(i × delay, floor(i / hourlyLimit) × 1 hour)
   delay is clamped to MIN_DELAY_BETWEEN_EMAILS_MS (default **2000 ms**)
   ```
4. The `email-send` worker loads the row, **reserves a Redis rate-limit slot**,
   **conditionally claims** it, sends via Ethereal, stores `messageId` and
   `previewUrl`. Runtime Lua counters are the authority when another campaign
   shares the sender; pre-spread just makes the common case cheap.

Job payloads carry **only the `emailJobId`**. Subject, body and recipient are
read from Postgres so a thousand 5KB bodies do not duplicate in Redis.

`DEV_USER_ID` is a development identity only. Google session cookies are the
real login; production never impersonates.

---

## How persistence on restart is handled

*Implemented in Phase 2. Full detail in [DESIGN.md §21](./DESIGN.md).*

**Normal restart.** BullMQ keeps delayed jobs in a Redis sorted set keyed by
timestamp. On boot the worker reconnects and BullMQ promotes everything whose
time has come — including jobs whose time passed while the process was down,
which fire immediately. Nothing is rescheduled from scratch. Redis runs AOF with
`appendfsync everysec` on a named volume, so a restart loses at most one second
of writes.

**Graceful shutdown.** `SIGTERM` stops new work, waits for in-flight sends, then
closes the pools. This is what keeps a send from being killed mid-SMTP and left
with an unknown outcome.

**Crash / SIGKILL.** In-flight jobs are never acked, so BullMQ's stalled-job
checker returns them to `waiting` and they are redelivered. The idempotency
layers below ensure redelivery does not double-send.

**Redis data loss** — a flush, a wiped volume, an eviction — is the failure
BullMQ alone cannot survive. A **one-shot reconciler** at worker boot queries
Postgres for every `scheduled` / `rate_limited` row, checks whether its job still
exists in Redis by deterministic id, and re-adds only the missing ones.
Deterministic job ids are what make it safe to run repeatedly. Rows stuck in
`claimed` past `STALE_CLAIM_TIMEOUT_MS` are reset.

It runs **once, at boot** (plus `POST /api/admin/reconcile` on demand) rather
than periodically, because "every five minutes" is a cron by another name.

### Idempotency: five independent layers

| Layer | Mechanism | Prevents |
|---|---|---|
| 1. API | `Idempotency-Key` header + unique `campaigns.idempotency_key` | double-clicked Schedule, retried timed-out POST |
| 2. Row | unique `email_jobs.dedupe_key` = `sha256(campaignId:email)` | retried expander batch, duplicate CSV rows |
| 3. Queue | deterministic `jobId = email:<uuid>:send` | BullMQ treats an existing id as a duplicate |
| 4. Claim | conditional `UPDATE … WHERE status IN ('scheduled','rate_limited','failed')` | two workers taking the same job |
| 5. Terminal | early return when already `sent`/`cancelled` | redelivery after a successful send |

The one gap, stated plainly: if SMTP returns `250 OK` and the process dies before
the `sent` write, redelivery could send twice. Closing that properly needs a
provider-honoured idempotency token, which SMTP does not offer. The row is
therefore marked `claimed` *before* the send, and rows left in `claimed` are
surfaced as `needs_review` rather than blindly retried — at-most-once, chosen
deliberately for email.

---

## How rate limiting and concurrency are implemented

*Implemented in Phase 2. Full detail in [DESIGN.md §9–§11](./DESIGN.md).*

### Concurrency

`WORKER_CONCURRENCY` (default 5) per worker process, and processes scale
horizontally, so real parallelism is `replicas × concurrency`. **No
correctness-critical state lives in a JS variable** — every counter is in Redis
and every state transition is a conditional SQL `UPDATE`. That is what makes
`--scale worker=3` safe.

### The chosen delay: minimum 2 seconds between sends

Enforced per sender through a Redis `pace:sender:{id}` key holding the next
allowed send time. With N workers running in parallel, a given sender still
emits at most one email every 2 seconds. Concurrency therefore buys throughput
*across* senders and resilience within one.

### Hourly limits

Fixed-window counters in Redis, keyed by `hour_window + sender`, evaluated by a
**single Lua script** that atomically checks the global counter, the per-sender
counter and the pacing key, then increments all three:

```
rl:global:{hourEpoch}              global usage
rl:sender:{senderId}:{hourEpoch}   per-sender usage
pace:sender:{senderId}             next allowed send time
```

One round trip means there is no check-then-act race across workers or
instances. In-memory counting is used nowhere.

**Why not BullMQ's built-in `limiter`?** It is queue-wide, so it cannot express a
per-sender limit, and `{ max: 200, duration: 3600000 }` starves the queue for the
rest of the hour with no visibility into why. `email-send` still sets
`limiter: { max: 50, duration: 1000 }` as a coarse stampede guard only. The real
limits live in Lua.

**Pre-spread vs runtime.** Campaign expand still writes a `scheduled_at` that
already respects delay and hourly caps so a 1000-recipient list does not all
wake in hour one. Lua is what stops **cross-campaign** oversend when another
campaign shares the sender.

**Reconciler.** `RECONCILE_ON_BOOT` runs the one-shot repair **before** workers
start. `POST /api/admin/reconcile` (admin identity) is the same function. There
is no cron and no `setInterval` sweeper.

Fixed window over sliding log: the assignment's own suggestion is
`hour_window + sender`, a burst at a window boundary is acceptable for an
outreach throttle, and a sliding log would cost 1000 sorted-set members per
sender per hour to buy precision nobody needs here.

### When the limit is reached

Jobs are **never dropped and never permanently failed**:

```
rank  = INCR overflow:{senderId}:{nextHourEpoch}     -- atomic, FIFO
newTs = nextWindowStart + (rank - 1) × delay + jitter
job.moveToDelayed(newTs); throw new DelayedError()
```

`moveToDelayed` rather than adding a new job, because a second job for the same
email would break idempotency the moment a reschedule raced a retry. And because
it is not a `throw`, a rate-limited email **does not consume a retry attempt** and
can never land in the failed set.

Order is preserved best-effort: the queue is FIFO, so denials arrive roughly in
sequence and `INCR` hands out ranks in exactly that order — the overflow tail
keeps its relative order and arrives already paced into the next window.

### Slack notification on a limit hit

Phase 2 records `rate_limit_events` (unique on `sender_id + hour_window`) and
wins `SET notif:rl:{senderId}:{hourEpoch} NX EX 7200`. Phase 4 enqueues the
`notifications` queue on that SETNX win; the dedicated worker POSTs a Block Kit
incoming-webhook. No integration, or `revoked_at` set, skips without failing
the email. `POST /api/slack/test` posts one live message on demand.

### Behaviour with 1000+ emails at once

With 1000 recipients, 3 senders, a 200/hour per-sender limit and a 2s delay:
~600 emails go out in hour one and ~400 in hour two, completing in about two
hours. That is the *correct* answer for the configured limits — finishing in five
minutes would mean the rate limits were being ignored. Ingest stays O(1) from the
API's perspective, Redis holds ~400KB of thin payloads, and Elasticsearch
receives two bulk requests rather than a thousand.

---

## How search works

*Implemented in Phase 3. Full detail in [DESIGN.md §12](./DESIGN.md).*

Scheduled and sent emails are searchable through Elasticsearch. The sending path
never talks to ES: the expander enqueues one `search-index` **bulk** job per 500
rows, and the send worker enqueues a **single** index job on `sent`, `failed`,
and `rate_limited`. Documents use `_id = email_jobs.id`, so retries overwrite.

The index is `emails_v1` behind alias `emails`. If `emails` already exists as a
concrete index (common on Elastic Cloud), we write to it and do not delete it.

`GET /api/search?q=&status=&senderId=&from=&to=&page=&limit=` is always scoped to
the current user. If Elasticsearch is down or `SEARCH_ENABLED=false`, the same
endpoint falls back to Postgres `ILIKE` on subject and recipient and returns
`meta.degraded: true`. Sends keep working.

`POST /api/admin/reindex` streams Postgres → `_bulk` (admin only). The
`search-index` worker lives in the existing worker process and starts **only**
when search is configured, so Redis Cloud does not pay for a no-op connection.
The dashboard SearchBar calls this endpoint with a debounce; an empty query uses
the scheduled/sent list APIs instead.

---

## Testing

```bash
npm test                              # full suite
npm --prefix backend run test:watch   # watch mode
```

Real Redis and Postgres are used for integration tests rather than mocks: the
entire correctness argument rests on Lua atomicity, and a mock would test
nothing that matters.

Highest-value tests, by phase:

- **Phase 0 (done)** — AES-256-GCM round-trip, tamper detection, malformed input;
  `/healthz` contract, error envelope, correlation-id handling and reflection
  guard.
- **Phase 2 (done)** — 500 concurrent `reserveSlot` calls against a limit of 200
  yield exactly 200 `ALLOW`; `PACE` does not increment counters; a sender cap of
  2 with 5 recipients sends 2 and defers 3 as `rate_limited`; flushing a Redis
  job and running the reconciler restores it once. Optional live demo:
  `npx tsx tests/live/rateLimitFive.ts` (do not send 250 Ethereal in CI).
- **Phase 3 (done)** — `/api/search` returns scheduled and sent rows by subject
  and recipient; ES down or disabled degrades to Postgres `ILIKE` with
  `degraded: true`; `POST /api/admin/reindex` upserts by `_id` and does not
  duplicate hits.
- **Phase 4 (done)** — Google auth-code + PKCE, httpOnly `sid` JWT, Slack
  `incoming-webhook` OAuth, notifications worker + `/api/slack/test`. Empty
  OAuth creds return `FEATURE_NOT_CONFIGURED`; `DEV_USER_ID` remains a non-prod
  fallback so the existing integration suite still passes.

### Load test (1000 recipients)

Does **not** send 1000 Ethereal messages. It POSTs a 1000-row CSV with
`startAt` ~24h ahead, waits for expand, asserts the first hour is paced at
≥2s and capped at 200, then cancels the campaign.

```bash
npm run dev                         # API + worker + frontend
npm --prefix backend run load:1000
```

Recorded against the live stack (2026-09-09):

| Metric | Result |
|---|---|
| `POST /api/campaigns` (1000 rows) | **2282 ms**, HTTP 202 |
| Expand to 1000 `email_jobs` | **14939 ms** |
| First-hour consecutive `scheduled_at` gap | **2000 ms** (floor `MIN_DELAY_BETWEEN_EMAILS_MS`) |
| Jobs in the first hour window | **200** (campaign `hourlyLimit`) |

Overflow rows share the next hour *boundary* by design (`max(i × delay, floor(i / limit) × 1 hour)`); runtime Lua still paces them if they ever fire. Set `SKIP_CANCEL=1` to leave the campaign queued.

---

## Features mapped to the assignment

| Assignment bullet | Where it lives |
|---|---|
| Accept send requests via API | `POST /api/campaigns` (multipart CSV) |
| Persist in PostgreSQL | `campaigns` + `email_jobs` |
| Schedule with BullMQ delayed jobs, **no cron** | `email-send` delayed jobs; reconciler is boot-only |
| Multiple senders, Ethereal SMTP | `senders` table, pooled Nodemailer, preview URLs |
| Searchable via Elasticsearch | `search-index` worker; Postgres `ILIKE` fallback |
| Live BullMQ dashboard | `/admin/queues` |
| Survive restart; future emails still send | Redis AOF + one-shot DB→Redis reconciler |
| Idempotency / no duplicate sends | five layers (see persistence section) |
| Configurable worker concurrency | `WORKER_CONCURRENCY` |
| Minimum delay between sends | **2 seconds** (`MIN_DELAY_BETWEEN_EMAILS_MS=2000`) |
| Hourly rate limit, Redis-backed, multi-worker | Lua `reserveSlot` on `rl:global` / `rl:sender` |
| On limit hit: delay, do not drop | `moveToDelayed` + FIFO overflow rank |
| Real Slack OAuth + live message on limit | incoming-webhook + `notifications` worker |
| Defined behaviour at 1000+ emails | expander `addBulk` + pre-spread; `load:1000` |
| Real Google OAuth, header name/email/avatar, logout | `/api/auth/google`, `AppHeader` |
| Dashboard Scheduled / Sent, Compose, CSV count | Compose modal + tabbed tables |
| Loading / empty / error UX | skeletons, empty copy, toasts |

---

## Implementation status

| Phase | Scope | Status |
|---|---|---|
| **0** | Repo, config, logging, errors, DB schema, clients, health, app shell, CI-ready build | **Complete** |
| **1** | Scheduling core: campaigns API, CSV parsing, expander, `email-send` worker, Ethereal senders | **Complete** |
| **2** | Rate limiting (Lua), pacing, concurrency, next-window reschedule, reconciler, BullMQ dashboard | **Complete** |
| **3** | Elasticsearch indexing and search, Postgres fallback, reindex endpoint | **Complete** |
| **4** | Google OAuth, sessions, Slack OAuth, live rate-limit notifications | **Complete** |
| **5** | Dashboard UI: Scheduled/Sent tables, Compose modal with CSV upload, search | **Complete** |
| **6** | README completion, load test, demo shot list | **Complete** |

### Delivered in Phase 0

- Private repository, reviewers invited, conventional commits.
- Complete six-model Postgres schema with every index and constraint the later
  phases need, including the `dedupe_key` uniqueness that underpins idempotency.
- Fail-fast configuration: 40+ validated variables, no `process.env` reads
  elsewhere, feature gating for optional integrations.
- Structured logging with redaction for SMTP passwords, Slack webhooks, session
  cookies and connection strings.
- Error taxonomy with stable codes and a single error-to-JSON translator that
  never leaks internals in a 5xx.
- Real Postgres, Redis and Elasticsearch clients, with the Redis `noeviction`
  assertion and connection-count reporting.
- `/healthz` and `/readyz` with parallel, individually timed dependency probes.
- Graceful shutdown shared by both entrypoints.
- React shell with reusable UI primitives and a live infrastructure panel reading
  real health from all three services.
- 38 passing unit tests; live integration coverage for idempotency, CSV
  dedupe, and single-send; clean strict typecheck for both packages.

### Delivered in Phase 1

- `POST /api/campaigns` (multipart CSV), preview-csv, list/get/cancel.
- BullMQ `campaign-expand` and `email-send` with deterministic job ids.
- Real Ethereal senders (encrypted SMTP passwords), pooled Nodemailer, preview URLs.
- Conditional DB claim so a job cannot send twice.
- Dashboard scheduled/sent tables poll the live API.
- `DEV_USER_ID` development identity (production still 401 without a session).

### Delivered in Phase 2

- Atomic `reserveSlot` / `releaseSlot` Lua on the **shared** ioredis client
  (`rl:global`, `rl:sender`, `pace:sender`). Never on a Worker BRPOP connection.
- Next-window overflow via `moveToDelayed` + `DelayedError` (retry attempts are
  not consumed). `rate_limited` rows, `reschedule_count`, `rate_limit_events`,
  and `SETNX` notify dedupe.
- `email-send` order: load → reserve → deny/pace reschedule → claim →
  `releaseSlot` on lost claim or SMTP failure → optional pace sleep → send.
- One-shot reconciler at worker boot and `POST /api/admin/reconcile`.
- `/admin/queues` (bull-board) behind HTTP Basic or admin identity.
- Header “Queues” link; deferred emails show `rescheduleCount` in the table.

### Delivered in Phase 3

- `emails_v1` mapping + `emails` alias (`ensureIndices` at API and worker boot).
- Dedicated `search-index` BullMQ queue on the shared Redis client; one Worker
  inside the existing worker process, skipped when search is off.
- Bulk index after expand; single index on sent, failed, and rate_limited.
- `GET /api/search` with user-scoped ES query and Postgres `ILIKE` fallback.
- `POST /api/admin/reindex` streams Postgres → `_bulk`.

### Delivered in Phase 4

- Server-side Google OAuth (auth-code + PKCE). `GET /api/auth/google` → consent
  → upsert `users` by `google_sub` → `Set-Cookie: sid` (httpOnly JWT with
  `tokenVersion`) → `/dashboard`. First login provisions an Ethereal sender
  without blocking the session if Ethereal is down.
- `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/auth/features`.
  Production: no cookie is 401. Non-prod: `DEV_USER_ID` fallback for tests and
  local use — it is not the recorded-demo login.
- Slack install (`incoming-webhook`), encrypted webhook storage, status,
  disconnect (`revoked_at`), and `POST /api/slack/test`.
- `notifications` BullMQ queue + worker (Block Kit). `email-send` enqueues after
  SETNX; it never waits on Slack.
- Login page Google link, ProtectedRoute, header identity + Connect Slack.

### Delivered in Phase 5

- Compose modal: subject, body, CSV/text dropzone, detected count from
  `POST /api/campaigns/preview-csv`, start time, delay (seconds → ms), optional
  hourly limit, `Idempotency-Key` on schedule.
- Scheduled / Sent tabs with SearchBar (`GET /api/search`), pagination, loading
  skeletons, empty states, status badges, and Ethereal preview links.
- Dashboard is the schedule path; the campaign API remains for scripts and tests.

### Delivered in Phase 6

- `npm --prefix backend run load:1000` schedules 1000 recipients (future `startAt`), asserts 2s first-hour pacing and a 200/hour cap, then cancels. Recorded: API **2282 ms**, expand **14939 ms**.
- Assignment-mapped feature checklist and submission notes in this README.
- [DEMO.md](./DEMO.md) timed shot list for a ≤5 minute recording (you record the video; do not commit the file).
- Infrastructure panel stringifies object health details (Redis `lastReconcile`).

---

## Submission

- **Private GitHub repo.** Grant access to **`Mitrajit`** and **`Yadav036`**.
- **Hosted dashboard:** [HOSTING.md](./HOSTING.md) (Render). Paste that URL in both “Hosted” form fields.
- **Demo video (max 5 minutes):** follow [DEMO.md](./DEMO.md). Do not commit the recording.
- **Submission form:** [Assignment Submission](https://forms.clickup.com/9005062261/f/8cbwp3n-8876/6NNNJ92DV93PQTAYST).

---

## Assumptions, shortcuts and trade-offs

**Assumptions**

1. One campaign is one subject and body sent to N recipients from a CSV. "An
   email" in the dashboard is one recipient row, not one campaign.
2. Both a global and a per-sender hourly limit are implemented, though the brief
   asked for either. Per-sender is authoritative; global is a hard ceiling. It
   costs nothing extra in the same Lua script.
3. The Compose form's delay and hourly limit are per-campaign overrides. The
   delay is clamped to the `MIN_DELAY_BETWEEN_EMAILS_MS` floor so a client cannot
   request 0ms, and the effective hourly limit is
   `min(campaign, sender, env default)`.
4. Rate-limit windows are fixed UTC hours.

**Deliberate trade-offs**

1. **API types are duplicated** in `frontend/src/types/api.ts` rather than shared
   through a workspace package. A `packages/shared` build step costs more than it
   saves at this size; the cost is keeping them in step by hand.
2. **Polling, not WebSockets**, for live table updates (TanStack Query at 5s). A
   WS transport would be more elegant but adds reconnection and auth-over-socket
   handling for data that only needs 5-second freshness.
3. **Stateless session JWT** in an httpOnly cookie rather than Redis-backed
   sessions. Instant revocation is traded for one less lookup per request and one
   less failure mode; a `tokenVersion` column invalidates all of a user's
   sessions when bumped.
4. **Fixed-window rate limiting** allows up to 2× the limit across a window
   boundary. Accepted for an outreach throttle; a token bucket or sliding log
   would smooth it at the cost of complexity.
5. **At-most-once on the crash-after-SMTP-ack window** (see above), chosen over
   risking a duplicate send.
6. **The reconciler runs only at boot**, not periodically, to stay inside the
   no-cron constraint. In production this belongs in a supervised job runner.
7. **Elasticsearch is never a source of truth.** If it is down or unconfigured,
   search degrades to a Postgres `ILIKE` query and the response is flagged
   `degraded`. Nothing on the sending path touches it.

**Environment note**

Development ran against managed Postgres, Redis and Elasticsearch rather than
local containers, because the development machine could not run Docker. The
committed `docker-compose.yml` is written to the same configuration the
application expects and is the documented path for reviewers, but it was not
executed on the development machine — so it is kept deliberately conventional
and minimal.
