-- CreateTable
CREATE TABLE "huddles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "activeKey" TEXT,
    "roomName" TEXT NOT NULL,
    "startedById" TEXT NOT NULL,
    "messageId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "huddles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "huddle_participants" (
    "id" TEXT NOT NULL,
    "huddleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "huddle_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "huddles_activeKey_key" ON "huddles"("activeKey");

-- CreateIndex
CREATE UNIQUE INDEX "huddles_roomName_key" ON "huddles"("roomName");

-- CreateIndex
CREATE INDEX "huddles_workspaceId_endedAt_idx" ON "huddles"("workspaceId", "endedAt");

-- CreateIndex
CREATE INDEX "huddles_conversationId_startedAt_idx" ON "huddles"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "huddle_participants_huddleId_leftAt_idx" ON "huddle_participants"("huddleId", "leftAt");

-- CreateIndex
CREATE INDEX "huddle_participants_userId_idx" ON "huddle_participants"("userId");

-- AddForeignKey
ALTER TABLE "huddles" ADD CONSTRAINT "huddles_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "huddle_participants" ADD CONSTRAINT "huddle_participants_huddleId_fkey" FOREIGN KEY ("huddleId") REFERENCES "huddles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

