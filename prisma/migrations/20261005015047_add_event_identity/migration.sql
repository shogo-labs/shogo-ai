-- AlterTable
ALTER TABLE "workspace_events" ADD COLUMN "actor" JSONB;

-- AlterTable
ALTER TABLE "event_subscriptions" ADD COLUMN "actsAs" TEXT NOT NULL DEFAULT 'subscriber',
ADD COLUMN "actorIdPath" TEXT,
ADD COLUMN "actorEmailPath" TEXT,
ADD COLUMN "trustActorEmail" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_identity_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_identity_links_source_externalId_idx" ON "user_identity_links"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_links_userId_source_externalId_key" ON "user_identity_links"("userId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "user_identity_links" ADD CONSTRAINT "user_identity_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
