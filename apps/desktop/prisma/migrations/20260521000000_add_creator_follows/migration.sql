-- SQLite mirror of prisma/migrations/20260521000000_add_creator_follows

PRAGMA foreign_keys = OFF;

-- Add followerCount to creator_profiles
ALTER TABLE "creator_profiles" ADD COLUMN "followerCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "creator_follows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "followerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creator_follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "creator_follows_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "creator_follows_followerId_idx" ON "creator_follows"("followerId");
CREATE INDEX "creator_follows_creatorId_idx" ON "creator_follows"("creatorId");
CREATE UNIQUE INDEX "creator_follows_followerId_creatorId_key" ON "creator_follows"("followerId", "creatorId");

PRAGMA foreign_keys = ON;
