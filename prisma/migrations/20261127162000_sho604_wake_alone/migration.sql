-- `wake: "alone"`: this task's [Task update] runs in its own turn instead of
-- being merged with the other updates waiting in the queue (SHO-604).
--
-- Hand-written because this branch was prepared without a reachable Postgres
-- dev instance (`bun run db:migrate` needs one). The statement is the exact
-- SQL `prisma migrate dev` emits for an additive non-null column with a
-- default; nothing else in the table changes.
ALTER TABLE "background_tasks" ADD COLUMN "wakeAlone" BOOLEAN NOT NULL DEFAULT false;
