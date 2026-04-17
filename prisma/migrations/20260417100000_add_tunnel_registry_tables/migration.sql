-- CreateTable
CREATE TABLE "active_viewers" (
    "workspaceId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_viewers_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE INDEX "active_viewers_lastSeenAt_idx" ON "active_viewers"("lastSeenAt");

-- CreateTable
CREATE TABLE "tunnel_ownership" (
    "instanceId" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "podIp" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tunnel_ownership_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE INDEX "tunnel_ownership_podId_idx" ON "tunnel_ownership"("podId");

-- CreateIndex
CREATE INDEX "tunnel_ownership_refreshedAt_idx" ON "tunnel_ownership"("refreshedAt");
