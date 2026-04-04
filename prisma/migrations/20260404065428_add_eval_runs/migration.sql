-- CreateTable
CREATE TABLE "eval_runs" (
    "id" TEXT NOT NULL,
    "track" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "workers" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggeredBy" TEXT,
    "pid" INTEGER,
    "jobName" TEXT,
    "error" TEXT,
    "summary" JSONB,
    "cost" JSONB,
    "byCategory" JSONB,
    "resources" JSONB,
    "progress" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_run_results" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "evalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "level" INTEGER,
    "passed" BOOLEAN NOT NULL,
    "score" INTEGER NOT NULL,
    "maxScore" INTEGER NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "tokens" JSONB,
    "phaseScores" JSONB,
    "pipeline" TEXT,
    "pipelinePhase" INTEGER,
    "criteria" JSONB,
    "antiPatterns" JSONB,
    "errors" JSONB,
    "warnings" JSONB,
    "log" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_run_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eval_runs_status_idx" ON "eval_runs"("status");

-- CreateIndex
CREATE INDEX "eval_runs_createdAt_idx" ON "eval_runs"("createdAt");

-- CreateIndex
CREATE INDEX "eval_run_results_runId_idx" ON "eval_run_results"("runId");

-- AddForeignKey
ALTER TABLE "eval_run_results" ADD CONSTRAINT "eval_run_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "eval_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
