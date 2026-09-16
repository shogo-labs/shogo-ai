-- Add transport metadata to the admin-managed model catalog.
ALTER TABLE "model_definitions"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN "usdPerMinute" DOUBLE PRECISION;

CREATE TABLE "live_session_meters" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "memberId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "backendModel" TEXT,
    "transport" TEXT NOT NULL,
    "seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rawUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "billedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_session_meters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "live_session_meters_sessionId_key"
  ON "live_session_meters"("sessionId");
CREATE INDEX "live_session_meters_workspaceId_idx"
  ON "live_session_meters"("workspaceId");
CREATE INDEX "live_session_meters_projectId_idx"
  ON "live_session_meters"("projectId");

ALTER TABLE "live_session_meters"
  ADD CONSTRAINT "live_session_meters_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_session_meters"
  ADD CONSTRAINT "live_session_meters_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
