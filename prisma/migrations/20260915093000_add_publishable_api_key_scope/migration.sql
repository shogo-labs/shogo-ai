ALTER TABLE "api_keys"
ADD COLUMN "projectId" TEXT,
ADD COLUMN "allowedOrigins" JSONB;

CREATE INDEX "api_keys_projectId_kind_idx"
ON "api_keys"("projectId", "kind");
