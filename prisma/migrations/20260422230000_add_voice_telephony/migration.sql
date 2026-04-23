-- CreateTable
CREATE TABLE "voice_project_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "elevenlabsAgentId" TEXT,
    "twilioPhoneNumber" TEXT,
    "twilioPhoneSid" TEXT,
    "elevenlabsPhoneId" TEXT,
    "purchasedAt" TIMESTAMP(3),
    "monthlyRateDebitedFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_project_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_project_configs_projectId_key" ON "voice_project_configs"("projectId");

-- CreateIndex
CREATE INDEX "voice_project_configs_workspaceId_idx" ON "voice_project_configs"("workspaceId");

-- AddForeignKey
ALTER TABLE "voice_project_configs" ADD CONSTRAINT "voice_project_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_project_configs" ADD CONSTRAINT "voice_project_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "voice_call_meters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "callSid" TEXT,
    "direction" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "billedMinutes" INTEGER NOT NULL,
    "usageEventId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_call_meters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_call_meters_conversationId_key" ON "voice_call_meters"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "voice_call_meters_callSid_key" ON "voice_call_meters"("callSid");

-- CreateIndex
CREATE UNIQUE INDEX "voice_call_meters_usageEventId_key" ON "voice_call_meters"("usageEventId");

-- CreateIndex
CREATE INDEX "voice_call_meters_projectId_idx" ON "voice_call_meters"("projectId");

-- CreateIndex
CREATE INDEX "voice_call_meters_workspaceId_idx" ON "voice_call_meters"("workspaceId");
