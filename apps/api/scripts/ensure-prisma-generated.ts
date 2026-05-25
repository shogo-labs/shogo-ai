// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pre-test guard: regenerate Prisma clients if `apps/api/src/generated/`
 * is missing. The generated dirs are .gitignored so a fresh clone or
 * `git clean -fd` wipes them. Without this, `bun test apps/api/...`
 * fails at module load with `Cannot find module '../generated/prisma-pg/client'`
 * (apps/api/src/lib/prisma.ts imports the generated PG types statically).
 *
 * Idempotent: exits 0 immediately if both PG + SQLite client.ts files
 * already exist, so the happy path adds ~5ms to the pretest hook.
 *
 * Wired via `pretest` / `pretest:coverage` in apps/api/package.json so
 * every entry point — local `bun run test`, the v3 coverage drain
 * (per-file via run-tests-isolated.ts), and the badge refresh (whole-
 * suite via scripts/run-all-tests.ts then per-package shards) — picks
 * it up without bespoke logic per call site.
 */

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')

const PG_CLIENT = resolve(REPO_ROOT, 'apps/api/src/generated/prisma-pg/client.ts')
const SQLITE_CLIENT = resolve(REPO_ROOT, 'apps/api/src/generated/prisma-sqlite/client.ts')

if (existsSync(PG_CLIENT) && existsSync(SQLITE_CLIENT)) {
  process.exit(0)
}

console.log('[ensure-prisma-generated] generated/prisma-pg or generated/prisma-sqlite missing — running db-generate-all')
const result = spawnSync('bun', ['scripts/db-generate-all.ts'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
