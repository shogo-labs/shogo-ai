-- Migration: AbuseFlag + User.bannedAt (SHO-459)
--
-- Daily abuse check that bans free accounts attempting to exploit third-party
-- systems. `users.bannedAt` is the enforcement column; `abuse_flags` holds
-- the judge verdicts. The ban gate is enforced by signup-trust, authMiddleware
-- and the session.create hook — no data to backfill (all null = not banned).

-- AlterTable users: add ban columns
ALTER TABLE "users" ADD COLUMN "bannedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "banReason" TEXT;
ALTER TABLE "users" ADD COLUMN "bannedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "users_bannedAt_idx" ON "users"("bannedAt");

-- CreateTable abuse_flags
CREATE TABLE "abuse_flags" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "clusterKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'flagged',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "digestId" TEXT,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abuse_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abuse_flags_userId_runDate_category_key" ON "abuse_flags"("userId", "runDate", "category");
CREATE INDEX "abuse_flags_status_createdAt_idx" ON "abuse_flags"("status", "createdAt");
CREATE INDEX "abuse_flags_clusterKey_idx" ON "abuse_flags"("clusterKey");

-- AddForeignKey
ALTER TABLE "abuse_flags" ADD CONSTRAINT "abuse_flags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "abuse_flags" ADD CONSTRAINT "abuse_flags_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
