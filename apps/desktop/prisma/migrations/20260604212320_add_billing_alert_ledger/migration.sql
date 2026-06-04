-- Migration: add_billing_alert_ledger
-- Source:    prisma/schema.local.prisma
--
-- Adds the per-period proactive-alert dedupe ledger column to the desktop
-- SQLite mirror of `usage_wallets`. Stores a JSON-encoded object (Json? on
-- PostgreSQL, TEXT here) tracking which usage/overage threshold alerts have
-- already fired this allocation period. NULL = nothing sent yet; reset on the
-- monthly allocation reset alongside overageBilledUsd. See
-- prisma/schema.prisma UsageWallet.alertsSentThisPeriod and
-- apps/api/src/services/billing-alerts.service.ts.
--
-- Scoped to the new column only; pre-existing ACCEPTED_DRIFT redefinitions of
-- other tables (see scripts/check-desktop-schema-drift.ts) are intentionally
-- left out, matching 20260530053000_add_rolling_usage_windows.

-- AlterTable
ALTER TABLE "usage_wallets" ADD COLUMN "alertsSentThisPeriod" TEXT;
