-- Migration: learn.shogo.ai progress and badges (desktop/SQLite track).
-- Mirrors prisma/migrations/20261120130000_learn_progress_badges.

-- CreateTable
CREATE TABLE "learn_lesson_completions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "learn_lesson_completions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "learn_badges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "learn_badges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "learn_lesson_completions_userId_completedAt_idx" ON "learn_lesson_completions"("userId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "learn_lesson_completions_userId_courseId_lessonId_key" ON "learn_lesson_completions"("userId", "courseId", "lessonId");

-- CreateIndex
CREATE INDEX "learn_badges_userId_idx" ON "learn_badges"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "learn_badges_userId_badgeId_key" ON "learn_badges"("userId", "badgeId");
