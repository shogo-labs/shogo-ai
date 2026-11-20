-- Migration: AbuseFlag + User.bannedAt (SHO-459) — SQLite track

-- AlterTable
ALTER TABLE "users" ADD COLUMN "bannedAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "banReason" TEXT;
ALTER TABLE "users" ADD COLUMN "bannedByUserId" TEXT;

-- CreateTable
CREATE TABLE "abuse_flags" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "decidedAt" DATETIME,
    "digestId" TEXT,
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "abuse_flags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "abuse_flags_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "abuse_flags_userId_runDate_category_key" ON "abuse_flags"("userId", "runDate", "category");
CREATE INDEX "abuse_flags_status_createdAt_idx" ON "abuse_flags"("status", "createdAt");
CREATE INDEX "abuse_flags_clusterKey_idx" ON "abuse_flags"("clusterKey");
