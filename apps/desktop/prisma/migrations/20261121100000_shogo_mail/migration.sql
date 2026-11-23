-- Migration: Shogo Mail
-- Source:    prisma/schema.local.prisma
--
-- Additive only: eight new tables mirroring prisma/schema.prisma.

-- CreateTable
CREATE TABLE "mail_domains" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "providerDomainId" TEXT,
    "records" TEXT NOT NULL DEFAULT '[]',
    "sendingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "receivingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "lastError" TEXT,
    "sendingPausedAt" DATETIME,
    "pauseReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_domains_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "localPart" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'shared',
    "displayName" TEXT,
    "ownerUserId" TEXT,
    "agentRef" TEXT,
    "conversationId" TEXT NOT NULL,
    "sendPolicy" TEXT NOT NULL DEFAULT 'approve',
    "screenerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "catchAll" BOOLEAN NOT NULL DEFAULT false,
    "signature" TEXT,
    "slaHours" INTEGER,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mailboxes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mailboxes_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "mail_domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "rootMessageId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "normalizedSubject" TEXT NOT NULL,
    "participants" TEXT NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL DEFAULT 'important',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeUserId" TEXT,
    "snoozedUntil" DATETIME,
    "slaDueAt" DATETIME,
    "lastInboundAt" DATETIME,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_threads_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "threadId" TEXT,
    "conversationMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rfcMessageId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toList" TEXT NOT NULL DEFAULT '[]',
    "ccList" TEXT NOT NULL DEFAULT '[]',
    "bccList" TEXT NOT NULL DEFAULT '[]',
    "replyTo" TEXT,
    "subject" TEXT NOT NULL,
    "snippet" TEXT,
    "textBody" TEXT,
    "htmlStorageKey" TEXT,
    "rawStorageKey" TEXT,
    "authResults" TEXT,
    "spamVerdict" TEXT,
    "attachmentMeta" TEXT NOT NULL DEFAULT '[]',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "draftedByAgentRef" TEXT,
    "approvedByUserId" TEXT,
    "sentByUserId" TEXT,
    "sendAfter" DATETIME,
    "sentAt" DATETIME,
    "receivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_messages_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mail_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "mail_threads" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_senders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mailboxId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_senders_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mailboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT,
    "match" TEXT NOT NULL DEFAULT '{}',
    "action" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_rules_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_suppressions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mail_suppressions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mail_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'imap',
    "address" TEXT NOT NULL,
    "credentialsEncrypted" TEXT NOT NULL,
    "syncCursor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mail_accounts_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "mail_domains_domain_idx" ON "mail_domains"("domain");

-- CreateIndex
CREATE INDEX "mail_domains_status_lastCheckedAt_idx" ON "mail_domains"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mail_domains_workspaceId_domain_key" ON "mail_domains"("workspaceId", "domain");

-- CreateIndex
CREATE INDEX "mailboxes_address_idx" ON "mailboxes"("address");

-- CreateIndex
CREATE INDEX "mailboxes_workspaceId_idx" ON "mailboxes"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_domainId_localPart_key" ON "mailboxes"("domainId", "localPart");

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_conversationId_key" ON "mailboxes"("conversationId");

-- CreateIndex
CREATE INDEX "mail_threads_mailboxId_lastMessageAt_idx" ON "mail_threads"("mailboxId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "mail_threads_mailboxId_normalizedSubject_idx" ON "mail_threads"("mailboxId", "normalizedSubject");

-- CreateIndex
CREATE INDEX "mail_threads_snoozedUntil_idx" ON "mail_threads"("snoozedUntil");

-- CreateIndex
CREATE INDEX "mail_threads_assigneeUserId_status_idx" ON "mail_threads"("assigneeUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mail_threads_rootMessageId_key" ON "mail_threads"("rootMessageId");

-- CreateIndex
CREATE INDEX "mail_messages_mailboxId_direction_createdAt_idx" ON "mail_messages"("mailboxId", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "mail_messages_workspaceId_direction_createdAt_idx" ON "mail_messages"("workspaceId", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "mail_messages_status_sendAfter_idx" ON "mail_messages"("status", "sendAfter");

-- CreateIndex
CREATE INDEX "mail_messages_providerMessageId_idx" ON "mail_messages"("providerMessageId");

-- CreateIndex
CREATE INDEX "mail_messages_threadId_createdAt_idx" ON "mail_messages"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_mailboxId_rfcMessageId_key" ON "mail_messages"("mailboxId", "rfcMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_conversationMessageId_key" ON "mail_messages"("conversationMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "mail_senders_mailboxId_address_key" ON "mail_senders"("mailboxId", "address");

-- CreateIndex
CREATE INDEX "mail_rules_mailboxId_position_idx" ON "mail_rules"("mailboxId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "mail_suppressions_workspaceId_address_key" ON "mail_suppressions"("workspaceId", "address");

-- CreateIndex
CREATE INDEX "mail_accounts_status_lastSyncAt_idx" ON "mail_accounts"("status", "lastSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "mail_accounts_mailboxId_address_key" ON "mail_accounts"("mailboxId", "address");

