-- Meeting notes: rough notes, enhanced notes, templates, sharing, and
-- ownership by the user's personal workspace.
ALTER TABLE "meetings" ALTER COLUMN "audioPath" SET DEFAULT '';
ALTER TABLE "meetings" ADD COLUMN "notes" TEXT;
ALTER TABLE "meetings" ADD COLUMN "enhancedNotes" TEXT;
ALTER TABLE "meetings" ADD COLUMN "actionItems" TEXT;
ALTER TABLE "meetings" ADD COLUMN "enhanceStatus" TEXT;
ALTER TABLE "meetings" ADD COLUMN "enhanceError" TEXT;
ALTER TABLE "meetings" ADD COLUMN "templateId" TEXT;
ALTER TABLE "meetings" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'desktop';
ALTER TABLE "meetings" ADD COLUMN "app" TEXT;
ALTER TABLE "meetings" ADD COLUMN "recordingId" TEXT;
ALTER TABLE "meetings" ADD COLUMN "userId" TEXT;
ALTER TABLE "meetings" ADD COLUMN "shareToken" TEXT;
ALTER TABLE "meetings" ADD COLUMN "sharedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "meetings_workspaceId_recordingId_key" ON "meetings"("workspaceId", "recordingId");
CREATE UNIQUE INDEX "meetings_shareToken_key" ON "meetings"("shareToken");
CREATE INDEX "meetings_workspaceId_createdAt_idx" ON "meetings"("workspaceId", "createdAt");
CREATE INDEX "meetings_userId_idx" ON "meetings"("userId");

CREATE TABLE "meeting_templates" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meeting_templates_workspaceId_idx" ON "meeting_templates"("workspaceId");

ALTER TABLE "meeting_templates" ADD CONSTRAINT "meeting_templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
