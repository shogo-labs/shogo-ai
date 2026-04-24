-- CreateTable
CREATE TABLE "sprints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idea" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'think',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sprint_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "artifacts_sprint_id_fkey" FOREIGN KEY ("sprint_id") REFERENCES "sprints" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "skill_docs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "ported_at" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "sprints_status_stage_idx" ON "sprints"("status", "stage");

-- CreateIndex
CREATE INDEX "artifacts_sprint_id_stage_idx" ON "artifacts"("sprint_id", "stage");

-- CreateIndex
CREATE INDEX "artifacts_role_idx" ON "artifacts"("role");

-- CreateIndex
CREATE UNIQUE INDEX "skill_docs_name_key" ON "skill_docs"("name");

-- CreateIndex
CREATE INDEX "skill_docs_is_core_stage_idx" ON "skill_docs"("is_core", "stage");

-- CreateIndex
CREATE INDEX "skill_docs_role_idx" ON "skill_docs"("role");
