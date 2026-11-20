-- SHO-463: WhatsApp platform bindings (desktop / SQLite track)
-- Table stays empty on desktop — bindings are written by cloud.
-- Exists for schema parity per channel rule.

-- CreateTable
CREATE TABLE "whatsapp_number_bindings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "instanceId" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "businessId" TEXT,
    "displayPhoneNumber" TEXT,
    "verifiedName" TEXT,
    "coexistence" BOOLEAN NOT NULL DEFAULT false,
    "tokenEncrypted" TEXT NOT NULL,
    "pinEncrypted" TEXT,
    "contactsSyncRequestId" TEXT,
    "historySyncRequestId" TEXT,
    "syncStartedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "statusReason" TEXT,
    "connectedByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "whatsapp_number_bindings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "whatsapp_number_bindings_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_number_bindings_phoneNumberId_key" ON "whatsapp_number_bindings"("phoneNumberId");

-- CreateIndex
CREATE INDEX "whatsapp_number_bindings_wabaId_idx" ON "whatsapp_number_bindings"("wabaId");

-- CreateIndex
CREATE INDEX "whatsapp_number_bindings_workspaceId_idx" ON "whatsapp_number_bindings"("workspaceId");

-- CreateIndex
CREATE INDEX "whatsapp_number_bindings_projectId_idx" ON "whatsapp_number_bindings"("projectId");
