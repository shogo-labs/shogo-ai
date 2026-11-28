-- Lifecycle email (SHO-615): a per-user opt-out flag and an exactly-once send
-- ledger. `id` is deterministic ("<kind>:<userId>:<key>") so dedupe rides the
-- PRIMARY KEY — there is deliberately no secondary unique index, which would
-- poison the US/EU logical replication apply worker.
--
-- Hand-written because this branch was prepared without a reachable Postgres
-- dev instance (`bun run db:migrate` needs one). The statements are the exact
-- SQL `prisma migrate dev` emits for an additive nullable column and a new
-- table; nothing else in `users` changes.

ALTER TABLE "users" ADD COLUMN "lifecycleEmailOptOutAt" TIMESTAMP(3);

CREATE TABLE "lifecycle_email_sends" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "lifecycle_email_sends_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lifecycle_email_sends_userId_idx" ON "lifecycle_email_sends"("userId");
