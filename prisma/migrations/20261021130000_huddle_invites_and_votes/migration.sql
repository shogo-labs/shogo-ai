-- Migration: huddle_invites_and_votes
-- Huddle invites, knock-to-join requests, the shareable link token, and poll/question votes.

-- AlterTable
ALTER TABLE "huddles" ADD COLUMN     "linkToken" TEXT;

-- CreateTable
CREATE TABLE "huddle_invites" (
    "id" TEXT NOT NULL,
    "huddleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ringing',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "huddle_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "huddle_join_requests" (
    "id" TEXT NOT NULL,
    "huddleId" TEXT NOT NULL,
    "userId" TEXT,
    "guestId" TEXT,
    "guestName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "huddle_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_votes" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "huddle_invites_userId_status_idx" ON "huddle_invites"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "huddle_invites_huddleId_userId_key" ON "huddle_invites"("huddleId", "userId");

-- CreateIndex
CREATE INDEX "huddle_join_requests_huddleId_status_idx" ON "huddle_join_requests"("huddleId", "status");

-- CreateIndex
CREATE INDEX "huddle_join_requests_guestId_idx" ON "huddle_join_requests"("guestId");

-- CreateIndex
CREATE INDEX "conversation_votes_messageId_idx" ON "conversation_votes"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_votes_messageId_userId_optionId_key" ON "conversation_votes"("messageId", "userId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "huddles_linkToken_key" ON "huddles"("linkToken");

-- AddForeignKey
ALTER TABLE "huddle_invites" ADD CONSTRAINT "huddle_invites_huddleId_fkey" FOREIGN KEY ("huddleId") REFERENCES "huddles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "huddle_join_requests" ADD CONSTRAINT "huddle_join_requests_huddleId_fkey" FOREIGN KEY ("huddleId") REFERENCES "huddles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_votes" ADD CONSTRAINT "conversation_votes_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

