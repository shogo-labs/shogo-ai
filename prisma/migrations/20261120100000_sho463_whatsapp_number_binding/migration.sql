-- SHO-463: WhatsApp platform bindings (Meta Tech Provider / Embedded Signup)
-- Creates whatsapp_number_bindings table for numbers connected through Shogo's
-- Tech Provider flow. Coexists with existing BYO-app config.json entries.

CREATE TABLE "whatsapp_number_bindings" (
    "id" TEXT NOT NULL,
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
    "syncStartedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "statusReason" TEXT,
    "connectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_number_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_number_bindings_phoneNumberId_key" ON "whatsapp_number_bindings"("phoneNumberId");
CREATE INDEX "whatsapp_number_bindings_wabaId_idx" ON "whatsapp_number_bindings"("wabaId");
CREATE INDEX "whatsapp_number_bindings_workspaceId_idx" ON "whatsapp_number_bindings"("workspaceId");
CREATE INDEX "whatsapp_number_bindings_projectId_idx" ON "whatsapp_number_bindings"("projectId");

ALTER TABLE "whatsapp_number_bindings" ADD CONSTRAINT "whatsapp_number_bindings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_number_bindings" ADD CONSTRAINT "whatsapp_number_bindings_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
