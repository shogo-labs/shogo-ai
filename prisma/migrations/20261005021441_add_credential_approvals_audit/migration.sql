-- AlterTable
ALTER TABLE "integration_credential_policies" ADD COLUMN "delegateUserId" TEXT,
ADD COLUMN "delegatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "integration_credential_approvals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "toolName" TEXT,
    "summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requesterUserId" TEXT,
    "origin" JSONB,
    "conversationId" TEXT,
    "messageId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_credential_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credential_audit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actingAs" TEXT NOT NULL,
    "actingUserId" TEXT,
    "requesterUserId" TEXT,
    "origin" JSONB,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_credential_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_credential_approvals_projectId_status_idx" ON "integration_credential_approvals"("projectId", "status");

-- CreateIndex
CREATE INDEX "integration_credential_audit_projectId_createdAt_idx" ON "integration_credential_audit"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "integration_credential_approvals" ADD CONSTRAINT "integration_credential_approvals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credential_audit" ADD CONSTRAINT "integration_credential_audit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
