-- Migration: add_custom_domain_retrigger_state
-- Source:    prisma/schema.local.prisma
--
-- Adds robust-status + self-heal bookkeeping to custom_domains:
--   certAuthority   — issuing CA Cloudflare assigned (spot a slow CA)
--   lastCheckedAt   — when the reconciler last polled CF + DNS
--   lastRetriggerAt — when issuance was last re-triggered (cooldown/backoff)
--   retriggerCount  — how many times re-triggered (auto-heal is capped)
--   dnsOk           — last server-side DNS verdict (gates retrigger)
--   diagnostics     — JSON snapshot of latest status detail (DB-only reads)
-- Scoped to ALTER ADD COLUMN so it touches only this table (no unrelated
-- accepted-drift churn), matching 20260608221528_add_custom_domain_grouping.

ALTER TABLE "custom_domains" ADD COLUMN "certAuthority" TEXT;
ALTER TABLE "custom_domains" ADD COLUMN "lastCheckedAt" DATETIME;
ALTER TABLE "custom_domains" ADD COLUMN "lastRetriggerAt" DATETIME;
ALTER TABLE "custom_domains" ADD COLUMN "retriggerCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "custom_domains" ADD COLUMN "dnsOk" BOOLEAN;
ALTER TABLE "custom_domains" ADD COLUMN "diagnostics" TEXT;
