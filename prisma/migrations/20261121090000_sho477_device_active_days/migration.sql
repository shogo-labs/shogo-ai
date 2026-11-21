-- Migration: sho477_device_active_days
-- Source:    prisma/schema.prisma
-- Desktop:   prisma/schema.local.prisma (same columns; see the SQLite twin)
--
-- One row per device per UTC day it was seen, so "how many machines were alive
-- on 3 November" is answerable. `api_keys` only keeps each key's *last*
-- heartbeat, which cannot answer a per-day question.
--
-- Multi-region rules (k8s/cnpg/logical-replication/RUNBOOK.md
-- «Multi-region migration rules»):
--
--   * **No backfill.** The table does not exist yet, so there is no history to
--     reconstruct — and a backfill from `api_keys.lastSeenAt` would derive
--     every id from replicated row content, which is exactly the 2026-10-22
--     failure (SHO-142). The series starts when the writers ship.
--   * **Random ids only.** `id` relies on Prisma's `@default(cuid())`; this
--     migration writes no rows and no expression ever computes an id.
--   * **`region` is part of the unique key**, so two regions can hold their own
--     tag for one (device, day) without the peer's apply colliding, and a
--     peer's row is deduped by the reader.
--   * The table is **published** (it is not in
--     `INTENTIONALLY_UNPUBLISHED`), like `device_version_events`.

-- CreateTable
CREATE TABLE "device_active_days" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "client" TEXT NOT NULL DEFAULT 'desktop',
    "version" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_active_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_active_days_day_idx" ON "device_active_days"("day");

-- CreateIndex
CREATE UNIQUE INDEX "device_active_days_region_deviceId_day_key" ON "device_active_days"("region", "deviceId", "day");
