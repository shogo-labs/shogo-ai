-- CreateEnum
CREATE TYPE "ProjectCategory" AS ENUM ('app', 'website', 'tool', 'game');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "category" "ProjectCategory";
