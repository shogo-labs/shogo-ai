-- Migration: sho477_device_active_days
-- Source:    prisma/schema.local.prisma (SQLite)
-- Mirrors prisma/migrations/20261121090000_sho477_device_active_days/migration.sql.
--
-- One row per device per UTC day it was seen, so "how many machines were alive
-- on 3 November" is answerable in local mode too. No backfill: the ids are
-- random (`cuid()` at the insert point), never derived from row content.

-- CreateTable
CREATE TABLE "device_active_days" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "region" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "client" TEXT NOT NULL DEFAULT 'desktop',
    "version" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "device_active_days_day_idx" ON "device_active_days"("day");

-- CreateIndex
CREATE UNIQUE INDEX "device_active_days_region_deviceId_day_key" ON "device_active_days"("region", "deviceId", "day");
