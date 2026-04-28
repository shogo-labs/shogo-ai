-- Migration: Add seats to Subscription
-- Per-seat plan ladder: Basic is always 1 seat, Pro/Business charge per seat.
-- Existing rows default to 1 seat; the migrate-tier-subscriptions.ts script
-- backfills the correct seat count for legacy tiered subscribers.

ALTER TABLE "subscriptions" ADD COLUMN "seats" INTEGER NOT NULL DEFAULT 1;
