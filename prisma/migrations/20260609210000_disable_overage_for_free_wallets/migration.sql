-- Migration: Disable overage for free-tier wallets (data backfill).
--
-- `overageEnabled` defaults to `true` (set in 20260429210000 so paid plans keep
-- working past included usage). `allocateFreeWallet` historically did NOT
-- override that default, so every free wallet inherited uncapped overage: once
-- a free account exhausted its small rolling window ($0.50/week) it kept
-- spending, billed to `overageAccumulatedUsd` with no hard limit. Free accounts
-- have no payment method on file, so that spend is uncollectable loss.
--
-- The code path now sets `overageEnabled: false` in `allocateFreeWallet`. This
-- backfill repairs existing wallets: it turns overage OFF for every wallet
-- whose workspace has neither an active/trialing paid subscription nor an
-- active grant conferring a paid plan. Paid wallets are left untouched.

UPDATE "usage_wallets" uw
SET "overageEnabled" = false
WHERE uw."overageEnabled" = true
  AND NOT EXISTS (
    SELECT 1 FROM "subscriptions" s
    WHERE s."workspaceId" = uw."workspaceId"
      AND s.status IN ('active', 'trialing')
  )
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_grants" g
    WHERE g."workspaceId" = uw."workspaceId"
      AND g."startsAt" <= now()
      AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
      AND lower(coalesce(g."planId", '')) IN ('basic', 'pro', 'business', 'enterprise')
  );
