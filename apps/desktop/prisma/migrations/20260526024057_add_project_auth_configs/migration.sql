-- Migration: add_project_auth_configs
--
-- Per-project sign-in allowlist + sign-in audit table for users
-- authenticating via the Shogo SDK (`shogo.auth` -> platform
-- `/api/auth/*`). See prisma/schema.local.prisma `ProjectAuthConfig`
-- / `ProjectAuthSignIn` for the canonical comments.
--
-- SQLite stores the two list columns as JSON-encoded TEXT; the backend
-- (apps/api/src/lib/prisma.ts ARRAY_FIELDS) handles parse/stringify on
-- read/write transparently.

-- CreateTable
CREATE TABLE "project_auth_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'anyone',
    "allowedEmails" TEXT NOT NULL DEFAULT '[]',
    "allowedDomains" TEXT NOT NULL DEFAULT '[]',
    "requireEmailVerification" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "project_auth_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "project_auth_configs_projectId_key" ON "project_auth_configs"("projectId");

-- CreateTable
CREATE TABLE "project_auth_sign_ins" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstSignInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSignInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signInCount" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "project_auth_sign_ins_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_auth_sign_ins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "project_auth_sign_ins_projectId_userId_key" ON "project_auth_sign_ins"("projectId", "userId");

-- CreateIndex
CREATE INDEX "project_auth_sign_ins_projectId_lastSignInAt_idx" ON "project_auth_sign_ins"("projectId", "lastSignInAt" DESC);
