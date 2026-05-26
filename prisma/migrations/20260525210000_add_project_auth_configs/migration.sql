-- Migration: per-project sign-in allowlist for Shogo SDK auth.
--
-- See prisma/schema.prisma `ProjectAuthConfig` and `ProjectAuthSignIn`
-- for the canonical comments and apps/api/src/auth.ts for the Better
-- Auth before-hook that enforces this allowlist when SDK clients
-- forward `X-Shogo-Project-Id`.

-- CreateTable
CREATE TABLE "project_auth_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'anyone',
    "allowedEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requireEmailVerification" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_auth_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_auth_configs_projectId_key" ON "project_auth_configs"("projectId");

-- AddForeignKey
ALTER TABLE "project_auth_configs" ADD CONSTRAINT "project_auth_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "project_auth_sign_ins" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstSignInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSignInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signInCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "project_auth_sign_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_auth_sign_ins_projectId_userId_key" ON "project_auth_sign_ins"("projectId", "userId");

-- CreateIndex
CREATE INDEX "project_auth_sign_ins_projectId_lastSignInAt_idx" ON "project_auth_sign_ins"("projectId", "lastSignInAt" DESC);

-- AddForeignKey
ALTER TABLE "project_auth_sign_ins" ADD CONSTRAINT "project_auth_sign_ins_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_auth_sign_ins" ADD CONSTRAINT "project_auth_sign_ins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
