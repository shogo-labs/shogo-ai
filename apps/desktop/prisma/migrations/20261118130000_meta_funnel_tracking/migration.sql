-- Meta funnel tracking (2026-11-18). Mirrors the cloud migration of the same name.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "activatedAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "activationMessages" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "signup_attributions" ADD COLUMN "clientIp" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "fbc" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "fbp" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "funnel" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "userAgent" TEXT;

-- CreateTable
CREATE TABLE "funnel_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "funnel" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "visitorId" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "landingPage" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "funnel_events_eventId_key" ON "funnel_events"("eventId");
CREATE INDEX "funnel_events_funnel_step_createdAt_idx" ON "funnel_events"("funnel", "step", "createdAt");
CREATE INDEX "funnel_events_utmContent_idx" ON "funnel_events"("utmContent");
