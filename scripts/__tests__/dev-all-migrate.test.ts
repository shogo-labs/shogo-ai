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
  findStuckMigrations,
  isMigrationFullyApplied,
  parseDuplicateColumnFailure,
  parseRecoverableFailure,
  planMigrationObjects,
  resolveLocalDbPath,
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

  test("false when a created index from an ADD COLUMN + CREATE INDEX migration is missing", async () => {
    // Column is present but the index was never created (interrupted between
    // the two statements) — we must NOT mark it applied.
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

  test("true when both the added column AND its index are present", async () => {
    const db = new Database(dbPath);
    db.run(
      `CREATE INDEX "workspace_grants_planId_idx" ON "workspace_grants"("planId")`,
    );
    db.close();
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
    expect(ok).toBe(true);
  });

  test("true for a CREATE TABLE migration when the table already exists", async () => {
    const db = new Database(dbPath);
    db.run(`CREATE TABLE "chat_session_projects" ("id" TEXT PRIMARY KEY)`);
    db.close();
    writeMigration(
      "20260606000000_create_join_table",
      `CREATE TABLE "chat_session_projects" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL
);
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260606000000_create_join_table",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(true);
  });

  test("false for a CREATE TABLE migration when the table is still missing", async () => {
    writeMigration(
      "20260606000001_create_missing_table",
      `CREATE TABLE "not_created_yet" ("id" TEXT PRIMARY KEY);`,
    );
    const ok = await isMigrationFullyApplied(
      "20260606000001_create_missing_table",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(false);
  });

  test("true for the SQLite table-rebuild idiom once the rebuild has finished", async () => {
    // Simulate a completed RedefineTables: `projects` already has the new
    // `archivedAt` column and the transient `new_projects` is gone.
    const db = new Database(dbPath);
    db.run(`ALTER TABLE "projects" ADD COLUMN "archivedAt" DATETIME`);
    db.run(
      `CREATE INDEX "projects_archivedAt_idx" ON "projects"("archivedAt")`,
    );
    db.close();
    writeMigration(
      "20260607000000_rebuild_projects",
      `PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_projects" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "publishStatus" TEXT,
  "publishError" TEXT,
  "publishStatusAt" INTEGER,
  "archivedAt" DATETIME
);
INSERT INTO "new_projects" ("id") SELECT "id" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
CREATE INDEX "projects_archivedAt_idx" ON "projects"("archivedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260607000000_rebuild_projects",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(true);
  });

  test("false for the table-rebuild idiom when the transient new_* table is left behind", async () => {
    // Interrupted mid-rebuild: `new_projects` still exists, so the rename
    // never happened — re-running is required.
    const db = new Database(dbPath);
    db.run(`CREATE TABLE "new_projects" ("id" TEXT PRIMARY KEY)`);
    db.close();
    writeMigration(
      "20260607000001_rebuild_interrupted",
      `CREATE TABLE "new_projects" ("id" TEXT NOT NULL PRIMARY KEY, "archivedAt" DATETIME);
INSERT INTO "new_projects" ("id") SELECT "id" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260607000001_rebuild_interrupted",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(false);
  });

  test("true for ADD COLUMN + seed UPDATE when the column is present (data not verified)", async () => {
    writeMigration(
      "20260608000000_add_col_and_seed",
      `ALTER TABLE "workspace_grants" ADD COLUMN "planId" TEXT;
UPDATE "workspace_grants" SET "planId" = 'free' WHERE "planId" IS NULL;
`,
    );
    const ok = await isMigrationFullyApplied(
      "20260608000000_add_col_and_seed",
      { rootDir: workDir, dbPath, migrationsDir },
    );
    expect(ok).toBe(true);
  });

  test("false for a standalone DROP TABLE (destructive, not a rebuild)", async () => {
    writeMigration(
      "20260609000000_drop_table",
      `DROP TABLE "projects";`,
    );
    const ok = await isMigrationFullyApplied(
      "20260609000000_drop_table",
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

describe("parseRecoverableFailure", () => {
  test("P3018 duplicate-column names the single failing migration", () => {
    const stderr = `Applying migration \`20260530053000_add_rolling_usage_windows\`
Error: P3018

Migration name: 20260530053000_add_rolling_usage_windows

Database error:
duplicate column name: fiveHourWindowStart`;
    expect(parseRecoverableFailure(stderr)).toEqual({
      migrationNames: ["20260530053000_add_rolling_usage_windows"],
    });
  });

  test("P3018 `table already exists` is also recoverable", () => {
    const stderr = `Error: P3018

Migration name: 20260531063135_add_workspace_chat_sessions

Database error:
table "chat_session_projects" already exists in -- Migration: …`;
    expect(parseRecoverableFailure(stderr)).toEqual({
      migrationNames: ["20260531063135_add_workspace_chat_sessions"],
    });
  });

  test("P3018 with a non-recoverable cause (NOT NULL) returns null", () => {
    const stderr = `Error: P3018
Migration name: 20260101000000_add_required_field
Database error:
NOT NULL constraint failed: projects.requiredField`;
    expect(parseRecoverableFailure(stderr)).toBeNull();
  });

  test("P3009 extracts the single failed migration from the ledger", () => {
    const stderr = `Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied.
The \`20260530202030_affiliate_secondary_rate\` migration started at 2026-06-02 21:32:10.978 UTC failed`;
    expect(parseRecoverableFailure(stderr)).toEqual({
      migrationNames: ["20260530202030_affiliate_secondary_rate"],
    });
  });

  test("P3009 extracts and de-dupes multiple failed migrations", () => {
    const stderr = `Error: P3009
The \`20260525000000_add_affiliate_system\` migration started at 2026-06-01 10:00:00 UTC failed
The \`20260530053000_add_rolling_usage_windows\` migration started at 2026-06-02 21:28:53 UTC failed
The \`20260525000000_add_affiliate_system\` migration started at 2026-06-01 10:00:00 UTC failed`;
    expect(parseRecoverableFailure(stderr)).toEqual({
      migrationNames: [
        "20260525000000_add_affiliate_system",
        "20260530053000_add_rolling_usage_windows",
      ],
    });
  });

  test("unrelated errors (engine down, empty) return null", () => {
    expect(parseRecoverableFailure("Error: P1001\nCan't reach database server")).toBeNull();
    expect(parseRecoverableFailure("")).toBeNull();
  });
});

describe("resolveLocalDbPath", () => {
  const rootDir = "/repo/root";

  test("prefers DATABASE_URL over the config default", () => {
    expect(resolveLocalDbPath({ rootDir, databaseUrl: "file:./shogo-local.db" })).toBe(
      "/repo/root/shogo-local.db",
    );
  });

  test("strips a bare `file:` prefix without `./`", () => {
    expect(resolveLocalDbPath({ rootDir, databaseUrl: "file:shogo.db" })).toBe(
      "/repo/root/shogo.db",
    );
  });

  test("keeps absolute file paths as-is", () => {
    expect(resolveLocalDbPath({ rootDir, databaseUrl: "file:/var/data/shogo.db" })).toBe(
      "/var/data/shogo.db",
    );
  });

  test("drops a query-string suffix defensively", () => {
    expect(
      resolveLocalDbPath({ rootDir, databaseUrl: "file:./shogo.db?connection_limit=1" }),
    ).toBe("/repo/root/shogo.db");
  });

  test("falls back to the config default when no URL is given", () => {
    expect(resolveLocalDbPath({ rootDir, databaseUrl: "" })).toBe("/repo/root/shogo.db");
  });
});

describe("planMigrationObjects", () => {
  test("models ADD COLUMN targets", () => {
    const plan = planMigrationObjects(
      `ALTER TABLE "usage_wallets" ADD COLUMN "fiveHourWindowStart" DATETIME;
ALTER TABLE "usage_wallets" ADD COLUMN "weeklyUsedUsd" REAL NOT NULL DEFAULT 0;`,
    );
    expect(plan).not.toBeNull();
    expect(plan!.columns).toEqual([
      { table: "usage_wallets", column: "fiveHourWindowStart" },
      { table: "usage_wallets", column: "weeklyUsedUsd" },
    ]);
    expect(plan!.tablesPresent).toEqual(["usage_wallets"]);
    expect(plan!.hasDataStatements).toBe(false);
  });

  test("models CREATE TABLE + CREATE INDEX", () => {
    const plan = planMigrationObjects(
      `CREATE TABLE "chat_session_projects" ("id" TEXT NOT NULL PRIMARY KEY);
CREATE UNIQUE INDEX "chat_session_projects_sessionId_projectId_key" ON "chat_session_projects"("sessionId", "projectId");`,
    );
    expect(plan).not.toBeNull();
    expect(plan!.tablesPresent).toEqual(["chat_session_projects"]);
    expect(plan!.indexesPresent).toEqual([
      "chat_session_projects_sessionId_projectId_key",
    ]);
  });

  test("collapses the table-rebuild idiom to its net effect", () => {
    const plan = planMigrationObjects(
      `CREATE TABLE "new_chat_sessions" ("id" TEXT NOT NULL PRIMARY KEY, "workspaceId" TEXT);
INSERT INTO "new_chat_sessions" ("id") SELECT "id" FROM "chat_sessions";
DROP TABLE "chat_sessions";
ALTER TABLE "new_chat_sessions" RENAME TO "chat_sessions";
CREATE INDEX "chat_sessions_workspaceId_idx" ON "chat_sessions"("workspaceId");`,
    );
    expect(plan).not.toBeNull();
    expect(plan!.tablesPresent).toContain("chat_sessions");
    expect(plan!.tablesPresent).not.toContain("new_chat_sessions");
    expect(plan!.tablesAbsent).toEqual(["new_chat_sessions"]);
    expect(plan!.indexesPresent).toEqual(["chat_sessions_workspaceId_idx"]);
    // The INSERT … SELECT row-copy is part of the rebuild, not a seed.
    expect(plan!.hasDataStatements).toBe(false);
  });

  test("flags seed UPDATE/INSERT as data statements", () => {
    const plan = planMigrationObjects(
      `ALTER TABLE "affiliate_commission_tiers" ADD COLUMN "secondaryRateBps" INTEGER;
UPDATE "affiliate_commission_tiers" SET "secondaryRateBps" = 1000 WHERE "level" = 1;`,
    );
    expect(plan).not.toBeNull();
    expect(plan!.hasDataStatements).toBe(true);
  });

  test("returns null for DROP COLUMN", () => {
    expect(
      planMigrationObjects(`ALTER TABLE "workspace_grants" DROP COLUMN "legacyField";`),
    ).toBeNull();
  });

  test("returns null for a standalone DROP TABLE (no matching rebuild rename)", () => {
    expect(planMigrationObjects(`DROP TABLE "projects";`)).toBeNull();
  });

  test("returns null for unmodelled DDL (CREATE TRIGGER)", () => {
    expect(
      planMigrationObjects(
        `CREATE TRIGGER "t" AFTER INSERT ON "projects" BEGIN SELECT 1; END;`,
      ),
    ).toBeNull();
  });
});

describe("findStuckMigrations", () => {
  let workDir: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dev-all-stuck-"));
    dbPath = join(workDir, "shogo.db");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function seedLedger(): Database {
    const db = new Database(dbPath);
    db.run(`CREATE TABLE "_prisma_migrations" (
      id TEXT PRIMARY KEY,
      migration_name TEXT NOT NULL,
      started_at DATETIME,
      finished_at DATETIME,
      rolled_back_at DATETIME
    )`);
    return db;
  }

  test("returns [] when the DB file does not exist", async () => {
    expect(await findStuckMigrations(join(workDir, "nope.db"))).toEqual([]);
  });

  test("returns [] when there is no _prisma_migrations table", async () => {
    const db = new Database(dbPath);
    db.run(`CREATE TABLE "unrelated" (id TEXT)`);
    db.close();
    expect(await findStuckMigrations(dbPath)).toEqual([]);
  });

  test("returns only started-but-unfinished, non-rolled-back rows, ordered by started_at", async () => {
    const db = seedLedger();
    db.run(
      `INSERT INTO _prisma_migrations VALUES ('1','done', '2026-01-01', '2026-01-01', NULL)`,
    );
    db.run(
      `INSERT INTO _prisma_migrations VALUES ('2','rolled_back', '2026-01-02', NULL, '2026-01-02')`,
    );
    db.run(
      `INSERT INTO _prisma_migrations VALUES ('3','stuck_later', '2026-01-04', NULL, NULL)`,
    );
    db.run(
      `INSERT INTO _prisma_migrations VALUES ('4','stuck_earlier', '2026-01-03', NULL, NULL)`,
    );
    db.close();
    expect(await findStuckMigrations(dbPath)).toEqual([
      "stuck_earlier",
      "stuck_later",
    ]);
  });
});
