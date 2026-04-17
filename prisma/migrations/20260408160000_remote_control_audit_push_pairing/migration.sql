-- Remote Control: Audit Trail
CREATE TABLE "remote_actions" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "path" TEXT,
    "method" TEXT,
    "summary" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remote_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "remote_actions_instanceId_idx" ON "remote_actions"("instanceId");
CREATE INDEX "remote_actions_userId_idx" ON "remote_actions"("userId");
CREATE INDEX "remote_actions_createdAt_idx" ON "remote_actions"("createdAt");

ALTER TABLE "remote_actions" ADD CONSTRAINT "remote_actions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remote Control: Push Notification Subscriptions
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_instanceId_pushToken_key" ON "push_subscriptions"("instanceId", "pushToken");
CREATE INDEX "push_subscriptions_instanceId_idx" ON "push_subscriptions"("instanceId");

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remote Control: QR Pairing Codes (with key-exchange field for future E2E)
CREATE TABLE "pairing_codes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "apiKeyId" TEXT,
    "publicKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");
CREATE INDEX "pairing_codes_workspaceId_idx" ON "pairing_codes"("workspaceId");
CREATE INDEX "pairing_codes_code_idx" ON "pairing_codes"("code");

ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
