# ReachInbox — Email Job Scheduler

A production-grade email scheduling service and dashboard. Accepts email send
requests over an API, schedules them with **BullMQ delayed jobs** (no cron
anywhere), sends through **Ethereal SMTP** from multiple senders, enforces
Redis-backed per-sender and global hourly rate limits, survives restarts without
losing or duplicating a single email, and makes everything searchable through
Elasticsearch.

> **Status: Phase 0 of 6 complete.** The foundation is in place — configuration,
> logging, error handling, the full database schema, live dependency health, and
> both service entrypoints with graceful shutdown. The scheduling core lands in
> Phase 1. See [Implementation status](#implementation-status).
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
- [Testing](#testing)
- [Implementation status](#implementation-status)
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

# 6. Run the API, worker and frontend together
npm run dev
```

Then open **http://localhost:5173**. The dashboard shows live health for
Postgres, Redis and Elasticsearch, read from the real services.

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
# Phase 1: creates SEED_SENDER_COUNT Ethereal accounts and inserts sender rows
npm --prefix backend run seed:senders
```

If Ethereal rate-limits account creation, pre-create accounts at
<https://ethereal.email/create> and paste them into `ETHEREAL_ACCOUNTS` as JSON.

Sent emails store their `previewUrl`, which the Sent Emails table links to — so
delivery is verifiable in one click.

---

## Google and Slack OAuth setup

*Wired in Phase 4. Credentials are configured now so nothing is blocked later.*

**Google** — [console.cloud.google.com](https://console.cloud.google.com) →
APIs & Services → Credentials → Create OAuth client ID → Web application.
Authorised redirect URI:

```
http://localhost:4000/api/auth/google/callback
```

Add your account under OAuth consent screen → Test users while the app is in
Testing mode. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`.

**Slack** — [api.slack.com/apps](https://api.slack.com/apps) → Create New App →
OAuth & Permissions. Add the redirect URL:

```
http://localhost:4000/api/slack/callback
```

Add the **`incoming-webhook`** scope. Set `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`.

`incoming-webhook` is used rather than `chat:write` because the user picks the
target channel during install and the result is a single POST-able URL — fewer
moving parts and fewer live-demo failure modes.

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

### BullMQ dashboard

`http://localhost:4000/admin/queues` — live queue visibility (waiting, delayed,
active, completed, failed, plus per-job data). Gated behind an admin session,
with HTTP Basic as a fallback. *Mounted in Phase 2.*

---

## How scheduling works

*Implemented in Phase 1. Full detail in [DESIGN.md §6–§7](./DESIGN.md).*

1. `POST /api/campaigns` validates the request, parses the CSV, deduplicates and
   validates recipients, writes one `campaigns` row, and enqueues a single
   **`campaign-expand`** job. It responds `202` immediately, so the request never
   waits on a thousand inserts.
2. The expander creates `email_jobs` rows in batches of 500 (`createMany`) and
   enqueues delayed jobs with `addBulk` — roughly four database statements and
   four Redis round trips for 1000 recipients, not 2000.
3. Each recipient's send time is computed at enqueue time:

   ```
   scheduledAt = startAt + max(index × delay, floor(index / hourlyLimit) × 1 hour)
   ```

   That second term **pre-spreads** recipients across hour windows, so with a
   200/hour limit, emails 200–399 are scheduled directly into hour two rather
   than all piling onto hour one and each being deferred individually. It turns
   ~800 wasted worker pickups into zero.
4. The `email-send` worker loads the row, reserves a rate-limit slot, claims the
   row, sends through Ethereal, and records the message id and preview URL.

Job payloads carry **only the `emailJobId`**; subject, body and recipient are
read from Postgres. A thousand jobs each holding a 5KB HTML body would put ~5MB
of duplicated data in Redis per campaign, and the payload could drift from the
database.

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
| 3. Queue | deterministic `jobId = email:<uuid>` | BullMQ rejects a duplicate add outright |
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
rest of the hour with no visibility into why. It is used only as a coarse global
stampede guard.

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

The moment a sender's hourly limit is reached, a **real message** is posted to the
user's Slack via their stored incoming webhook. Guarded by
`SET notif:rl:{senderId}:{hourEpoch} NX`, so 800 deferred jobs produce **exactly
one** message per sender per hour rather than 800. If Slack was never connected,
nothing is sent and nothing crashes; connect it later and notifications start
working with no redeploy, because the token is read from the database at send
time.

### Behaviour with 1000+ emails at once

With 1000 recipients, 3 senders, a 200/hour per-sender limit and a 2s delay:
~600 emails go out in hour one and ~400 in hour two, completing in about two
hours. That is the *correct* answer for the configured limits — finishing in five
minutes would mean the rate limits were being ignored. Ingest stays O(1) from the
API's perspective, Redis holds ~400KB of thin payloads, and Elasticsearch
receives two bulk requests rather than a thousand.

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
- **Phase 2** — 500 concurrent `reserveSlot` calls against a limit of 200 must
  yield exactly 200 grants. Duplicate-prevention: the same job run twice
  concurrently must call the transporter exactly once. Restart: stop the worker
  mid-run, start it, and all emails send exactly once.

---

## Implementation status

| Phase | Scope | Status |
|---|---|---|
| **0** | Repo, config, logging, errors, DB schema, clients, health, app shell, CI-ready build | **Complete** |
| 1 | Scheduling core: campaigns API, CSV parsing, expander, `email-send` worker, Ethereal senders | Next |
| 2 | Rate limiting (Lua), pacing, concurrency, next-window reschedule, reconciler, BullMQ dashboard | Planned |
| 3 | Elasticsearch indexing and search, Postgres fallback, reindex endpoint | Planned |
| 4 | Google OAuth, sessions, Slack OAuth, live rate-limit notifications | Planned |
| 5 | Dashboard UI: Scheduled/Sent tables, Compose modal with CSV upload, search | Planned |
| 6 | README completion, load test, demo video | Planned |

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
- 17 passing tests; clean strict typecheck and production build for both packages.

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
