-- One subscription row per workspace (current billing state). Stripe retains full history.
-- Keep the newest row per workspace when deduping legacy duplicates.

DELETE FROM "subscriptions"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "workspaceId"
             ORDER BY "createdAt" DESC, "id" DESC
           ) AS rn
    FROM "subscriptions"
  ) t
  WHERE t.rn > 1
);

DROP INDEX IF EXISTS "subscriptions_workspaceId_idx";

CREATE UNIQUE INDEX "subscriptions_workspaceId_key" ON "subscriptions"("workspaceId");
