-- Migration: CourseEnrollment (SHO-428).
--
-- The $99 Solo Founder offer fulfils into this row: the Stripe webhook writes
-- it once the card clears the prepaid check, and `soloFounderService.enroll()`
-- installs the course pack from it. `packBindings` keeps the ids the install
-- created so a retried install updates through them instead of duplicating
-- #course, its boards or its lesson cards.
--
-- DDL only. `course_enrollments` is a published table, so a backfill UPDATE
-- here would write the same logical rows in every region — the SHO-344 outage
-- shape (RUNBOOK §3, `bun run check:migration-ids`). There is nothing to
-- backfill: no row can exist before this table.

-- CreateTable
CREATE TABLE "course_enrollments" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "stripeSubscriptionId" TEXT,
    "status" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "installStatus" TEXT NOT NULL DEFAULT 'pending',
    "installError" TEXT,
    "packBindings" JSONB,
    "courseBoardId" TEXT,
    "progress" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollments_stripeCheckoutSessionId_key" ON "course_enrollments"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollments_userId_courseId_key" ON "course_enrollments"("userId", "courseId");

-- CreateIndex
CREATE INDEX "course_enrollments_workspaceId_idx" ON "course_enrollments"("workspaceId");

-- AddForeignKey
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
