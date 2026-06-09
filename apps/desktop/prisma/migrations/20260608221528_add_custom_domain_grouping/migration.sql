-- Migration: add_custom_domain_grouping
-- Source:    prisma/schema.local.prisma
--
-- Adds apex<->www grouping to custom_domains: `groupId` links a domain to
-- its companion (apex <-> www) and `primary` marks which one is canonical
-- (the other 308-redirects to it at the edge). Scoped to ALTER ADD COLUMN
-- so it touches only this table (no unrelated accepted-drift churn).

ALTER TABLE "custom_domains" ADD COLUMN "groupId" TEXT;
ALTER TABLE "custom_domains" ADD COLUMN "primary" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "custom_domains_groupId_idx" ON "custom_domains"("groupId");
