// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the local SQLite migration doctor.
//
// The doctor shells out to a `bun` binary to run `bun:sqlite` scripts.
// Under `bun test` the test process IS bun, so `process.execPath` is a
// valid bun binary to drive the real shell-out path against synthesized
// databases (mirrors apps/desktop/test-db-recovery.ts).

import { describe, it, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  detectFailedMigrations,
  backupDatabase,
  repairFailedMigrations,
  runDatabaseDoctor,
  resolveDesktopDataDir,
  resolveDesktopDbPath,
  resolveBunBinary,
} from '../db-doctor.ts';

const BUN_PATH = process.execPath;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

interface SeedRow {
  name: string;
  startedAt: number;
  finishedAt: number | null;
  rolledBackAt?: number | null;
  logs?: string;
}

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-doctor-test-'));
  tempDirs.push(dir);
  return join(dir, 'shogo.db');
}

function seed(dbPath: string, rows: SeedRow[]): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE _prisma_migrations (
      id TEXT PRIMARY KEY,
      migration_name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      finished_at INTEGER,
      started_at INTEGER NOT NULL,
      rolled_back_at INTEGER,
      logs TEXT,
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  const stmt = db.prepare(
    'INSERT INTO _prisma_migrations (id, migration_name, checksum, started_at, finished_at, rolled_back_at, logs) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(randomUUID(), r.name, 'fake-checksum', r.startedAt, r.finishedAt, r.rolledBackAt ?? null, r.logs ?? null);
  }
  db.close();
}

describe('detectFailedMigrations', () => {
  it('finds the stuck row on a broken DB', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [
      { name: '0000_baseline', startedAt: 1000, finishedAt: 1100 },
      { name: '0001_bad', startedAt: 2000, finishedAt: null, logs: 'no such table: widgets' },
    ]);
    const failures = detectFailedMigrations(BUN_PATH, dbPath);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe('0001_bad');
    expect(failures[0]?.startedAt).toBe(2000);
    expect(failures[0]?.errorExcerpt).toContain('no such table: widgets');
  });

  it('returns [] for a healthy DB', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [{ name: '0000_baseline', startedAt: 1000, finishedAt: 1100 }]);
    expect(detectFailedMigrations(BUN_PATH, dbPath)).toHaveLength(0);
  });

  it('returns [] when the DB file does not exist', () => {
    expect(detectFailedMigrations(BUN_PATH, join(tmpdir(), `nope-${Date.now()}.db`))).toHaveLength(0);
  });
});

describe('runDatabaseDoctor', () => {
  it('reports no-database for a missing file', () => {
    const result = runDatabaseDoctor({
      bunPath: BUN_PATH,
      dbPath: join(tmpdir(), `missing-${Date.now()}.db`),
    });
    expect(result.status).toBe('no-database');
    expect(result.detected).toHaveLength(0);
  });

  it('is a no-op on a healthy DB', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [{ name: '0000_baseline', startedAt: 1000, finishedAt: 1100 }]);
    const result = runDatabaseDoctor({ bunPath: BUN_PATH, dbPath });
    expect(result.status).toBe('healthy');
    expect(result.backupPath).toBeUndefined();
    expect(result.cleared).toHaveLength(0);
  });

  it('backs up, clears the stuck row, and reports repaired', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [
      { name: 'good', startedAt: 1000, finishedAt: 1100 },
      { name: 'bad', startedAt: 2000, finishedAt: null, logs: 'oops' },
    ]);

    const result = runDatabaseDoctor({ bunPath: BUN_PATH, dbPath });

    expect(result.status).toBe('repaired');
    expect(result.detected.map((m) => m.name)).toEqual(['bad']);
    expect(result.cleared).toEqual(['bad']);
    expect(result.remaining).toHaveLength(0);
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(statSync(result.backupPath!).size).toBeGreaterThan(0);

    // The good row survives; the bad row is gone.
    const db = new Database(dbPath, { readonly: true });
    const names = (db.query('SELECT migration_name FROM _prisma_migrations').all() as Array<{ migration_name: string }>)
      .map((r) => r.migration_name);
    db.close();
    expect(names).toEqual(['good']);

    // Re-running is idempotent: now healthy.
    expect(runDatabaseDoctor({ bunPath: BUN_PATH, dbPath }).status).toBe('healthy');
  });

  it('honors skipBackup', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [{ name: 'bad', startedAt: 2000, finishedAt: null, logs: 'oops' }]);
    const result = runDatabaseDoctor({ bunPath: BUN_PATH, dbPath, skipBackup: true });
    expect(result.status).toBe('repaired');
    expect(result.backupPath).toBeUndefined();
  });
});

describe('backupDatabase / repairFailedMigrations', () => {
  it('produces a byte-faithful sibling backup', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [{ name: 'm1', startedAt: 1, finishedAt: 2 }]);
    const backupPath = backupDatabase(dbPath);
    expect(existsSync(backupPath)).toBe(true);
    expect(dirname(backupPath)).toBe(dirname(dbPath));
    expect(backupPath).toMatch(/\.bak-/);
    expect(statSync(backupPath).size).toBe(statSync(dbPath).size);
  });

  it('leaves already rolled-back rows alone', () => {
    const dbPath = makeDbPath();
    seed(dbPath, [{ name: 'rb', startedAt: 1000, finishedAt: null, rolledBackAt: 1200 }]);
    const deleted = repairFailedMigrations(BUN_PATH, dbPath, ['rb']);
    expect(deleted).toBe(0);
  });
});

describe('path / bun resolution', () => {
  it('resolveDesktopDbPath is shogo.db under the Shogo data dir', () => {
    expect(resolveDesktopDbPath()).toBe(join(resolveDesktopDataDir(), 'shogo.db'));
    expect(resolveDesktopDataDir()).toContain('Shogo');
  });

  it('resolveDesktopDataDir uses the platform app-data root', () => {
    const dir = resolveDesktopDataDir();
    if (process.platform === 'darwin') {
      expect(dir).toContain(join('Library', 'Application Support'));
    } else if (process.platform === 'win32') {
      // %APPDATA% (Roaming) — just assert it ends with the expected tail.
      expect(dir.endsWith(join('Shogo', 'data'))).toBe(true);
    } else {
      expect(dir).toContain(join('.config'));
    }
    expect(dir.startsWith(homedir()) || process.platform === 'win32').toBe(true);
  });

  it('resolveBunBinary returns the running bun and honors an explicit override', () => {
    // Under `bun test`, process.execPath is a usable bun.
    expect(resolveBunBinary()).toBe(process.execPath);
    expect(resolveBunBinary(process.execPath)).toBe(process.execPath);
    // A bogus override is rejected (null) rather than returned blindly.
    expect(resolveBunBinary(join(tmpdir(), 'definitely-not-bun'))).toBeNull();
  });
});
