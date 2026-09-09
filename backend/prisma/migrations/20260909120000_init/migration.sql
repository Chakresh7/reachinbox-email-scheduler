-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
--
-- Added by hand. `prisma migrate diff` emits CITEXT columns but never creates
-- the extension, so this migration would fail on a fresh database with
-- `type "citext" does not exist`.
--
-- citext is used for every email column so that Alice@Example.com and
-- alice@example.com collide at the database level. That reinforces
-- idempotency: the unique index on email_jobs.dedupe_key cannot be sidestepped
-- by a CSV that varies only in capitalisation.
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'expanding', 'scheduled', 'running', 'completed', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "EmailJobStatus" AS ENUM ('scheduled', 'rate_limited', 'claimed', 'sent', 'failed', 'cancelled', 'needs_review');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "google_sub" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "senders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "smtp_host" TEXT NOT NULL,
    "smtp_port" INTEGER NOT NULL,
    "smtp_user" TEXT NOT NULL,
    "smtp_pass_encrypted" TEXT NOT NULL,
    "max_emails_per_hour" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "senders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "delay_between_ms" INTEGER NOT NULL,
    "hourly_limit" INTEGER,
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_jobs" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "recipient_email" CITEXT NOT NULL,
    "recipient_name" TEXT,
    "sequence_index" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "original_scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "EmailJobStatus" NOT NULL DEFAULT 'scheduled',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "preview_url" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "claimed_at" TIMESTAMPTZ(3),
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_integrations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slack_team_id" TEXT NOT NULL,
    "slack_team_name" TEXT NOT NULL,
    "channel_id" TEXT,
    "channel_name" TEXT,
    "webhook_url_encrypted" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "last_notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "slack_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "hour_window" TIMESTAMPTZ(3) NOT NULL,
    "limit_value" INTEGER NOT NULL,
    "jobs_deferred" INTEGER NOT NULL DEFAULT 0,
    "notified_at" TIMESTAMPTZ(3),
    "notify_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "senders_user_id_is_active_idx" ON "senders"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "senders_user_id_email_key" ON "senders"("user_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_idempotency_key_key" ON "campaigns"("idempotency_key");

-- CreateIndex
CREATE INDEX "campaigns_user_id_created_at_idx" ON "campaigns"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE UNIQUE INDEX "email_jobs_dedupe_key_key" ON "email_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "email_jobs_user_id_status_scheduled_at_idx" ON "email_jobs"("user_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "email_jobs_user_id_status_sent_at_idx" ON "email_jobs"("user_id", "status", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "email_jobs_status_scheduled_at_idx" ON "email_jobs"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "email_jobs_campaign_id_sequence_index_idx" ON "email_jobs"("campaign_id", "sequence_index");

-- CreateIndex
CREATE INDEX "email_jobs_sender_id_sent_at_idx" ON "email_jobs"("sender_id", "sent_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "slack_integrations_user_id_key" ON "slack_integrations"("user_id");

-- CreateIndex
CREATE INDEX "rate_limit_events_user_id_created_at_idx" ON "rate_limit_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_events_sender_id_hour_window_key" ON "rate_limit_events"("sender_id", "hour_window");

-- AddForeignKey
ALTER TABLE "senders" ADD CONSTRAINT "senders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "senders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_limit_events" ADD CONSTRAINT "rate_limit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
