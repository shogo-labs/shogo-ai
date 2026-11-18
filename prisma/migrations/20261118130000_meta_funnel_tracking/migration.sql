-- Migration: Meta funnel tracking (2026-11-18).
--
-- `users.activatedAt` / `activationMessages`: the activation step reported to
-- Meta as `Activated`. `signup_attributions` gains the funnel id and the Meta
-- browser ids + client hints the Conversions API needs for events sent later
-- with no browser attached. `funnel_events` holds anonymous pre-signup steps
-- from shogo.ai; insert-only with client-minted unique ids.
--
-- DDL only, additive, no backfill.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "activationMessages" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "signup_attributions" ADD COLUMN "funnel" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "fbp" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "fbc" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "clientIp" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "userAgent" TEXT;

-- CreateTable
CREATE TABLE "funnel_events" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnel_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "funnel_events_eventId_key" ON "funnel_events"("eventId");
CREATE INDEX "funnel_events_funnel_step_createdAt_idx" ON "funnel_events"("funnel", "step", "createdAt");
CREATE INDEX "funnel_events_utmContent_idx" ON "funnel_events"("utmContent");
