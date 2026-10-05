-- CreateTable
CREATE TABLE "integration_credential_policies" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "writeMode" TEXT NOT NULL DEFAULT 'shared',
    "readMode" TEXT NOT NULL DEFAULT 'shared',
    "fallback" TEXT NOT NULL DEFAULT 'ask',
    "sharedUserId" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_credential_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_integration_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "externalLogin" TEXT,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_integration_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_integration_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_credential_policies_projectId_provider_key" ON "integration_credential_policies"("projectId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "user_integration_connections_userId_provider_key" ON "user_integration_connections"("userId", "provider");

-- CreateIndex
CREATE INDEX "user_integration_grants_projectId_idx" ON "user_integration_grants"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "user_integration_grants_userId_projectId_provider_key" ON "user_integration_grants"("userId", "projectId", "provider");

-- AddForeignKey
ALTER TABLE "integration_credential_policies" ADD CONSTRAINT "integration_credential_policies_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_integration_connections" ADD CONSTRAINT "user_integration_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_integration_grants" ADD CONSTRAINT "user_integration_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_integration_grants" ADD CONSTRAINT "user_integration_grants_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
