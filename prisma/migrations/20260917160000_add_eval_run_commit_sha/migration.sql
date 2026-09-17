-- Adds the git commit SHA an eval run executed against, so a run's pass
-- rate can be joined against the production telemetry window for that
-- exact commit. Reported by run-eval.ts itself (the process that actually
-- runs the eval code), not the admin server.
ALTER TABLE "eval_runs" ADD COLUMN "commitSha" TEXT;
