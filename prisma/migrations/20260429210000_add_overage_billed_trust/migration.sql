-- Migration: Trust-first overage billing in $100 blocks.
-- Adds `overageBilledUsd` to track how much of the accumulated overage has
-- already been invoiced this period. When `overageAccumulatedUsd` crosses
-- the next $100 boundary past `overageBilledUsd`, a $100 invoice is issued
-- mid-cycle and `overageBilledUsd` bumps. Resets each monthly allocation.
--
-- Also flips `overageEnabled` default to true so paid plans don't have to
-- opt in to keep working past included usage; the optional hard cap still
-- protects them from runaway spend.

ALTER TABLE "usage_wallets"
  ADD COLUMN "overageBilledUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "usage_wallets"
  ALTER COLUMN "overageEnabled" SET DEFAULT true;
