-- Migration: SHO-428 CourseEnrollment
-- Source:    prisma/schema.local.prisma
--
-- Additive table for the $99 Solo Founder course. Local mode has no Stripe, so
-- rows arrive from the license-key / admin paths; the shape is identical to the
-- cloud table (see prisma/schema.prisma for full semantics).

-- CreateTable
CREATE TABLE "course_enrollments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "stripeSubscriptionId" TEXT,
    "status" TEXT NOT NULL,
    "purchasedAt" DATETIME NOT NULL,
    "installStatus" TEXT NOT NULL DEFAULT 'pending',
    "installError" TEXT,
    "packBindings" JSONB,
    "courseBoardId" TEXT,
    "progress" JSONB,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "course_enrollments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollments_stripeCheckoutSessionId_key" ON "course_enrollments"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "course_enrollments_userId_courseId_key" ON "course_enrollments"("userId", "courseId");

-- CreateIndex
CREATE INDEX "course_enrollments_workspaceId_idx" ON "course_enrollments"("workspaceId");
