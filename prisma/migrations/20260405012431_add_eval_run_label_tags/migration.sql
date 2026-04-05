-- AlterTable
ALTER TABLE "eval_runs" ADD COLUMN     "label" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
