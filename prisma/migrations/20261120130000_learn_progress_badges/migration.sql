-- Migration: learn.shogo.ai progress and badges.
--
-- `learn_lesson_completions` holds the lessons a learner marked complete on
-- learn.shogo.ai (every learn course except Solo Founder, whose progress lives
-- on its course board). XP, levels and streaks are derived from these rows.
-- `learn_badges` holds badges the API awarded, one row per (user, badge).
--
-- DDL only. Both tables are new, so there is nothing to backfill, and the
-- publication (FOR TABLES IN SCHEMA public) picks them up without an
-- ALTER PUBLICATION. Rows are keyed by uuid and written once per
-- (user, course, lesson) / (user, badge), so a learner writes them in one
-- region at a time; redelivery is a no-op on the unique keys.
-- CreateTable
CREATE TABLE "learn_lesson_completions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learn_lesson_completions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learn_badges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learn_badges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learn_lesson_completions_userId_completedAt_idx" ON "learn_lesson_completions"("userId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "learn_lesson_completions_userId_courseId_lessonId_key" ON "learn_lesson_completions"("userId", "courseId", "lessonId");

-- CreateIndex
CREATE INDEX "learn_badges_userId_idx" ON "learn_badges"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "learn_badges_userId_badgeId_key" ON "learn_badges"("userId", "badgeId");

-- AddForeignKey
ALTER TABLE "learn_lesson_completions" ADD CONSTRAINT "learn_lesson_completions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learn_badges" ADD CONSTRAINT "learn_badges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

