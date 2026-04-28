-- SQLite migration: Add seats to Subscription
--
-- Mirrors prisma/migrations/20260428210000_add_subscription_seats/migration.sql.
-- Per-seat plan ladder: Basic is always 1 seat, Pro/Business charge per seat.

ALTER TABLE "subscriptions" ADD COLUMN "seats" INTEGER NOT NULL DEFAULT 1;
