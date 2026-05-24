// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `scripts/dev-all.ts`'s SQLite migration
 * self-heal.
 *
 * Background: Prisma's "apply migration" is two operations — execute
 * the SQL, then `UPDATE _prisma_migrations SET finished_at = ?`.
 * SQLite commits the SQL first, so when `bun dev:all` is interrupted
 * (Ctrl+C, watch-api crash, OS sleep) between those two steps, the
 * schema moves forward but the ledger row stays incomplete. Next boot,
 * `prisma migrate deploy` returns P3018 "duplicate column name: X" and
 * `dev:all` aborts until a human runs `prisma migrate resolve --applied`.
 *
 * The auto-resolve recovers from THIS specific shape only:
 *   - error is P3018 with "duplicate column name: …"
 *   - the failing migration is purely ALTER TABLE ADD COLUMN statements
 *   - every column it would add is already present in the DB
 * Anything else falls through to the original abort.
 *
 * These tests pin both halves of the contract:
 *   1. parseDuplicateColumnFailure correctly extracts the migration name
 *      and column from real Prisma stderr, and refuses to match other
 *      error shapes.
 *   2. isMigrationFullyApplied returns true ONLY when the migration is
 *      purely ADD COLUMN AND every target column is already physically
 *      present in the DB. Mixed-shape migrations (CREATE TABLE,
 *      DROP COLUMN, data UPDATE, etc.) must fail closed regardless of
 *      column state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isMigrationFullyApplied,
  parseDuplicateColumnFailure,
} from "../dev-all";

describe("parseDuplicateColumnFailure", () => {
  test("extracts migration name + column from real P3018 stderr", () => {
    const stderr = `Datasource "db": SQLite database "shogo.db" at "file:./shogo.db"

Applying migration \`20260518000000_grant_plan_tier\`
Error: P3018

A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve

Migration name: 20260518000000_grant_plan_tier

Database error code: 1

Database error:
duplicate column name: planId
`;
    expect(parseDuplicateColumnFailure(stderr)).toEqual({
      migrationName: "20260518000000_grant_plan_tier",
      duplicateColumn: "planId",
    });
  });

  test("returns null for non-P3018 errors (e.g. engine connection failures)", () => {
    const stderr = `Error: P1001
Can't reach database server at \`localhost:5432\``;
    expect(parseDuplicateColumnFailure(stderr)).toBeNull();
  });

  test("returns null for P3018 caused by a non-duplicate-column error (e.g. NOT NULL)", () => {
    const stderr = `Error: P3018
Migration name: 20260101000000_add_required_field

Database error code: 1
Database error:
NOT NULL constraint failed: projects.requiredField`;
    // The auto-resolve only covers the duplicate-column shape; other
    // P3018 causes (NOT NULL, FK violation, syntax error) need a real
    // human to look at the data.
    expect(parseDuplicateColumnFailure(stderr)).toBeNull();
  });

  test("returns null when stderr is empty", () => {
    expect(parseDuplicateColumnFailure("")).toBeNull();
  });
});

describe("isMigrationFullyApplied", () => {
  let workDir: string;
  let dbPath: string;
  let migrationsDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dev-all-migrate-"));
    dbPath = join(workDir, "test.db");
    migrationsDir = "fixtures/migrations";
    mkdirSync(join(workDir, migrationsDir), { recursive: true });

    // Seed a minimal DB schema. The "good" migration's columns ARE
    // present; the "missing" migration's columns are NOT present.
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE workspace_grants (
        id TEXT PRIMARY KEY,
        planId TEXT
      )
    `);
    db.run(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        publishStatus TEXT,
        publishError TEXT,
        publishStatusAt INTEGER
      )
    `);
    db.close();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeMigration(name: string, sql: string): void {
    const dir = join(workDir, migrationsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "migration.sql"), sql);
  }

  test("true when every ADD COLUMN target already exists", async () => {
    writeMigration(
      "20260518000000_grant_plan_tier",
      `ALTER TABLE "workspace_grants"
  ADD COLUMN "planId" TEXT;
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260518000000_grant_plan_tier",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(true);
  });

  test("true for multi-column ADD COLUMN migration when all columns present", async () => {
    writeMigration(
      "20260520000000_project_publish_status",
      `ALTER TABLE "projects" ADD COLUMN "publishStatus" TEXT;
ALTER TABLE "projects" ADD COLUMN "publishError" TEXT;
ALTER TABLE "projects" ADD COLUMN "publishStatusAt" INTEGER;
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260520000000_project_publish_status",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(true);
  });

  test("false when ANY ADD COLUMN target is still missing", async () => {
    writeMigration(
      "20260601000000_partial",
      `ALTER TABLE "projects" ADD COLUMN "publishStatus" TEXT;
ALTER TABLE "projects" ADD COLUMN "newColumnNotYetApplied" TEXT;
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260601000000_partial",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    // Critical: even if SOME columns are present, we must NOT auto-resolve
    // — the migration genuinely needs to run for the missing columns.
    expect(ok).toBe(false);
  });

  test("false when migration contains a non-ADD-COLUMN statement", async () => {
    // A migration that mixes ADD COLUMN with CREATE INDEX could have
    // partial state we can't safely paper over by marking it applied —
    // the index might be missing even if every column is there.
    writeMigration(
      "20260602000000_add_with_index",
      `ALTER TABLE "workspace_grants" ADD COLUMN "planId" TEXT;
CREATE INDEX "workspace_grants_planId_idx" ON "workspace_grants"("planId");
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260602000000_add_with_index",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(false);
  });

  test("false for DROP COLUMN migrations even if the drop seemingly succeeded", async () => {
    writeMigration(
      "20260603000000_drop_legacy_field",
      `ALTER TABLE "workspace_grants" DROP COLUMN "legacyField";`,
    );
    const ok = await isMigrationFullyApplied(
      "20260603000000_drop_legacy_field",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(false);
  });

  test("false when the migration directory is missing", async () => {
    const ok = await isMigrationFullyApplied("does_not_exist", {
      rootDir: workDir,
      dbPath,
      migrationsDir,
    });
    expect(ok).toBe(false);
  });

  test("ignores SQL line comments — a `-- DROP TABLE` in a comment must not leak through as a non-ADD-COLUMN statement", async () => {
    writeMigration(
      "20260604000000_only_comment",
      `-- DROP TABLE projects;
-- This migration intentionally does nothing.
ALTER TABLE "workspace_grants" ADD COLUMN "planId" TEXT;
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260604000000_only_comment",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(true);
  });

  test("false for SQL injection-shaped identifiers — defence in depth around PRAGMA interpolation", async () => {
    writeMigration(
      "20260605000000_evil",
      `ALTER TABLE "workspace_grants'); DROP TABLE projects; --" ADD COLUMN "planId" TEXT;`,
    );
    const ok = await isMigrationFullyApplied(
      "20260605000000_evil",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(false);

    // Sanity: the projects table still exists. (If we'd interpolated
    // unsafely, PRAGMA would have errored — but the explicit identifier
    // shape check is the actual guard.)
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("projects");
    } finally {
      db.close();
    }
  });
});
