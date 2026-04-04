-- AlterTable
ALTER TABLE "eval_run_results" ADD COLUMN     "failedToolCalls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "iterations" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "toolCallCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "eval_run_results_evalId_idx" ON "eval_run_results"("evalId");
