-- Remote Control: Audit Trail
CREATE TABLE "remote_actions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "path" TEXT,
    "method" TEXT,
    "summary" TEXT,
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "remote_actions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "remote_actions_instanceId_idx" ON "remote_actions"("instanceId");
CREATE INDEX "remote_actions_userId_idx" ON "remote_actions"("userId");
CREATE INDEX "remote_actions_createdAt_idx" ON "remote_actions"("createdAt");

-- Remote Control: Push Notification Subscriptions
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_subscriptions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "push_subscriptions_instanceId_pushToken_key" ON "push_subscriptions"("instanceId", "pushToken");
CREATE INDEX "push_subscriptions_instanceId_idx" ON "push_subscriptions"("instanceId");

-- Remote Control: QR Pairing Codes
CREATE TABLE "pairing_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "code" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "apiKeyId" TEXT,
    "publicKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pairing_codes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "pairing_codes_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");
CREATE INDEX "pairing_codes_workspaceId_idx" ON "pairing_codes"("workspaceId");
CREATE INDEX "pairing_codes_code_idx" ON "pairing_codes"("code");
