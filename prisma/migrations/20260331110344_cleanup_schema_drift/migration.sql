/*
  Warnings:

  - You are about to drop the column `type` on the `projects` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "idx_agent_configs_heartbeat_schedule";

-- AlterTable
ALTER TABLE "agent_configs" ALTER COLUMN "modelName" SET DEFAULT 'claude-sonnet-4-6';

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "type";

-- DropEnum
DROP TYPE "ProjectType";
