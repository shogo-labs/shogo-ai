-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL DEFAULT 'concept',
    "source" TEXT NOT NULL,
    "source_url" TEXT NOT NULL DEFAULT '',
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "last_verified" TEXT NOT NULL,
    "entities" TEXT NOT NULL DEFAULT '[]',
    "related_notes" TEXT NOT NULL DEFAULT '[]',
    "fact_true_from" TEXT NOT NULL DEFAULT '',
    "fact_true_until" TEXT NOT NULL DEFAULT 'present',
    "vault_learned" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "citations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "note_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "claim" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "syntheses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "pattern_type" TEXT NOT NULL DEFAULT 'theme',
    "time_window" TEXT NOT NULL DEFAULT '7 days',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "contradictions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "note_a_id" TEXT NOT NULL,
    "note_b_id" TEXT NOT NULL,
    "claim_a" TEXT NOT NULL,
    "claim_b" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unresolved',
    "resolution" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "researches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'quick',
    "findings" TEXT NOT NULL,
    "citations" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "gaps_filled" INTEGER NOT NULL DEFAULT 0,
    "contradictions_found" INTEGER NOT NULL DEFAULT 0,
    "notes_updated" INTEGER NOT NULL DEFAULT 0,
    "notes_created" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "vault_metrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "total_notes" INTEGER NOT NULL DEFAULT 0,
    "notes_this_week" INTEGER NOT NULL DEFAULT 0,
    "orphan_count" INTEGER NOT NULL DEFAULT 0,
    "contradiction_count" INTEGER NOT NULL DEFAULT 0,
    "unresolved_contradictions" INTEGER NOT NULL DEFAULT 0,
    "synthesis_count" INTEGER NOT NULL DEFAULT 0,
    "stale_notes" INTEGER NOT NULL DEFAULT 0,
    "average_confidence" REAL NOT NULL DEFAULT 0,
    "total_sources" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "daily_notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "decisions_count" INTEGER NOT NULL DEFAULT 0,
    "sources_ingested" INTEGER NOT NULL DEFAULT 0,
    "tasks_created" INTEGER NOT NULL DEFAULT 0,
    "contradictions" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "notes_entity_type_idx" ON "notes"("entity_type");

-- CreateIndex
CREATE INDEX "notes_confidence_idx" ON "notes"("confidence");

-- CreateIndex
CREATE INDEX "notes_updated_at_idx" ON "notes"("updated_at");

-- CreateIndex
CREATE INDEX "citations_note_id_idx" ON "citations"("note_id");

-- CreateIndex
CREATE INDEX "syntheses_pattern_type_idx" ON "syntheses"("pattern_type");

-- CreateIndex
CREATE INDEX "syntheses_created_at_idx" ON "syntheses"("created_at");

-- CreateIndex
CREATE INDEX "contradictions_status_idx" ON "contradictions"("status");

-- CreateIndex
CREATE INDEX "researches_status_idx" ON "researches"("status");

-- CreateIndex
CREATE INDEX "researches_created_at_idx" ON "researches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vault_metrics_date_key" ON "vault_metrics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_notes_date_key" ON "daily_notes"("date");
