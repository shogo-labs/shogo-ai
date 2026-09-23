CREATE TABLE "app_installs" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT,
    "osVersion" TEXT,
    "deviceModel" TEXT,
    "userId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_installs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_installs_deviceId_key" ON "app_installs"("deviceId");
CREATE INDEX "app_installs_platform_idx" ON "app_installs"("platform");
CREATE INDEX "app_installs_lastSeenAt_idx" ON "app_installs"("lastSeenAt");
CREATE INDEX "app_installs_userId_idx" ON "app_installs"("userId");

ALTER TABLE "app_installs"
  ADD CONSTRAINT "app_installs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
