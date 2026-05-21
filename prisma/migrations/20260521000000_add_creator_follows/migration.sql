-- AlterTable
ALTER TABLE "creator_profiles" ADD COLUMN "followerCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "creator_follows" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_follows_followerId_idx" ON "creator_follows"("followerId");

-- CreateIndex
CREATE INDEX "creator_follows_creatorId_idx" ON "creator_follows"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "creator_follows_followerId_creatorId_key" ON "creator_follows"("followerId", "creatorId");

-- AddForeignKey
ALTER TABLE "creator_follows" ADD CONSTRAINT "creator_follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_follows" ADD CONSTRAINT "creator_follows_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
