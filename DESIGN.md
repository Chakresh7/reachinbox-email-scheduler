# ReachInbox Email Job Scheduler — Architecture & Design

> Design document written before implementation. Every non-obvious decision lists the
> alternatives considered and the recommendation. No application code yet.

---

## 0. Requirement extraction from ASSIGNMENT.md

### Hard requirements (graded, non-negotiable)

| # | Requirement | Where it is satisfied |
|---|---|---|
| R1 | Accept email send requests via API | `POST /api/campaigns` |
| R2 | Persist in PostgreSQL | `campaigns` + `email_jobs` tables |
| R3 | Schedule with BullMQ delayed jobs, **no cron** | `email-send` queue, precomputed `delay` |
| R4 | Send from **multiple senders** via Ethereal SMTP | `senders` table + per-sender pooled transporters |
| R5 | Emails searchable via **Elasticsearch** (indexing implemented) | `search-index` queue → `emails` index |
| R6 | **Live BullMQ dashboard** | `bull-board` mounted at `/admin/queues` |
| R7 | Survive restart; future emails still send at right time | Redis AOF + DB-as-source-of-truth startup reconciler |
| R8 | No duplicates / idempotency | deterministic `jobId` + DB conditional claim + unique dedupe key |
| R9 | Configurable worker concurrency | `WORKER_CONCURRENCY` env |
| R10 | Minimum delay between individual sends | Redis pacing key (`MIN_DELAY_BETWEEN_EMAILS_MS`, default 2000) |
| R11 | Emails/hour rate limit, global **and** per-sender, Redis-backed, multi-worker safe | atomic Lua script on hour-window counters |
| R12 | On limit hit: never drop — reschedule into next hour window, preserve order | `moveToDelayed` + FIFO overflow rank |
| R13 | **Real Slack OAuth** + live message on rate-limit hit | `slack_integrations` + `notifications` queue, once per (sender, hour) |
| R14 | Defined behavior at 1000+ emails at same time | expander fan-out job + `addBulk` + paced delays |
| R15 | **Real Google OAuth** login, header shows name/email/avatar, logout | server-side auth-code flow + httpOnly cookie session |
| R16 | Dashboard: Scheduled / Sent tabs, Compose modal, CSV upload with count, loading + empty states | React app per Figma |
| R17 | Clean structure, reusable components, DRY, real TypeScript types | folder structures below |

### Explicitly forbidden
- OS cron, `node-cron`, `agenda`, `bree`, or **BullMQ repeatable/cron jobs** (they take a cron
  expression — I treat them as banned even though BullMQ owns them).
- Any periodic polling loop dressed up as a scheduler (`setInterval` sweeper) — I use it in
  **zero** places on the scheduling path. The only startup work is a one-shot reconciler.

### Requirements the assignment states loosely (I am choosing an interpretation)
1. "Rate limit either global **or** per-sender" → I implement **both**, per-sender is authoritative,
   global is a hard ceiling. Costs nothing extra in the same Lua script and it demos better.
2. "Delay between emails" is *also* a per-campaign user input in the Compose form → per-campaign
   value is used as the pacing target, but it is **clamped to a floor** of the env-level
   `MIN_DELAY_BETWEEN_EMAILS_MS` so a user cannot ask for 0ms.
3. Compose form's "hourly limit" is a **per-campaign override** stored on the campaign; the
   effective limit is `min(campaign.hourlyLimit, sender.maxPerHour ?? env.MAX_PER_HOUR_PER_SENDER)`.
4. One campaign = one subject/body + N recipients from CSV. So "an email" in the UI tables is one
   row of `email_jobs`, not one campaign.

---

## 1. System architecture

```
                         ┌──────────────────────────┐
   Browser (React SPA)   │  Google OAuth  Slack OAuth│
        │                └──────────────────────────┘
        │ httpOnly cookie          ▲          ▲
        ▼                          │          │
┌───────────────────────────────────┴──────────┴──────────┐
│  API service  (Express + TypeScript)                    │
│  ─ /api/auth/*      session, Google callback            │
│  ─ /api/campaigns   validate CSV, write DB, enqueue     │
│  ─ /api/emails      list scheduled / sent (Postgres)    │
│  ─ /api/search      Elasticsearch query                 │
│  ─ /api/slack/*     OAuth install + status              │
│  ─ /admin/queues    bull-board (auth-gated)             │
└───┬──────────────┬───────────────┬──────────────────────┘
    │ Prisma       │ BullMQ add    │ ES client
    ▼              ▼               ▼
┌────────┐   ┌──────────┐    ┌───────────────┐
│Postgres│   │  Redis   │    │ Elasticsearch │
│ (truth)│   │(queues + │    │ (search only) │
│        │   │ counters)│    │               │
└────────┘   └────┬─────┘    └───────▲───────┘
    ▲             │                  │
    │             ▼                  │
    │   ┌──────────────────────────────────────┐
    └───┤  Worker service (separate process,   │
        │  N replicas, concurrency = env)      │
        │   • campaign-expand  (fan-out)       │
        │   • email-send       (SMTP + limits) │
        │   • search-index     (ES upsert)     │
        │   • notifications    (Slack webhook) │
        └───────────────┬──────────────────────┘
                        ▼
                 Ethereal SMTP (per sender)
```

### Process topology decision

| Option | Pros | Cons |
|---|---|---|
| A. API and worker in one process | one container, simplest | a slow SMTP send blocks nothing (async) but CPU/GC contention is real; can't scale independently; restart demo is less convincing |
| **B. API and worker as separate entrypoints in one codebase (recommended)** | shares Prisma/queue/config modules, independent scaling, restart-the-worker demo is clean, matches "wire queues correctly" | two containers |
| C. Separate repos/packages | strictest boundaries | duplication, no time for it in 48h |

**Recommended: B.** One `backend/` package, two entrypoints: `src/server.ts` (Express) and
`src/worker.ts` (BullMQ workers). `docker-compose` runs them as two services from the same image
with different commands. This also lets me scale workers with `docker compose up --scale worker=3`
in the demo, which is the cheapest way to *prove* the rate limiter is multi-instance safe.

### Repository layout

```
reachinbox-scheduler/
├─ backend/
├─ frontend/
├─ docker-compose.yml
├─ .env.example
└─ README.md
```

Plain two-folder monorepo, **no** pnpm/turbo workspace. Rationale: workspace tooling costs setup
time and buys nothing here (no shared package). Shared API types are duplicated into
`frontend/src/types/api.ts` — a deliberate, documented trade-off over a `packages/shared` build step.

---

## 2. Backend architecture and folder structure

Layering: **route → controller → service → repository/queue**. Controllers do no business logic;
services never touch `req`/`res`; SMTP/ES/Slack live behind thin clients so they can be faked in tests.

```
backend/
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts                     # creates users? no — creates Ethereal senders
├─ src/
│  ├─ server.ts                   # entrypoint: express app + graceful shutdown
│  ├─ worker.ts                   # entrypoint: all BullMQ workers + graceful shutdown
│  ├─ app.ts                      # express app assembly (no listen) → testable
│  ├─ config/
│  │  ├─ env.ts                   # zod-validated process.env, fails fast at boot
│  │  └─ constants.ts             # queue names, job names, redis key builders
│  ├─ lib/
│  │  ├─ prisma.ts                # singleton PrismaClient
│  │  ├─ redis.ts                 # ioredis connections (separate conn for workers)
│  │  ├─ elasticsearch.ts         # ES client + index bootstrap (ensureIndex)
│  │  ├─ logger.ts                # pino, requestId child logger
│  │  ├─ crypto.ts                # AES-256-GCM encrypt/decrypt for SMTP pw + slack url
│  │  └─ errors.ts                # AppError, HttpError, toErrorResponse
│  ├─ middleware/
│  │  ├─ requireAuth.ts           # verifies session cookie → req.user
│  │  ├─ validate.ts              # zod body/query/params validator
│  │  ├─ errorHandler.ts          # single error → JSON envelope translator
│  │  ├─ rateLimitApi.ts          # express-rate-limit on auth + schedule routes
│  │  └─ requestId.ts
│  ├─ modules/
│  │  ├─ auth/
│  │  │  ├─ auth.routes.ts
│  │  │  ├─ auth.controller.ts
│  │  │  ├─ google.service.ts     # code exchange, id_token verify
│  │  │  └─ session.service.ts    # sign/verify JWT, cookie options
│  │  ├─ campaigns/
│  │  │  ├─ campaigns.routes.ts
│  │  │  ├─ campaigns.controller.ts
│  │  │  ├─ campaigns.service.ts  # validate → tx insert → enqueue expander
│  │  │  ├─ campaigns.repo.ts
│  │  │  └─ csv.service.ts        # parse + dedupe + validate recipient list
│  │  ├─ emails/
│  │  │  ├─ emails.routes.ts      # GET scheduled / sent / :id, cancel
│  │  │  ├─ emails.controller.ts
│  │  │  ├─ emails.service.ts
│  │  │  └─ emails.repo.ts
│  │  ├─ search/
│  │  │  ├─ search.routes.ts
│  │  │  ├─ search.service.ts     # ES query builder + PG fallback
│  │  │  └─ index.mapping.ts
│  │  ├─ senders/
│  │  │  ├─ senders.routes.ts
│  │  │  └─ senders.service.ts    # round-robin / least-loaded selection
│  │  ├─ slack/
│  │  │  ├─ slack.routes.ts       # /install, /callback, /status, /disconnect
│  │  │  ├─ slack.oauth.service.ts
│  │  │  └─ slack.notify.service.ts
│  │  └─ health/
│  │     └─ health.routes.ts      # /healthz (liveness) /readyz (pg+redis+es)
│  ├─ queues/
│  │  ├─ connection.ts            # shared redis opts (maxRetriesPerRequest: null)
│  │  ├─ index.ts                 # Queue instances, typed add() helpers
│  │  ├─ emailSend.queue.ts
│  │  ├─ campaignExpand.queue.ts
│  │  ├─ searchIndex.queue.ts
│  │  ├─ notifications.queue.ts
│  │  └─ types.ts                 # job payload interfaces (typed Queue<T>)
│  ├─ workers/
│  │  ├─ emailSend.worker.ts      # the important one
│  │  ├─ campaignExpand.worker.ts
│  │  ├─ searchIndex.worker.ts
│  │  ├─ notifications.worker.ts
│  │  └─ shared/
│  │     ├─ claimEmailJob.ts      # DB conditional claim (idempotency gate)
│  │     └─ rescheduleToNextWindow.ts
│  ├─ ratelimit/
│  │  ├─ scripts/reserveSlot.lua  # atomic: global + sender + pacing
│  │  ├─ scripts/releaseSlot.lua  # compensating DECR on send failure
│  │  └─ rateLimiter.ts           # loadScript + typed reserve()/release()
│  ├─ mailer/
│  │  ├─ transporterPool.ts       # Map<senderId, Transporter>, pooled
│  │  ├─ etherealProvider.ts      # createTestAccount, preview URL
│  │  └─ sendEmail.ts
│  ├─ bootstrap/
│  │  ├─ reconcile.ts             # one-shot on worker boot: DB → Redis repair
│  │  └─ ensureIndices.ts
│  └─ admin/
│     └─ bullBoard.ts
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ load/schedule1000.ts
├─ Dockerfile
├─ tsconfig.json
└─ package.json
```

Key dependencies: `express`, `zod`, `@prisma/client`, `bullmq`, `ioredis`,
`@elastic/elasticsearch`, `nodemailer`, `google-auth-library`, `jose` (or `jsonwebtoken`),
`cookie-parser`, `helmet`, `cors`, `pino`, `papaparse`, `multer`, `@bull-board/express`,
`vitest` + `supertest` + `tsx` in dev.

---

## 3. Frontend architecture and folder structure

**Vite + React + TypeScript (not Next.js).** Trade-off: Next.js gives me an easy server-side OAuth
callback route and could hold secrets, but it also introduces a second server, SSR/hydration
concerns, and route-handler auth duplication. Since the API already owns the OAuth code exchange
and the session cookie, the frontend can be a pure SPA. Vite is faster to build and to demo.

State management:

| Option | Verdict |
|---|---|
| Redux Toolkit | overkill; there is almost no client state, it's all server state |
| plain `useEffect` + `fetch` | you re-implement caching, polling, loading/error states in every table |
| **TanStack Query (recommended)** | gives loading/empty/error states, `refetchInterval` for the live-updating Scheduled table, and cache invalidation after Compose in ~3 lines |

Live updates in the tables: **polling via TanStack Query `refetchInterval: 5000`**, not WebSockets.
Trade-off: WS/SSE would be more elegant and would let me stream BullMQ `QueueEvents`, but it adds a
transport, reconnect handling, and auth-over-WS for a table that only needs 5s freshness. Polling is
the right 48h call; I'll note the WS upgrade path in the README.

```
frontend/
├─ index.html
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx                       # router + QueryClientProvider + ToastProvider
│  ├─ router.tsx                    # /login, /auth/callback, /dashboard (protected)
│  ├─ types/
│  │  ├─ api.ts                     # EmailJob, Campaign, User, Paginated<T>, ApiError
│  │  └─ enums.ts                   # EmailStatus union + label/colour maps
│  ├─ lib/
│  │  ├─ apiClient.ts               # fetch wrapper: credentials:'include', 401→/login
│  │  ├─ queryKeys.ts               # centralised key factory (DRY invalidation)
│  │  ├─ csv.ts                     # client-side parse + email regex + dedupe + count
│  │  └─ format.ts                  # date/relative-time helpers
│  ├─ hooks/
│  │  ├─ useAuth.ts                 # GET /api/auth/me
│  │  ├─ useScheduledEmails.ts
│  │  ├─ useSentEmails.ts
│  │  ├─ useCreateCampaign.ts       # mutation + invalidate + toast
│  │  ├─ useSlackStatus.ts
│  │  └─ useDebouncedValue.ts       # for the search box
│  ├─ components/
│  │  ├─ ui/                        # design-system primitives, zero domain knowledge
│  │  │  ├─ Button.tsx  Input.tsx  Textarea.tsx  Select.tsx
│  │  │  ├─ Modal.tsx   Table.tsx  Badge.tsx     Spinner.tsx
│  │  │  ├─ EmptyState.tsx  Skeleton.tsx  Toast.tsx  Tabs.tsx
│  │  │  ├─ Pagination.tsx  FileDropzone.tsx
│  │  ├─ layout/
│  │  │  ├─ AppHeader.tsx           # avatar, name, email, logout, Connect Slack
│  │  │  └─ ProtectedRoute.tsx
│  │  └─ domain/
│  │     ├─ ComposeEmailModal.tsx   # form + CSV upload + detected-count
│  │     ├─ RecipientPreview.tsx
│  │     ├─ ScheduledEmailsTable.tsx
│  │     ├─ SentEmailsTable.tsx
│  │     ├─ EmailStatusBadge.tsx
│  │     └─ SearchBar.tsx
│  ├─ pages/
│  │  ├─ LoginPage.tsx
│  │  ├─ AuthCallbackPage.tsx
│  │  └─ DashboardPage.tsx
│  └─ styles/index.css              # tailwind + Figma tokens
├─ tailwind.config.ts               # colours/spacing/font extracted from Figma
└─ vite.config.ts                   # dev proxy /api → http://localhost:4000
```

DRY enforcement: `Table` is generic (`<T>` with a `columns` descriptor), so
`ScheduledEmailsTable` and `SentEmailsTable` are ~30 lines of column config each and share
loading-skeleton / empty-state / pagination behaviour.

---

## 4. PostgreSQL schema and relationships

```
users 1───N campaigns 1───N email_jobs N───1 senders
  │                              │
  1                              └──── (denormalised user_id for cheap list queries)
  │
  1─── slack_integrations (0..1)
  1─── N senders
users 1───N rate_limit_events
```

### Tables

**users** — `id uuid pk`, `google_sub text unique`, `email citext unique`, `name`, `avatar_url`,
`created_at`, `updated_at`.

**senders** — `id uuid pk`, `user_id fk`, `email`, `display_name`, `smtp_host`, `smtp_port`,
`smtp_user`, `smtp_pass_encrypted`, `max_emails_per_hour int null` (null = fall back to env),
`is_active bool`, `created_at`. Unique `(user_id, email)`.

**campaigns** — `id uuid pk`, `user_id fk`, `subject`, `body text`, `start_at timestamptz`,
`delay_between_ms int`, `hourly_limit int null`, `total_recipients int`, `status` enum
`draft|expanding|scheduled|running|completed|cancelled|failed`, `idempotency_key text unique null`,
`created_at`, `updated_at`.

**email_jobs** — the heart of the system.

| column | notes |
|---|---|
| `id uuid pk` | also used as the BullMQ `jobId` (`email:<id>`) |
| `campaign_id fk` | cascade delete |
| `user_id` | denormalised → list queries never join |
| `sender_id fk` | which Ethereal account sends it |
| `recipient_email citext` | |
| `recipient_name text null` | from CSV column if present |
| `sequence_index int` | 0-based position in campaign → drives pacing & FIFO order |
| `scheduled_at timestamptz` | **current** intended send time; updated on reschedule |
| `original_scheduled_at timestamptz` | never changes → lets me show "delayed by rate limit" |
| `status` enum | `scheduled → claimed → sent \| failed`, plus `rate_limited`, `cancelled` |
| `attempt_count int` | |
| `reschedule_count int` | how many hour windows it was pushed by |
| `last_error text null` | |
| `provider_message_id text null` | from SMTP response |
| `preview_url text null` | Ethereal preview link, shown in Sent table |
| `sent_at timestamptz null` | |
| `claimed_at timestamptz null` | stale-claim detection |
| `dedupe_key text` | `sha256(campaign_id + ':' + lower(recipient_email))`, **unique** |
| `created_at / updated_at` | |

Indexes on `email_jobs`:
- `unique (dedupe_key)` → the DB-level duplicate guarantee (R8)
- `(user_id, status, scheduled_at DESC)` → Scheduled tab
- `(user_id, status, sent_at DESC)` → Sent tab
- `(status, scheduled_at)` → startup reconciler scan
- `(campaign_id)`, `(sender_id, sent_at)`

**slack_integrations** — `id`, `user_id fk unique`, `slack_team_id`, `slack_team_name`,
`channel_id`, `channel_name`, `webhook_url_encrypted`, `scope`, `connected_at`,
`revoked_at null`, `last_error null`. Soft-revoke rather than delete so reconnect is auditable.

**rate_limit_events** — `id`, `user_id`, `sender_id fk`, `hour_window timestamptz`,
`limit_value int`, `jobs_deferred int`, `notified_at null`, `notify_error null`.
Unique `(sender_id, hour_window)`. Purpose: audit trail + the durable half of "notify Slack once
per sender per hour" (Redis `SETNX` is the fast path, this row is the truth).

### Status enum design note

I keep `claimed` (a.k.a. "sending") as a distinct state rather than a boolean `is_locked`. It makes
the conditional-claim UPDATE a single statement and makes crash recovery obvious: a row stuck in
`claimed` with `claimed_at < now() - 5 min` was orphaned by a hard kill and is safe to reset.
BullMQ's own stalled-job detection re-delivers such jobs; the reconciler resets the DB row so the
claim can succeed on redelivery.

---

## 5. BullMQ + Redis architecture

Four queues, all on one Redis instance under prefix `{reachinbox}`:

| Queue | Payload | Concurrency | Retries / backoff |
|---|---|---|---|
| `campaign-expand` | `{ campaignId, batchIndex }` | 2 | 5, exponential 2s |
| `email-send` | `{ emailJobId }` (id only — see below) | `WORKER_CONCURRENCY` (default 5) | 3, exponential 5s |
| `search-index` | `{ emailJobId }` or `{ bulk: string[] }` | 3 | 5, exponential 3s |
| `notifications` | `{ type:'RATE_LIMIT_HIT', userId, senderId, hourWindow, ... }` | 2 | 4, exponential 5s |

**Thin payload decision.** The `email-send` job carries only the `emailJobId`; subject, body and
recipient are read from Postgres in the worker. Alternative (fat payload) avoids a DB read per send.
I choose thin because: (a) 1000 jobs × a 5KB body would put ~5MB of duplicated HTML in Redis per
campaign, (b) the payload can never drift from the DB, (c) the worker must hit the DB anyway for the
idempotency claim. Cost: one indexed primary-key read per send — negligible.

Default job options: `removeOnComplete: { age: 86400, count: 5000 }`,
`removeOnFail: { age: 604800 }`. Keeping *some* completed jobs is deliberate — the bull-board demo
looks empty otherwise. Unbounded retention would grow Redis without limit.

Redis keys (all built by `config/constants.ts`, never inline strings):

```
rl:sender:{senderId}:{hourEpoch}     INCR counter, TTL 2h      per-sender hourly usage
rl:global:{hourEpoch}                INCR counter, TTL 2h      global hourly usage
pace:sender:{senderId}               next-allowed-send-at (ms) min delay between sends
overflow:{senderId}:{hourEpoch}      INCR rank                 FIFO order in the next window
notif:rl:{senderId}:{hourEpoch}      SETNX, TTL 2h             Slack notify de-dup
idem:api:{sha256(key)}               JSON response, TTL 24h    API idempotency replay
```

Redis config: `appendonly yes`, `appendfsync everysec`, named volume, **no** `maxmemory-policy
allkeys-lru` (evicting a BullMQ delayed-set entry would silently lose a scheduled email — this is a
real footgun and worth a README line). Workers use their own `ioredis` connection with
`maxRetriesPerRequest: null` as BullMQ requires.

---

## 6. Email scheduling flow

```
POST /api/campaigns  (multipart: csv + JSON fields)
  │
  ├─ zod validate: subject, body, startAt (>= now - 60s), delayMs, hourlyLimit
  ├─ csv.service: parse → extract emails → lowercase → dedupe → validate
  │     → reject if 0 valid; report invalid rows back to UI
  ├─ Idempotency-Key header? → if seen, replay cached response, stop
  ├─ pick sender(s): round-robin over user's active senders
  │
  ├─ Postgres transaction
  │     INSERT campaigns (status='expanding', total_recipients=N)
  │     -- rows are NOT inserted here for large N
  └─ enqueue campaign-expand { campaignId, batchIndex: 0 }
  │
  └─ 202 Accepted { campaignId, totalRecipients, estimatedCompletionAt }
```

**Why an expander job instead of inserting 1000 rows + 1000 delayed jobs inline?** Inline would
hold the HTTP request open for seconds and risk a client timeout mid-write. The expander makes the
API response O(1) and gives the fan-out retries for free. Trade-off: the Scheduled table is briefly
incomplete (~1–2s) while expansion runs, so the UI shows the campaign as "Scheduling…" using
`total_recipients` vs rows created.

`campaign-expand` handler, per batch of 500 recipients:

```
1. slice recipients[batchIndex*500 .. +500]
2. prisma.emailJob.createMany({ data: [...], skipDuplicates: true })   // dedupe_key protects
3. read back the created ids (need real ids for jobIds)
4. emailSendQueue.addBulk(rows.map(r => ({
     name: 'send',
     data: { emailJobId: r.id },
     opts: { jobId: `email:${r.id}`, delay: r.scheduledAt - Date.now() }
   })))
5. if more batches remain → enqueue campaign-expand { batchIndex+1 }
   else → campaigns.status = 'scheduled'
```

**Delay computation** for recipient at index `i`:

```
effectiveDelay   = max(campaign.delayBetweenMs, env.MIN_DELAY_BETWEEN_EMAILS_MS)
effectiveLimit   = min(campaign.hourlyLimit ?? ∞, sender.maxPerHour ?? env.MAX_PER_HOUR_PER_SENDER)
paceOffsetMs     = i * effectiveDelay
windowOffsetMs   = floor(i / effectiveLimit) * 3_600_000     // pre-spread across hours
scheduled_at     = campaign.start_at + max(paceOffsetMs, windowOffsetMs)
```

The `windowOffsetMs` term is a deliberate optimisation: with `hourlyLimit=200` and 1000 recipients,
items 200–399 are *pre-scheduled* into hour 2 rather than all piling onto hour 1 and being
individually rate-limit-deferred. This turns 800 wasted worker pickups + 800 `moveToDelayed` calls
into zero. The runtime limiter remains the **authority** (other campaigns from the same sender can
still exhaust the window); this just makes the common case cheap. This is the single most important
performance decision in the design.

---

## 7. Worker flow (`email-send`)

```
job { emailJobId }
 │
 1. LOAD  emailJob + campaign + sender (single Prisma query with includes)
 │        └─ row missing?           → return { skipped:'deleted' }        (no throw)
 │        └─ status in (sent,cancelled) → return { skipped:'already' }    ← idempotency gate #1
 │
 2. RESERVE SLOT  — one atomic Lua call (see §10)
 │        reserveSlot(senderId, hourEpoch, senderLimit, globalLimit,
 │                    minDelayMs, maxInlineWaitMs, now)
 │        ├─ ALLOW  { waitMs }              → continue (counters already INCR'd)
 │        ├─ PACE   { retryAfterMs }        → waitMs too long: no counters touched
 │        └─ DENIED { reason, retryAfterMs} → hourly limit exhausted
 │
 3. IF DENIED/PACE:
 │        rank = INCR overflow:{sender}:{nextHourEpoch}
 │        newTs = nextWindowStart + rank * effectiveDelay
 │        UPDATE email_jobs SET status='rate_limited', scheduled_at=newTs,
 │                              reschedule_count = reschedule_count+1
 │        IF reason == 'SENDER_HOURLY_LIMIT':
 │              enqueue notifications{RATE_LIMIT_HIT} — guarded by SETNX (once/hour/sender)
 │        await job.moveToDelayed(newTs, token); throw new DelayedError()
 │        ── job is NOT failed, NOT dropped, attempts NOT consumed ──
 │
 4. CLAIM (idempotency gate #2, atomic):
 │        UPDATE email_jobs SET status='claimed', claimed_at=now(),
 │                              attempt_count=attempt_count+1
 │        WHERE id=$1 AND status IN ('scheduled','rate_limited','failed')
 │        rowCount === 0 → another worker owns it → releaseSlot() → return skipped
 │
 5. PACE: if waitMs > 0 → await sleep(waitMs)     (≤ maxInlineWaitMs, holds a concurrency slot)
 │
 6. SEND via pooled nodemailer transporter for sender
 │        ├─ success → UPDATE status='sent', sent_at, provider_message_id, preview_url
 │        │            enqueue search-index { emailJobId }
 │        └─ error
 │             ├─ permanent (invalid recipient, 5xx SMTP) → status='failed', last_error
 │             │      releaseSlot()   // don't burn quota on a send that never happened
 │             │      enqueue search-index (failed rows are searchable too)
 │             │      throw new UnrecoverableError(msg)   // no retries
 │             └─ transient (ECONNRESET, 4xx, timeout) → status='scheduled', releaseSlot()
 │                    throw err  → BullMQ exponential backoff retry
 │
 7. return { emailJobId, messageId }
```

**Ordering of steps 2 and 4 matters.** Reserving the rate-limit slot *before* claiming means a
worker that loses the claim race must give the slot back (`releaseSlot`). The reverse order
(claim then reserve) would mean a rate-limited job has to be un-claimed, which fights with
BullMQ's own retry bookkeeping. Reserve-then-claim with a compensating release is the cleaner
failure mode, and over-counting the quota by a hair is harmless (we under-send, never over-send).

`DelayedError` is BullMQ's contract for "I moved this job myself, don't mark it completed or
failed." Using `moveToDelayed` instead of `queue.add(newJob)` is essential: re-adding would create
a second job for the same email and break idempotency the moment a reschedule raced a retry.

Worker also registers: `on('failed')` → structured log + DB `last_error`; `on('stalled')` → warn;
`stalledInterval: 30_000`, `maxStalledCount: 2`. Graceful shutdown: `SIGTERM` → `worker.close()`
(waits for in-flight jobs) → `prisma.$disconnect()` → close transporters, with a 25s force-exit.
This is what makes the restart demo lossless: in-flight sends finish, delayed jobs stay in Redis.

---

## 8. Idempotency strategy

Five independent layers, because each one covers a different failure:

| Layer | Mechanism | Failure it prevents |
|---|---|---|
| 1. API | `Idempotency-Key` header → `idem:api:{hash}` in Redis (24h) + `campaigns.idempotency_key` unique | user double-clicks "Schedule"; client retries a timed-out POST |
| 2. Row uniqueness | `email_jobs.dedupe_key` unique = `sha256(campaignId:email)` + `createMany({skipDuplicates:true})` | expander batch retried after a partial insert; same address twice in the CSV |
| 3. Queue-level | deterministic `jobId = "email:<uuid>"` | BullMQ rejects a duplicate add outright, so an expander retry cannot double-enqueue |
| 4. Worker claim | conditional `UPDATE … WHERE status IN ('scheduled','rate_limited','failed')`, `rowCount` checked | two workers pick up the same job (stall redelivery, manual dashboard retry, reconciler double-add) |
| 5. Terminal check | early return when `status IN ('sent','cancelled')` | a job redelivered after the send succeeded but before the ack was written |

The unavoidable gap: SMTP `250 OK` received, process killed before the `status='sent'` write. On
redelivery layer 4 lets it through and we send twice. Genuinely fixing that needs a per-message
idempotency token honoured by the provider, which SMTP/Ethereal does not offer. Mitigation I will
implement: write `status='claimed'` **before** the send (already in the flow), and have the
reconciler surface rows stuck in `claimed` as `needs_review` rather than silently retrying them
after `SEND_ASSUME_SENT_AFTER_MS`. Choosing at-most-once over at-least-once for that narrow window
is the right call for email, and I'll say so explicitly in the README — an examiner asking "what
about the crash-after-send case?" should find that the answer is already written down.

---

## 9. Concurrency strategy

- `WORKER_CONCURRENCY` (default 5) passed to `new Worker(..., { concurrency })`. Horizontal scale
  via multiple worker containers — effective parallelism is `replicas × concurrency`, and the
  Redis-side limiter is the only thing that bounds actual throughput.
- **No shared mutable state in the worker module.** Every counter is in Redis; every state
  transition is a conditional SQL UPDATE. Nothing correctness-critical lives in a JS variable.
  The only in-process state is the transporter cache, which is idempotent to rebuild.
- SMTP connection reuse: one pooled transporter per sender, `pool: true`,
  `maxConnections: min(concurrency, 5)`, `maxMessages: 100`, `rateDelta/rateLimit` left to our own
  limiter so there's a single source of truth for throttling.
- Postgres: Prisma connection pool sized `connection_limit = concurrency + 4` per process, so
  `replicas × (concurrency+4)` stays well under Postgres `max_connections`. Worth stating in the
  README because it's the classic thing that breaks when someone scales workers to 10.
- Per-sender serialisation: the `pace:sender:{id}` key means N parallel workers still emit at most
  one email per sender per `effectiveDelay`. Concurrency therefore buys throughput across
  *different* senders, and resilience (a slow SMTP handshake doesn't block the pipeline) within one.
- Long inline waits are refused: if the pacing wait exceeds `MAX_INLINE_WAIT_MS` (default 5000) the
  job goes back to delayed instead of occupying a concurrency slot while sleeping. Without this, 5
  slots × 1000 queued jobs would deadlock the worker into a sleep queue.

---

## 10. Rate limiting strategy (global + per-sender)

### Window algorithm

| Option | Accuracy | Cost | Verdict |
|---|---|---|---|
| **Fixed window** `INCR rl:{sender}:{floor(now/3600)}` | allows up to 2× the limit across a boundary | 1 key, 1 op | **recommended** — the assignment literally suggests `hour_window + sender`, and burst-at-boundary is acceptable for an outreach throttle |
| Sliding log (ZSET of send timestamps) | exact | 1000 members/sender/hour, ZREMRANGEBYSCORE per check | over-engineered here |
| Token bucket | smooth, no boundary burst | needs refill math + a second key | good, but the fixed window plus our pacing key already smooths output |
| BullMQ `limiter: { max, duration }` | queue-wide only | free | **cannot** express per-sender, and `duration: 3600000` with `max: 200` starves the queue for the rest of the hour with no visibility — used only as a coarse global ceiling |

**Recommendation:** Redis fixed-window counters in a Lua script for the hourly limits, our own
`pace:` key for the inter-send delay, and BullMQ's `limiter` set to a generous global ceiling
(`{ max: 50, duration: 1000 }`) purely as a stampede guard. Documenting *why* BullMQ's limiter
isn't the primary mechanism is itself part of what the assignment asks for.

### The atomic reservation (`reserveSlot.lua`)

One round trip decides everything, so there is no check-then-act race across workers:

```
KEYS: rl:global:{h}, rl:sender:{id}:{h}, pace:sender:{id}
ARGV: globalLimit, senderLimit, minDelayMs, maxInlineWaitMs, nowMs, windowTtl

g = tonumber(GET KEYS[1]) or 0
s = tonumber(GET KEYS[2]) or 0
if g >= globalLimit  then return {'DENIED','GLOBAL_HOURLY_LIMIT', msToNextWindow} end
if s >= senderLimit  then return {'DENIED','SENDER_HOURLY_LIMIT', msToNextWindow} end

nextAllowed = tonumber(GET KEYS[3]) or 0
waitMs      = math.max(0, nextAllowed - nowMs)
if waitMs > maxInlineWaitMs then
  return {'PACE', 'PACING', waitMs}          -- nothing mutated; job re-delays itself
end

INCR KEYS[1]; EXPIRE KEYS[1] windowTtl NX
INCR KEYS[2]; EXPIRE KEYS[2] windowTtl NX
SET  KEYS[3] (math.max(nowMs, nextAllowed) + minDelayMs) PX (minDelayMs*4 + 60000)
return {'ALLOW', waitMs}
```

`releaseSlot.lua` mirrors it (`DECR` both counters, floored at 0) and runs whenever a reserved slot
doesn't result in a send — lost claim race, transient SMTP failure, permanent bounce.

Multi-instance safety comes from Lua's single-threaded atomicity: reads and writes of all three
keys happen in one indivisible step, on the one Redis all workers share. In-memory counting is used
nowhere.

### Slack notification on limit hit

When `reserveSlot` returns `SENDER_HOURLY_LIMIT`:
`SET notif:rl:{senderId}:{hourEpoch} 1 NX EX 7200`. Only the worker that wins the `NX` enqueues the
notification — so 800 deferred jobs produce exactly **one** Slack message per sender per hour, not
800. `rate_limit_events` records the same fact durably and accumulates `jobs_deferred` so the
message can say "212 emails deferred to 15:00". Without this de-dup the feature would be a Slack
self-DDoS the first time you demo it, which is exactly the kind of thing the grader will try.

---

## 11. Rescheduling when the hourly limit is reached

Requirements: never drop, never permanently fail, move to the next available window, **preserve
order as much as possible**.

```
nextWindowStart = (floor(now / 3_600_000) + 1) * 3_600_000
rank            = INCR overflow:{senderId}:{nextWindowEpoch}      -- monotonic, atomic
newTs           = nextWindowStart + (rank - 1) * effectiveDelay
                  + jitter(0..250ms)                              -- avoids a thundering herd
UPDATE email_jobs SET status='rate_limited', scheduled_at=newTs, reschedule_count += 1
await job.moveToDelayed(newTs, token)
throw new DelayedError()
```

**Order preservation.** Because `email-send` is FIFO and workers pull in `scheduled_at` order,
denials arrive in roughly the original sequence, and `INCR` hands out ranks in exactly the order
denials occur. So the overflow tail keeps its relative order and arrives *already paced* into the
next window. Ordering is best-effort, not a guarantee — with concurrency 5, five jobs are in flight
simultaneously and can interleave. I considered using `sequence_index * effectiveDelay` instead of a
rank; rejected because a partially-sent campaign would leave gaps in the next window and, worse,
recipients from two different campaigns on the same sender would collide on the same slots. Rank
counts only the jobs that actually need rescheduling, per sender per target window, so it's
collision-free by construction.

Cascade: if the next window is *also* full (rank pushes past the limit), the job is denied again on
pickup and rolls into the following window. `reschedule_count` is surfaced in the UI and in
bull-board so the behaviour is observable; there is no cap, because dropping is forbidden. A
`reschedule_count > 24` alert is a nice-to-have if time allows.

Retries are *not* consumed by a reschedule (`moveToDelayed` + `DelayedError`, not `throw`), so a
rate-limited email never exhausts `attempts` and never lands in the failed set. That distinction is
the crux of requirement R12.

---

## 12. Elasticsearch indexing & search architecture

Index `emails` (alias `emails_v1` behind alias `emails` so a mapping change is a reindex, not an
outage).

```jsonc
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },   // single-node dev
  "mappings": { "properties": {
    "id":            { "type": "keyword" },
    "campaignId":    { "type": "keyword" },
    "userId":        { "type": "keyword" },
    "senderId":      { "type": "keyword" },
    "senderEmail":   { "type": "keyword" },
    "recipientEmail":{ "type": "keyword", "fields": { "text": { "type": "text" } } },
    "subject":       { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
    "body":          { "type": "text" },
    "status":        { "type": "keyword" },
    "scheduledAt":   { "type": "date" },
    "sentAt":        { "type": "date" },
    "rescheduleCount": { "type": "integer" },
    "createdAt":     { "type": "date" }
  }}
}
```

`recipientEmail` as `keyword` + a `text` sub-field is intentional: exact filtering by address must
be precise, but users also want to type `john` and match `john@acme.com`.

### Indexing path

| Option | Pros | Cons |
|---|---|---|
| A. Synchronous `es.index()` inside the send worker | trivial | ES hiccup fails a *successfully sent* email, or forces try/catch-and-forget which silently loses documents |
| **B. Dedicated `search-index` BullMQ queue (recommended)** | retries with backoff, ES downtime never affects sending, natural place to batch | eventual consistency (sub-second in practice) |
| C. Postgres outbox table + drainer | strongest delivery guarantee | needs a poller, which is cron-shaped — against the spirit of the constraint |

**Recommended: B.** Documents are written at two points — on `email_jobs` creation (so *scheduled*
emails are searchable, which the assignment explicitly asks for) and on terminal state
(sent/failed). Writes are `index` with `_id = email_jobs.id`, making indexing **idempotent** — a
retried index job overwrites rather than duplicating. For campaign expansion the expander enqueues
one bulk-index job per 500-row batch that uses the `_bulk` API, so 1000 emails cost 2 bulk requests
rather than 1000 round trips.

A `POST /api/admin/reindex` endpoint streams Postgres → `_bulk` to rebuild from scratch, which
doubles as the answer to "what if ES was down for an hour."

### Search API

`GET /api/search?q=&status=&senderId=&from=&to=&page=&limit=` builds:
`bool.must: multi_match(q, ['subject^3','body','recipientEmail.text^2'], fuzziness:'AUTO')`,
`bool.filter: [term userId, terms status, term senderId, range sentAt]`, sort by relevance then
`sentAt desc`. Pagination via `from/size` capped at 10 000 (deep paging via `search_after` is noted
as a future step, not built).

**Graceful degradation:** the search service pings ES at boot and on failure; if ES is unreachable,
`/api/search` transparently falls back to a Postgres `ILIKE` query on subject/recipient and returns
`{ degraded: true }` so the UI can show a subtle notice. Elasticsearch is a search accelerator here,
never a source of truth, and the app must be fully usable without it.

---

## 13. BullMQ dashboard integration

`@bull-board/express` + `@bull-board/api` with `BullMQAdapter` for all four queues, mounted at
`/admin/queues` on the **API** process (it needs Redis only, not the workers).

| Option | Verdict |
|---|---|
| **bull-board (recommended)** | official-ish, zero-config, real-time, shows delayed/waiting/active/failed counts and per-job data — exactly the "live queue visibility" asked for |
| Taskforce.sh / Bull Monitor | hosted or heavier; extra signup or GraphQL layer |
| Hand-rolled queue-stats page | more Figma-consistent, but a day of work for worse observability |

Access control: the board is a raw operational surface, so it sits behind `requireAuth` plus an
`ADMIN_EMAILS` allowlist, with HTTP Basic (`BULL_BOARD_USER/PASSWORD`) as a fallback for demoing
from Postman without a browser session. Shipping it unauthenticated would be a legitimate review
finding. The dashboard link appears in the app header for allowlisted users.

---

## 14. Google OAuth architecture

**Server-side Authorization Code flow.** The alternative — `@react-oauth/google` in the browser,
sending the `id_token` to the API — is faster to build but keeps auth state in JS-accessible
storage and gives no refresh token. Server-side keeps the client secret server-side and lets me
issue my own session cookie.

```
Frontend  "Continue with Google" → GET /api/auth/google
API       generate state (random, stored in a short-lived httpOnly cookie) + PKCE verifier
          302 → accounts.google.com/o/oauth2/v2/auth
              scope=openid email profile, access_type=offline, prompt=select_account
Google    302 → GET /api/auth/google/callback?code&state
API       verify state cookie matches (CSRF)
          exchange code → tokens (google-auth-library)
          verifyIdToken → { sub, email, email_verified, name, picture }
          upsert users by google_sub
          on first login: create/attach an Ethereal sender for the user
          sign session JWT { sub: userId, v: tokenVersion }, 7d
          Set-Cookie: sid=<jwt>; HttpOnly; SameSite=Lax; Secure(prod); Path=/
          302 → FRONTEND_URL/dashboard
Frontend  GET /api/auth/me → { id, name, email, avatarUrl } → header renders
          POST /api/auth/logout → clears cookie
```

Session mechanism: **stateless JWT in an httpOnly cookie**, over Redis-backed server sessions.
Trade-off: JWTs can't be revoked instantly; I mitigate with a 7-day TTL and a `tokenVersion` column
that invalidates all sessions when bumped. Redis sessions would give instant revocation but add a
lookup per request and another failure mode, for a feature this app doesn't need.

Cookie/CORS: in dev, Vite proxies `/api` → `localhost:4000` so the cookie is same-origin and
`SameSite=Lax` just works — no `SameSite=None`, no third-party-cookie problems. In prod, both sit
behind one origin. CORS is configured with an explicit origin allowlist and `credentials: true`
(never `origin: '*'`, which is incompatible with credentialed requests anyway).

Google Cloud Console setup (README): OAuth consent screen in Testing mode, test users added,
authorised redirect URI `http://localhost:4000/api/auth/google/callback`.

---

## 15. Slack OAuth architecture

Scope choice:

| Option | What you get | Verdict |
|---|---|---|
| **`incoming-webhook` (recommended)** | user picks a channel during install; you get one POST-able URL; no channel-resolution code | simplest path to a *live, verifiable* message |
| `chat:write` bot token | can post anywhere, update messages, threads | needs channel lookup + bot invited to channel — more moving parts, more demo failure modes |

**Decided: `incoming-webhook` only.** `chat:write` is out of scope — it would need channel lookup
and the bot invited to the channel, which is more to go wrong on camera for no extra credit.

```
Dashboard "Connect Slack" → GET /api/slack/install  (authenticated)
API   state = signed JWT { userId, nonce }, 10 min, also set as a cookie
      302 → slack.com/oauth/v2/authorize?client_id&scope=incoming-webhook&state&redirect_uri
Slack user picks workspace + channel → 302 → GET /api/slack/callback?code&state
API   verify state, POST oauth.v2.access { code, client_id, client_secret, redirect_uri }
      → { team:{id,name}, incoming_webhook:{ url, channel, channel_id } }
      upsert slack_integrations (webhook_url AES-256-GCM encrypted, revoked_at = null)
      302 → FRONTEND_URL/dashboard?slack=connected
```

Header shows Connected / Disconnected via `GET /api/slack/status`; `POST /api/slack/disconnect`
sets `revoked_at`.

Notification delivery (`notifications` worker):

```
1. load slack_integrations for userId
2. none, or revoked_at != null → return { skipped:'not_connected' }   ← "no crash if not connected"
3. decrypt webhook, POST Block Kit message:
      "⚠️ Hourly limit reached — sender <email> hit 200/hour.
       212 emails deferred to 15:00 IST." + campaign link
4. HTTP 200            → rate_limit_events.notified_at = now()
   404 / 410 / "no_service" → integration revoked at Slack's end:
                            set revoked_at, last_error; do NOT retry (UnrecoverableError)
   429                 → honour Retry-After via a delayed retry
   5xx / network       → throw → exponential backoff, 4 attempts
```

Disconnect/reconnect works with no redeploy because the token is read from the DB **at send time**,
never cached in process memory. That's precisely the behaviour the assignment calls out.

---

## 16. Ethereal SMTP integration

Multiple senders is a hard requirement, so I need multiple Ethereal accounts.

| Option | Verdict |
|---|---|
| Single account in env | breaks "multiple senders" |
| `createTestAccount()` on demand, in-memory | accounts lost on restart → the restart demo shows failures |
| **Seed script creates N accounts → `senders` rows with encrypted passwords (recommended)** | survives restart, real multi-sender behaviour, reproducible |

`npm run seed:senders -- --count=3` calls `nodemailer.createTestAccount()` N times and inserts
`senders` rows (`smtp.ethereal.email:587`, password encrypted with `ENCRYPTION_KEY`). Env fallback
`ETHEREAL_ACCOUNTS` (JSON array) lets a reviewer skip the network call. Each new Google user gets
their senders on first login; if account creation fails (Ethereal rate-limits), the seeded pool is
shared and the failure surfaces as a clear API error rather than a crash.

Sending:

```ts
transporterPool.get(senderId)   // cached; pool:true, maxConnections, maxMessages:100
sendMail({ from, to, subject, text, html })
→ { messageId, response }
previewUrl = nodemailer.getTestMessageUrl(info)   // persisted → clickable in the Sent table
```

Sender selection per campaign: round-robin across the user's active senders, skipping senders whose
current-hour counter is already exhausted (a `GET` on `rl:sender:*` at expansion time). This makes
the multi-sender support *functional* rather than decorative, and it's what lets 1000 emails with a
200/hour/sender limit and 3 senders finish in 2 hours instead of 5.

Transporters are verified once at worker boot (`transporter.verify()`) and rebuilt on
`ECONNECTION`/auth errors. `TransporterPool.closeAll()` runs on shutdown.

---

## 17. API endpoints

Envelope: `{ data, meta? }` on success, `{ error: { code, message, details? } }` on failure.
All `/api/*` except auth entry points and health require the session cookie.

### Auth
| Method | Path | Responsibility |
|---|---|---|
| GET | `/api/auth/google` | set state+PKCE cookies, 302 to Google |
| GET | `/api/auth/google/callback` | verify state, exchange code, upsert user, set `sid`, 302 to dashboard |
| GET | `/api/auth/me` | `{ id, name, email, avatarUrl, createdAt }`; 401 if no/invalid cookie |
| POST | `/api/auth/logout` | clear cookie, 204 |

### Campaigns
| Method | Path | Responsibility |
|---|---|---|
| POST | `/api/campaigns` | `multipart/form-data`: `file` (CSV) + `subject, body, startAt, delayBetweenMs, hourlyLimit, senderIds[]?`. Honours `Idempotency-Key`. Validates, creates campaign, enqueues expander. → `202 { campaignId, totalRecipients, validCount, invalidRows[], estimatedCompletionAt }` |
| POST | `/api/campaigns/preview-csv` | parse only, no writes → `{ totalRows, validEmails, duplicates, invalidRows[] }` (lets the modal show the detected count before scheduling) |
| GET | `/api/campaigns` | paginated list + per-campaign counts by status |
| GET | `/api/campaigns/:id` | campaign + progress `{ scheduled, sent, failed, rateLimited }` |
| POST | `/api/campaigns/:id/cancel` | mark campaign cancelled; bulk-update pending rows to `cancelled`; remove their delayed jobs from BullMQ by `jobId` |

### Emails
| Method | Path | Responsibility |
|---|---|---|
| GET | `/api/emails/scheduled` | `?page&limit&sort&senderId&campaignId` — status in (`scheduled`,`rate_limited`,`claimed`), ordered by `scheduled_at` asc → `{ data:[{ id, recipientEmail, subject, scheduledAt, status, rescheduleCount }], meta:{ page, limit, total } }` |
| GET | `/api/emails/sent` | status in (`sent`,`failed`), ordered by `sent_at` desc → adds `sentAt`, `previewUrl`, `lastError` |
| GET | `/api/emails/:id` | full detail incl. body, attempts, error |
| POST | `/api/emails/:id/cancel` | cancel a single pending email + drop its delayed job |
| POST | `/api/emails/:id/retry` | requeue a `failed` email (new delayed job, same row, same `jobId` after removing the old one) |
| GET | `/api/emails/stats` | header/dashboard counters: totals by status, sent-this-hour per sender vs limit |

### Search / Senders / Slack / Ops
| Method | Path | Responsibility |
|---|---|---|
| GET | `/api/search` | ES-backed search (§12); `{ data, meta:{ total, took, degraded } }` |
| GET | `/api/senders` | user's senders + current-hour usage and effective limit |
| POST | `/api/senders` | add a sender (auto-provision Ethereal or supply SMTP creds) |
| GET | `/api/slack/install` | 302 to Slack authorize |
| GET | `/api/slack/callback` | exchange code, store webhook, 302 to dashboard |
| GET | `/api/slack/status` | `{ connected, teamName, channelName, connectedAt }` |
| POST | `/api/slack/disconnect` | soft-revoke |
| POST | `/api/slack/test` | send a test message — makes the demo verifiable without waiting for a real limit hit |
| GET | `/api/queues/stats` | JSON counts per queue (for a small in-app widget) |
| POST | `/api/admin/reindex` | rebuild ES from Postgres (admin only) |
| POST | `/api/admin/reconcile` | re-run the DB→Redis reconciler manually (admin only) |
| GET | `/healthz` `/readyz` | liveness / dependency readiness |
| GET/… | `/admin/queues` | bull-board UI |

---

## 18. Docker services

```yaml
services:
  postgres:       postgres:16-alpine       5432   volume pgdata        healthcheck pg_isready
  redis:          redis:7-alpine           6379   volume redisdata
                  command: redis-server --appendonly yes --appendfsync everysec
  elasticsearch:  elasticsearch:8.13.0     9200   volume esdata
                  discovery.type=single-node, xpack.security.enabled=false, ES_JAVA_OPTS=-Xms512m -Xmx512m
  api:            build ./backend  cmd: node dist/server.js   4000   depends_on healthy pg+redis
  worker:         build ./backend  cmd: node dist/worker.js          depends_on healthy pg+redis
  web:            build ./frontend (nginx serving the static build)  5173/80
```

Notes and trade-offs:
- ES with security disabled and a 512MB heap — dev-only, called out in the README. It's also the
  service most likely to OOM on a reviewer's laptop, so `docker-compose.yml` keeps ES optional via
  a `search` profile and the app degrades to Postgres search if it's absent.
- `api` and `worker` share one image, differing only in command → one build, and `--scale worker=3`
  demonstrates multi-instance rate limiting.
- Migrations run as an explicit `prisma migrate deploy` in the api container's entrypoint, not as a
  separate init container (fewer moving parts; documented as a shortcut).
- No Kibana. Nice for debugging, another 1GB of RAM, zero grading value.

---

## 19. Environment variables

```bash
# ── Core
NODE_ENV=development
PORT=4000
FRONTEND_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:4000
LOG_LEVEL=info

# ── Data stores
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reachinbox?connection_limit=10
REDIS_URL=redis://localhost:6379
REDIS_PREFIX=reachinbox
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=emails
SEARCH_ENABLED=true

# ── Security
SESSION_JWT_SECRET=<32+ random bytes>
ENCRYPTION_KEY=<32-byte hex, AES-256-GCM for SMTP passwords + Slack webhooks>
SESSION_TTL_DAYS=7

# ── Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/google/callback

# ── Slack OAuth
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=http://localhost:4000/api/slack/callback
SLACK_SCOPES=incoming-webhook

# ── Ethereal / SMTP
ETHEREAL_HOST=smtp.ethereal.email
ETHEREAL_PORT=587
ETHEREAL_ACCOUNTS=[]        # optional pre-created accounts, else seed script creates them
SEED_SENDER_COUNT=3

# ── Scheduler / throughput  (all limits configurable, nothing hardcoded)
WORKER_CONCURRENCY=5
MIN_DELAY_BETWEEN_EMAILS_MS=2000       # documented floor: min 2s between sends
MAX_EMAILS_PER_HOUR=1000               # global ceiling
MAX_EMAILS_PER_HOUR_PER_SENDER=200     # per-sender default
MAX_INLINE_WAIT_MS=5000                # above this, re-delay instead of sleeping in a slot
RATE_LIMIT_WINDOW_MS=3600000
EMAIL_JOB_ATTEMPTS=3
EMAIL_JOB_BACKOFF_MS=5000
EXPAND_BATCH_SIZE=500
STALE_CLAIM_TIMEOUT_MS=300000
RECONCILE_ON_BOOT=true

# ── Admin
ADMIN_EMAILS=you@example.com
BULL_BOARD_USER=admin
BULL_BOARD_PASSWORD=<random>

# ── Frontend (frontend/.env)
VITE_API_URL=http://localhost:4000
```

`config/env.ts` parses this with zod and **exits non-zero on a missing/invalid var**. Failing at
boot rather than at the first send is the difference between a config typo being a 10-second
discovery and a 40-minute one.

---

## 20. Testing strategy

Runner: **Vitest** (native TS/ESM, fast) + `supertest`. Real Redis/Postgres for integration tests
via the compose stack; no `ioredis-mock`, because the entire correctness argument rests on Lua
atomicity and a mock would test nothing that matters.

**Unit (fast, no I/O)**
- `computeSchedule(startAt, index, delay, hourlyLimit)` — pacing and window-offset maths, including
  the `delay < MIN_DELAY` clamp and the boundary at `index == hourlyLimit`.
- `csv.service` — headerless single-column, headered multi-column, CRLF, quoted fields, mixed case,
  duplicates, invalid addresses, empty file, 10k rows.
- `rescheduleToNextWindow` — correct next-window boundary across an hour edge and a DST-irrelevant
  UTC boundary; rank→timestamp mapping.
- Slack message formatting; error classification (permanent vs transient SMTP).

**Integration (real Redis + Postgres, SMTP faked)**
- **Rate limiter under parallelism:** fire 500 concurrent `reserveSlot` calls with limit 200 →
  exactly 200 `ALLOW`. This is the single highest-value test in the suite.
- `releaseSlot` never drives a counter below zero.
- Full schedule → expand → send happy path with a stub transporter; assert one `sent` row, one ES
  document, one preview URL.
- **Duplicate prevention:** run the same `email-send` job twice concurrently → transporter called
  exactly once, row `sent` once.
- Limit-exhaustion path: schedule 250 with limit 200 → 200 sent, 50 `rate_limited` with
  `scheduled_at` in the next window and preserved relative order; exactly **one** notification job.
- Slack notify with no integration → `skipped`, no throw.
- API contract tests for every endpoint: 401 unauthenticated, 400 on bad payloads, pagination
  shape, `Idempotency-Key` replay.

**End-to-end / manual (scripted, recorded for the demo video)**
- **Restart test:** schedule 20 emails 3 minutes out → `docker compose stop worker` → wait past
  some send times → `start worker` → all 20 send exactly once, none lost, none duplicated.
  Automated as `tests/e2e/restart.spec.ts` if time permits, otherwise a documented script.
- **Redis-loss test:** flush Redis while jobs are pending → restart worker → reconciler re-creates
  the delayed jobs from Postgres.
- **Load test:** `tests/load/schedule1000.ts` schedules 1000 recipients and asserts API latency,
  expansion time, and that sends are paced at ≥2s with the hourly cap respected.

**Frontend:** React Testing Library on the pieces with real logic — `ComposeEmailModal` validation
and CSV count, `Table` loading/empty/error states, `ProtectedRoute` redirect. No E2E browser suite;
not worth the 48-hour budget, and I'd rather spend it on the load test.

Coverage target ~70% on `src/services`, `src/workers`, `src/ratelimit`; I'm explicitly not chasing a
global number.

---

## 21. Restart & persistence behaviour

Two durable stores, with a clear hierarchy: **Postgres is the source of truth for intent; Redis is
the source of truth for scheduling.** Recovery is about reconciling the second from the first.

**Normal restart (Redis intact).** BullMQ keeps delayed jobs in a Redis sorted set keyed by
timestamp. On boot the worker reconnects and BullMQ's delayed-set promoter picks up everything whose
time has come — including jobs whose time passed *while the process was down*, which fire
immediately on start. Nothing is re-scheduled from scratch and nothing is lost. Redis persistence
is AOF `everysec` on a named volume, so a container restart loses at most one second of writes.

**Graceful shutdown** makes this clean: `SIGTERM` → stop accepting new jobs → `worker.close()`
waits for in-flight sends → flush DB writes → disconnect. Without it, an in-flight send is killed
mid-SMTP and comes back as a stalled job, which is recoverable but noisier.

**Crash / SIGKILL.** In-flight jobs are not acked; BullMQ's stalled-job checker (`stalledInterval
30s`, `maxStalledCount 2`) returns them to `waiting` and they are redelivered. The five idempotency
layers ensure redelivery does not double-send. Rows left in `claimed` past
`STALE_CLAIM_TIMEOUT_MS` are reset to `scheduled` by the reconciler so the claim can succeed again.

**Redis data loss** (flush, volume wipe, eviction) is the failure BullMQ alone cannot survive, and
it's where most submissions will quietly break. The **startup reconciler** (`bootstrap/reconcile.ts`,
one shot, `RECONCILE_ON_BOOT=true`) handles it:

```
1. SELECT id, scheduled_at FROM email_jobs
   WHERE status IN ('scheduled','rate_limited') AND campaign not cancelled
2. for each batch of 500:
     existing = await emailSendQueue.getJob(`email:${id}`)   (pipelined)
     if missing → addBulk with jobId `email:${id}` and
                  delay = max(0, scheduled_at - now)
3. reset rows stuck in 'claimed' older than STALE_CLAIM_TIMEOUT_MS → 'scheduled'
4. log { checked, restored, staleReset } and expose it on /readyz
```

Deterministic `jobId`s are what make this safe to run repeatedly — a job that still exists is never
duplicated. Overdue jobs get `delay: 0` and send immediately, which is the correct behaviour for a
scheduler that was offline (an email due 10 minutes ago should go out now, not be skipped).

**Why not a periodic reconciler?** A recurring sweep would catch mid-run Redis loss too, but any
implementation of "run this every 5 minutes" is a cron by another name, and the assignment bans
them. So: reconcile on boot, plus `POST /api/admin/reconcile` for manual invocation, plus a
README note that in production this belongs in a supervised job runner. Being explicit about the
constraint beats sneaking a `setInterval` in.

---

## 22. Behaviour with 1000+ emails scheduled at once

Scenario: one campaign, 1000 recipients, `startAt = now`, `MIN_DELAY = 2s`,
`MAX_EMAILS_PER_HOUR_PER_SENDER = 200`, 3 senders, `WORKER_CONCURRENCY = 5`.

**Ingest (t+0 to t+2s).** The API does not touch the 1000 recipients beyond parsing and validating
them; it writes one `campaigns` row and one expander job, and responds in well under a second.
The expander then runs 2 batches of 500: `createMany` (one INSERT per batch) + `addBulk` (one
pipelined Redis write per batch). Total: ~4 DB statements and ~4 Redis round trips, not 2000.

**Redis footprint.** 1000 delayed jobs at ~400 bytes each (thin payloads) ≈ 400KB. The delayed
ZSET handles this trivially; BullMQ promotes due jobs in batches. This is precisely why the thin
payload decision in §5 matters — fat payloads with a 5KB HTML body would be ~5MB per campaign.

**Steady state.** Recipients are spread by `computeSchedule` at enqueue time: with 3 senders
round-robin, each sender gets ~333 emails and its first 200 land in hour 1, the rest pre-scheduled
into hour 2. Within a sender, sends are paced ≥2s apart by the `pace:` key. So ~600 emails go out
in hour 1 (3 senders × 200) and the remaining ~400 in hour 2. Wall-clock completion ≈ 2 hours,
which is the *correct* answer for the configured limits — a system that finished in 5 minutes would
be ignoring its own rate limits.

**Worker behaviour.** 5 concurrent slots pull the earliest-due jobs. Because pre-spreading already
matched the schedule to the limits, most pickups reserve a slot and send; only cross-campaign
contention produces denials. Denied jobs cost one Lua call plus one `moveToDelayed` — no send, no
retry consumed, no failure. If a burst *does* get denied en masse, the `MAX_INLINE_WAIT_MS` guard
keeps the 5 slots churning instead of sleeping, so throughput never collapses.

**Slack.** Exactly one message per (sender, hour window) thanks to the `SETNX` guard — 3 messages
in this scenario, not 400.

**Elasticsearch.** 1000 documents arrive as 2 bulk requests at creation, then one small index call
per terminal state (naturally spread over 2 hours by the pacing). No indexing spike.

**Frontend.** The Scheduled tab is server-paginated at 25 rows; the UI never holds 1000 records.
Counts come from a `groupBy` aggregate, not from a client-side length. Polling every 5s is 1 cheap
indexed query.

**Known limits and what I'd do beyond this scale.** At ~100k delayed jobs, pre-enqueueing everything
starts to strain the delayed set and I'd switch to a windowed pull model (keep the schedule in
Postgres, enqueue only the next N minutes with a self-chaining lookahead job). At that point ES
indexing wants a dedicated bulk buffer with a size/time flush. Both are noted in the README as
scaling notes, not built — the design as specified holds comfortably to tens of thousands.

---

## 23. Prioritised 48-hour implementation plan

Ordering principle: **every hard requirement gets a working vertical slice before anything gets
polished.** A submission with a rough Compose modal and a bulletproof rate limiter scores far
better than a pixel-perfect UI with a broken scheduler, because §2 of the assignment ("Throughput,
Rate Limiting & Concurrency") is where the differentiation is.

### Phase 0 — Foundation (hours 0–4) · must
- Repo, `backend/` + `frontend/`, tsconfigs, `docker-compose.yml` (pg + redis + es), `.env.example`.
- `config/env.ts` zod validation, pino logger, error envelope, `/healthz` `/readyz`.
- Prisma schema (§4) + first migration + `prisma studio` sanity check.
- **Exit:** `docker compose up` gives healthy stores; `GET /healthz` returns 200.

### Phase 1 — Scheduling core (hours 4–12) · must, highest risk
- Queues + typed `add` helpers; worker entrypoint with graceful shutdown.
- `POST /api/campaigns` (CSV parse, validate, insert, enqueue expander) + `campaign-expand`.
- `email-send` worker: load → claim → send via Ethereal → mark sent + preview URL.
- Seed script for 3 Ethereal senders; transporter pool.
- `GET /api/emails/scheduled|sent`.
- **Exit:** schedule 5 emails via Postman → they arrive in Ethereal at the right times, exactly once.

### Phase 2 — Rate limiting, concurrency, persistence (hours 12–20) · must, the graded core
- `reserveSlot.lua` / `releaseSlot.lua` + `rateLimiter.ts`; wire into the worker.
- Pacing key, `MAX_INLINE_WAIT_MS` guard, `WORKER_CONCURRENCY`.
- Reschedule-to-next-window with overflow rank + `moveToDelayed`/`DelayedError`.
- Startup reconciler + `/api/admin/reconcile`.
- bull-board at `/admin/queues` (auth-gated).
- The parallel-reservation integration test and the restart test.
- **Exit:** `--scale worker=3`, 250 emails with limit 200 → 200 send, 50 defer in order; kill and
  restart the worker mid-run → no loss, no duplicates.

### Phase 3 — Elasticsearch (hours 20–24) · must
- `ensureIndices` + mapping (§12), `search-index` worker (single doc + `_bulk` from the expander),
  `GET /api/search` with filters and pagination, Postgres `ILIKE` fallback, `/api/admin/reindex`.
- Sequenced here, immediately after the send pipeline it depends on and before auth/UI, because it
  is an enumerated hard requirement and a reviewer can check for it in one request. The Postgres
  fallback stays in the design as a runtime safety valve (ES down on the grader's machine), **not**
  as a schedule contingency.
- **Exit:** schedule and send a handful of emails → both scheduled and sent rows are returnable
  from `/api/search` by subject and recipient; killing the ES container degrades search instead of
  breaking sends.

### Phase 4 — Auth + Slack (hours 24–31) · must (both explicitly required)
- Google OAuth server-side flow, session cookie, `/api/auth/me`, logout, `requireAuth` on all routes.
- Slack OAuth install/callback, encrypted webhook storage, status/disconnect.
- `notifications` worker + `SETNX` de-dup + `rate_limit_events` + `/api/slack/test`.
- **Exit:** real Google login lands on the dashboard; forcing a limit hit posts one live Slack message.

### Phase 5 — Frontend (hours 31–42) · must
- Vite + Tailwind with tokens read off the Figma; `apiClient`, TanStack Query, router, `ProtectedRoute`.
- `ui/` primitives → `AppHeader` (name/email/avatar/logout/Connect Slack) → generic `Table`.
- Scheduled + Sent tables with loading skeletons, empty states, pagination, status badges,
  Ethereal preview links.
- `ComposeEmailModal`: subject, body, CSV dropzone with detected-count, start time, delay,
  hourly limit, submit + toasts.
- `SearchBar` wired to the Phase 3 search endpoint on both tabs.
- **Exit:** the whole flow is drivable from the browser with no Postman.

### Phase 6 — Docs, demo, hardening (hours 42–48) · must
- README: run instructions (backend, worker, frontend, Ethereal setup, env), architecture overview,
  how scheduling works, restart persistence, rate limiting + concurrency with the **chosen 2s delay
  documented**, feature checklist mapped to the assignment's bullets, assumptions and trade-offs
  (including the crash-after-SMTP-ack window from §8 and the no-periodic-reconciler note from §21).
- Load script run + numbers recorded.
- Demo video ≤5 min: schedule → dashboard tables → **restart scenario** → rate limit + Slack message.
- Private repo, access to `Mitrajit` and `Yadav036`, submission form.

### Cut list, in the order I'd sacrifice
1. Frontend unit tests → 2. `/api/emails/:id/retry` → 3. per-campaign progress bars →
4. `search_after` deep pagination → 5. fuzzy/relevance tuning on the ES query (keep exact + prefix
matching) → 6. Figma pixel-perfection (keep layout and hierarchy faithful, accept small spacing
drift).

**Never cut:** no-cron compliance, restart persistence, idempotency, Redis-backed rate limiting,
real Google OAuth, real Slack OAuth with a live message, the BullMQ dashboard, ES indexing.
Those are the enumerated hard requirements, and each one is individually checkable by a reviewer.

### Biggest risks and pre-planned mitigations
| Risk | Mitigation |
|---|---|
| Elasticsearch eats the laptop or a reviewer can't run it | `SEARCH_ENABLED=false` + Postgres fallback, ES behind a compose profile — a runtime safety valve, since ES is now built in Phase 3 rather than deferred |
| Frontend squeezed to 11 hours by the earlier ES phase | `ui/` primitives + one generic `Table` first, so the two tables are column config only; styling passes time-boxed |
| Google/Slack OAuth console setup rabbit hole | do the console setup in Phase 0 downtime, before writing the code |
| `moveToDelayed` token/`DelayedError` semantics differ by BullMQ version | pin BullMQ, verify this behaviour in a 20-line spike at the start of Phase 2 — it's the one API whose contract the whole reschedule design depends on |
| Ethereal throttling account creation | seed once, store in DB, `ETHEREAL_ACCOUNTS` env escape hatch |
