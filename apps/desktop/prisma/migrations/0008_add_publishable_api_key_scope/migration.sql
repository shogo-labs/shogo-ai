-- Prisma requires a table rebuild for the new nullable JSON field on SQLite.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "allowedOrigins" JSONB,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "kind" TEXT NOT NULL DEFAULT 'user',
    "deviceId" TEXT,
    "deviceName" TEXT,
    "devicePlatform" TEXT,
    "deviceAppVersion" TEXT,
    "lastSeenAt" DATETIME,
    CONSTRAINT "api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_api_keys" (
  "allowedOrigins", "createdAt", "deviceAppVersion", "deviceId",
  "deviceName", "devicePlatform", "expiresAt", "id", "keyHash",
  "keyPrefix", "kind", "lastSeenAt", "lastUsedAt", "name", "projectId",
  "revokedAt", "userId", "workspaceId"
)
SELECT
  NULL, "createdAt", "deviceAppVersion", "deviceId", "deviceName",
  "devicePlatform", "expiresAt", "id", "keyHash", "keyPrefix", "kind",
  "lastSeenAt", "lastUsedAt", "name", NULL, "revokedAt", "userId",
  "workspaceId"
FROM "api_keys";
DROP TABLE "api_keys";
ALTER TABLE "new_api_keys" RENAME TO "api_keys";
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_workspaceId_idx" ON "api_keys"("workspaceId");
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");
CREATE INDEX "api_keys_workspaceId_deviceId_idx" ON "api_keys"("workspaceId", "deviceId");
CREATE INDEX "api_keys_projectId_kind_idx" ON "api_keys"("projectId", "kind");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
