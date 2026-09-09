-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "recipients" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "campaigns" ADD COLUMN "expanded_count" INTEGER NOT NULL DEFAULT 0;
