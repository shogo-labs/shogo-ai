-- Migration: add `workspace_grants.planId` so a super-admin credit grant
-- can also upgrade a workspace to a paid plan tier (basic|pro|business|
-- enterprise) without a Stripe subscription.
--
-- Backwards-compatible: existing rows keep `planId = NULL`, which
-- preserves the original "free seats + monthly USD" only behavior.
-- When a paid Stripe subscription is present on the workspace it
-- always wins; the grant's `planId` only takes effect for workspaces
-- without an active subscription.

ALTER TABLE "workspace_grants"
  ADD COLUMN "planId" TEXT;
