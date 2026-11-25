-- Migration: Shogo credit (SHO-572).
--
-- One row per bonus-credit grant instead of the single balance on
-- `usage_wallets`. Shogo credit pays for Hoshi models only, and the balance is
-- `sum(remainingUsd)` over live rows (not expired, not revoked) —
-- `apps/api/src/services/shogo-credit.service.ts` is the only writer.
--
-- The whole $10 signup credit becomes Shogo credit (Russell, 2026-11-25), so
-- every unexpired `promoCreditUsd` balance must be copied in to the cent.
-- `promoCredit*` columns are kept one release (no longer written) so a pod
-- still on the previous build can read them during the rolling deploy.
--
-- DDL only. `usage_wallets` / `shogo_credit_grants` are published tables, so a
-- backfill INSERT here would mint the same rows in every region — the SHO-344
-- outage shape, and `bun run check:migration-ids` rejects it. The copy is an
-- idempotent, primary-region-only post-deploy step instead:
--
--   bun scripts/backfill-shogo-credit-grants.ts            # dry run
--   bun scripts/backfill-shogo-credit-grants.ts --apply    # US primary only
--
-- Run it as part of the deploy. Until it runs, an existing balance is not
-- spendable (the grant table is empty), so users with live signup credit are
-- blocked once their windows are spent.
--
-- Published on purpose, unlike `usage_wallets`: the spendable balance has to be
-- readable from the region serving the call, and the `(source, sourceRef)` key
-- makes a repeated grant from a second region a clean P2002 no-op instead of a
-- second payout. In `USAGE_WALLET_HOME_WRITER=enforce` the debit is routed to
-- `workspace.homeRegion` exactly like the wallet.

-- CreateTable
CREATE TABLE "shogo_credit_grants" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "remainingUsd" DOUBLE PRECISION NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shogo_credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shogo_credit_grants_source_sourceRef_key" ON "shogo_credit_grants"("source", "sourceRef");

-- CreateIndex
CREATE INDEX "shogo_credit_grants_workspaceId_expiresAt_idx" ON "shogo_credit_grants"("workspaceId", "expiresAt");

-- AddForeignKey
ALTER TABLE "shogo_credit_grants" ADD CONSTRAINT "shogo_credit_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
