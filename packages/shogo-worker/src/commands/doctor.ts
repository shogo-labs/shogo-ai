// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo doctor` — diagnose and repair a wedged local Shogo database.
 *
 *   shogo doctor                 — detect + (with confirmation) repair
 *   shogo doctor --check         — detect only, never mutate
 *   shogo doctor --yes           — repair without the confirmation prompt
 *   shogo doctor --db <path>     — target a specific shogo.db
 *   shogo doctor --bun <path>    — use a specific bun binary
 *   shogo doctor --no-backup     — skip the pre-repair backup (discouraged)
 *
 * Clears `_prisma_migrations` rows left in a failed (P3009) state so the
 * desktop app can re-apply migrations on its next launch. Always backs up
 * the database first unless `--no-backup` is passed.
 */
import { createInterface } from 'node:readline';
import pc from 'picocolors';
import {
  detectFailedMigrations,
  runDatabaseDoctor,
  resolveDesktopDbPath,
  resolveBunBinary,
  type FailedMigration,
} from '../lib/db-doctor.ts';

export interface DoctorFlags {
  check?: boolean;
  yes?: boolean;
  db?: string;
  bun?: string;
  backup?: boolean; // commander sets `backup: false` for --no-backup
}

function printFailures(failures: FailedMigration[]): void {
  for (const f of failures) {
    const when = Number.isFinite(f.startedAt) ? new Date(f.startedAt).toISOString() : 'unknown time';
    const firstLine = (f.errorExcerpt ?? '').split('\n')[0]?.trim();
    console.log(`  ${pc.yellow('•')} ${pc.bold(f.name)} ${pc.dim(`(attempted ${when})`)}`);
    if (firstLine) console.log(`    ${pc.dim(firstLine)}`);
  }
}

async function confirm(question: string): Promise<boolean> {
  // Non-interactive (CI, piped) stdin: refuse rather than hang.
  if (!process.stdin.isTTY) {
    console.log(pc.dim('(stdin is not a TTY — re-run with --yes to repair non-interactively)'));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runDoctor(flags: DoctorFlags = {}): Promise<void> {
  const dbPath = flags.db ?? resolveDesktopDbPath();
  const bunPath = resolveBunBinary(flags.bun);

  if (!bunPath) {
    throw new Error(
      'Could not find a usable `bun` binary (needed to inspect the SQLite database).\n' +
        '  • Install Bun (https://bun.sh) so `bun` is on your PATH, or\n' +
        '  • pass --bun <path> pointing at the bun shipped inside the Shogo app\n' +
        "    (e.g. /Applications/Shogo.app/Contents/Resources/bun/bun on macOS).",
    );
  }

  console.log(pc.dim(`Database: ${dbPath}`));
  console.log(pc.dim(`Bun:      ${bunPath}`));
  console.log();

  const failures = detectFailedMigrations(bunPath, dbPath);

  if (failures.length === 0) {
    console.log(pc.green('✓ No failed migrations detected — your local database looks healthy.'));
    return;
  }

  console.log(pc.red(`✗ Found ${failures.length} failed migration(s):`));
  printFailures(failures);
  console.log();

  if (flags.check) {
    console.log(
      pc.dim('Run `shogo doctor` (without --check) to back up the database and clear these records.'),
    );
    // Signal "needs repair" to scripts/CI without throwing a stack trace.
    process.exitCode = 1;
    return;
  }

  if (!flags.yes) {
    const backupNote =
      flags.backup === false
        ? pc.red('This will NOT create a backup (--no-backup).')
        : 'Your database will be backed up to a .bak-<timestamp> file first.';
    console.log(backupNote);
    const ok = await confirm(pc.bold('Clear these failed migration records and repair? [y/N] '));
    if (!ok) {
      console.log(pc.dim('Aborted — no changes made.'));
      process.exitCode = 1;
      return;
    }
    console.log();
  }

  const result = runDatabaseDoctor({
    bunPath,
    dbPath,
    skipBackup: flags.backup === false,
    log: (line) => console.log(pc.dim(`  ${line}`)),
  });

  console.log();
  if (result.status === 'repaired') {
    console.log(pc.green(`✓ ${result.message}`));
    if (result.backupPath) console.log(pc.dim(`  Backup: ${result.backupPath}`));
    console.log(pc.bold('\n  → Relaunch the Shogo app to finish applying migrations.'));
  } else {
    console.log(pc.red(`✗ ${result.message}`));
    if (result.backupPath) console.log(pc.dim(`  Backup: ${result.backupPath}`));
    process.exitCode = 1;
  }
}
