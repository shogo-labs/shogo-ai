// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `scripts/check-multiregion-cron-locks.ts`.
 *
 * The CI guard exists to catch the 2026-05-21 analytics_digests
 * poison-pill class at PR time — an in-process cron upserting on a
 * non-PK unique index in every region. The script's failure modes are
 * exactly what we want to lock down here:
 *
 *   1. Happy path: with the current repo state (3 locked crons, 1
 *      intentionally regional, all schema uniques classified) the
 *      check exits 0.
 *
 *   2. Cron-wrapper completeness: a cron that calls neither
 *      `withGlobalJobLock` nor appears in `INTENTIONALLY_REGIONAL`
 *      must fail with an actionable message.
 *
 *   3. INTENTIONALLY_REGIONAL claims a column that isn't in any
 *      @unique on the named model → must fail. Without this, an
 *      author could "fix" the analytics_digest poison-pill by writing
 *      the allowlist entry and dropping the @@unique in the same PR
 *      and the check would still pass.
 *
 *   4. Schema-uniques registry completeness: a new @unique in the
 *      schema that isn't in `ACCEPTED_UNIQUE_KEYS` must fail. This is
 *      the half that would have caught storage_usage at PR time.
 *
 *   5. Cross-registry consistency: a `cron_locked` allowlist entry
 *      that names a writer not in `KNOWN_JOB_IDS` must fail (catches
 *      a typo / rename that would silently bypass the guard).
 *
 *   6. Stale allowlist entries (a `cron_locked` entry whose model was
 *      deleted from the schema) must fail.
 *
 * The script is pure — no network, no fs writes — so we test it by
 * importing the per-check functions directly with synthetic
 * fixtures, plus one end-to-end run via `bun` against the real repo
 * to lock the happy-path result.
 */

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import {
  ACCEPTED_UNIQUE_KEYS,
  INTENTIONALLY_REGIONAL,
  HOME_REGION_PARTITIONED,
  parseSchema,
  enumerateCronEntries,
  findOutermostLockCall,
  readKnownJobIds,
  checkCronWrappers,
  checkIntentionallyRegionalSchema,
  checkHomeRegionPartitionedSchema,
  checkUniqueRegistry,
} from '../check-multiregion-cron-locks'

import * as ts from 'typescript'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')

// ===========================================================================
// End-to-end happy-path: the real repo currently passes.
// ===========================================================================

describe('check-multiregion-cron-locks (e2e, current repo state)', () => {
  test('exits 0 against the real repo', () => {
    const proc = spawnSync(
      'bun',
      ['scripts/check-multiregion-cron-locks.ts', '--quiet'],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    )
    if (proc.status !== 0) {
      // Surface the failure body so the assertion error is debuggable.
      throw new Error(
        `expected exit 0, got ${proc.status}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
      )
    }
    expect(proc.status).toBe(0)
  })

  test('discovers exactly the 4 known cron entry points', () => {
    const entries = enumerateCronEntries()
    const names = new Set(entries.map((e) => e.fn))
    expect(names.has('runGrantMonthlyRefill')).toBe(true)
    expect(names.has('runVoiceMonthlyRebill')).toBe(true)
    expect(names.has('recalculateAllStorageUsage')).toBe(true)
    expect(names.has('generateDigest')).toBe(true)
  })

  test('readKnownJobIds reads exactly the registered names from global-job-lock.ts', () => {
    const ids = readKnownJobIds()
    expect(ids.has('storage-recalculate-all')).toBe(true)
    expect(ids.has('voice-monthly-rebill')).toBe(true)
    // `grant-monthly-refill` is INTENTIONALLY NOT here anymore — the cron is
    // now home-region partitioned (lock-free), exempt via
    // HOME_REGION_PARTITIONED rather than lock-wrapped.
    expect(ids.has('grant-monthly-refill')).toBe(false)
    // `analytics-digest` is INTENTIONALLY NOT here — that cron is
    // exempt via INTENTIONALLY_REGIONAL.
    expect(ids.has('analytics-digest')).toBe(false)
    expect(ids.has('generateDigest')).toBe(false)
  })

  test('runGrantMonthlyRefill is registered as home-region partitioned', () => {
    const fns = new Set(HOME_REGION_PARTITIONED.map((r) => r.fn))
    expect(fns.has('runGrantMonthlyRefill')).toBe(true)
  })

  test('every wrapped cron resolves to a known job id (cross-registry)', () => {
    const ids = readKnownJobIds()
    const entries = enumerateCronEntries()
    const regional = new Set(INTENTIONALLY_REGIONAL.map((r) => r.fn))
    const partitioned = new Set(HOME_REGION_PARTITIONED.map((r) => r.fn))
    for (const entry of entries) {
      if (regional.has(entry.fn) || partitioned.has(entry.fn)) continue
      const arg = findOutermostLockCall(entry.node)
      expect(arg).not.toBeNull()
      if (arg) expect(ids.has(arg)).toBe(true)
    }
  })
})

// ===========================================================================
// findOutermostLockCall — AST extraction
// ===========================================================================

function parseFn(src: string): ts.FunctionDeclaration {
  const sf = ts.createSourceFile(
    'fixture.ts',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) return stmt
  }
  throw new Error('no function in fixture')
}

describe('findOutermostLockCall', () => {
  test('detects `const r = await withGlobalJobLock("foo", ...)` at top level', () => {
    const fn = parseFn(`
      export async function runFoo() {
        const r = await withGlobalJobLock('foo', async () => 1)
        return r
      }
    `)
    expect(findOutermostLockCall(fn)).toBe('foo')
  })

  test('detects bare `await withGlobalJobLock("foo", ...)` at top level', () => {
    const fn = parseFn(`
      export async function runFoo() {
        await withGlobalJobLock('foo', async () => { /* body */ })
      }
    `)
    expect(findOutermostLockCall(fn)).toBe('foo')
  })

  test('detects `return await withGlobalJobLock("foo", ...)`', () => {
    const fn = parseFn(`
      export async function runFoo() {
        return await withGlobalJobLock('foo', async () => 1)
      }
    `)
    expect(findOutermostLockCall(fn)).toBe('foo')
  })

  test('returns null when the call is nested inside an if-block (rejects evasion)', () => {
    const fn = parseFn(`
      export async function runFoo() {
        if (process.env.MAYBE === '1') {
          await withGlobalJobLock('foo', async () => { /* body */ })
        }
      }
    `)
    expect(findOutermostLockCall(fn)).toBeNull()
  })

  test('returns null when the call is inside a try/catch (rejects evasion)', () => {
    const fn = parseFn(`
      export async function runFoo() {
        try {
          await withGlobalJobLock('foo', async () => { /* body */ })
        } catch (e) { /* swallow */ }
      }
    `)
    expect(findOutermostLockCall(fn)).toBeNull()
  })

  test('returns null when the cron body has no lock call at all', () => {
    const fn = parseFn(`
      export async function runFoo() {
        await prisma.thing.upsert({ where: { id: 1 }, create: {}, update: {} })
      }
    `)
    expect(findOutermostLockCall(fn)).toBeNull()
  })

  test('returns null when wrapping function is a different name (e.g. typo)', () => {
    const fn = parseFn(`
      export async function runFoo() {
        await withGlobalJoblock('foo', async () => { /* body */ })
      }
    `)
    expect(findOutermostLockCall(fn)).toBeNull()
  })
})

// ===========================================================================
// checkCronWrappers — fixtures
// ===========================================================================

function mkCronEntry(src: string, fn: string, file = 'fixture.ts') {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  for (const stmt of sf.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name?.text === fn &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return {
        fn,
        file,
        line: 1,
        node: stmt as any,
      }
    }
  }
  throw new Error(`no exported function ${fn} found`)
}

describe('checkCronWrappers', () => {
  test('flags a cron that has no withGlobalJobLock call', () => {
    const entry = mkCronEntry(
      `export async function runRogue() { await prisma.foo.upsert({} as any) }`,
      'runRogue',
    )
    const v = checkCronWrappers([entry], new Set())
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].message).toContain('not wrapped in `withGlobalJobLock')
  })

  test('flags a cron whose lock name is missing from KNOWN_JOB_IDS', () => {
    const entry = mkCronEntry(
      `export async function runWithMystery() { await withGlobalJobLock('unregistered-job', async () => {}) }`,
      'runWithMystery',
    )
    const v = checkCronWrappers([entry], new Set(['some-other-job']))
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].message).toContain("'unregistered-job'")
    expect(v[0].message).toContain('KNOWN_JOB_IDS')
  })

  test('passes (no per-cron violations) when the lock name matches a KNOWN_JOB_IDS entry', () => {
    const entry = mkCronEntry(
      `export async function runOK() { const r = await withGlobalJobLock('happy-job', async () => 1); return r }`,
      'runOK',
    )
    const v = checkCronWrappers([entry], new Set(['happy-job']))
    // The reverse-direction "stale INTENTIONALLY_REGIONAL" check will
    // fire for `generateDigest` because this fixture doesn't include
    // it. Filter those out and assert the per-cron half is clean.
    const perCronViolations = v.filter(
      (x) => !x.message.includes('does not match any discovered cron entry'),
    )
    expect(perCronViolations).toEqual([])
  })

  test('passes when the cron is exempt via INTENTIONALLY_REGIONAL (file matches)', () => {
    // We can't mutate the real INTENTIONALLY_REGIONAL list, so we
    // verify the behaviour via the live `generateDigest` entry: the
    // real entry exempts it, so an entry referencing the real file
    // path with no lock call must pass.
    const live = enumerateCronEntries().find(
      (e) => e.fn === 'generateDigest',
    )
    expect(live).toBeDefined()
    const v = checkCronWrappers([live!], new Set())
    // The reverse-direction stale checks fire for the other allowlists
    // (INTENTIONALLY_REGIONAL / HOME_REGION_PARTITIONED entries not present in
    // this single-entry fixture). Filter those; assert the per-cron half — the
    // generateDigest exemption — is clean.
    const perCronViolations = v.filter(
      (x) => !x.message.includes('does not match any discovered cron entry'),
    )
    expect(perCronViolations).toEqual([])
  })
})

// ===========================================================================
// checkIntentionallyRegionalSchema — fixtures
// ===========================================================================

describe('checkIntentionallyRegionalSchema (live INTENTIONALLY_REGIONAL)', () => {
  test('passes against the real schema today', () => {
    const models = parseSchema(`${REPO_ROOT}/prisma/schema.prisma`)
    // Build modelToTable from the same source.
    const modelToTable = new Map<string, string>()
    const src = require('node:fs').readFileSync(
      `${REPO_ROOT}/prisma/schema.prisma`,
      'utf-8',
    ) as string
    const re = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const name = m[1]
      const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(m[2])
      modelToTable.set(name, mapMatch ? mapMatch[1] : name)
    }
    const v = checkIntentionallyRegionalSchema(models, modelToTable)
    expect(v).toEqual([])
  })

  test('fixture: a regional entry whose regionKeyColumn is not in any @@unique fails', () => {
    // Build a tiny synthetic schema that *contains* a model with the
    // column but NO @@unique on it; the check must detect the missing
    // enforcement.
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const schemaPath = join(tmp, 'schema.prisma')
      writeFileSync(
        schemaPath,
        `
model AnalyticsDigest {
  id     String @id @default(uuid())
  date   DateTime
  period String
  region String

  @@map("analytics_digests")
}
`,
      )
      const models = parseSchema(schemaPath)
      const modelToTable = new Map<string, string>([
        ['AnalyticsDigest', 'analytics_digests'],
      ])
      // Reuse the live INTENTIONALLY_REGIONAL entry which names
      // `analytics_digests.region` — and check that against a schema
      // where region exists but is NOT in @@unique. Must fail.
      const v = checkIntentionallyRegionalSchema(models, modelToTable)
      const regionMsg = v.find((x) => x.message.includes('NOT part of any @unique'))
      expect(regionMsg).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('fixture: a regional entry whose regionKeyColumn references a missing column fails', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const schemaPath = join(tmp, 'schema.prisma')
      writeFileSync(
        schemaPath,
        `
model AnalyticsDigest {
  id   String @id @default(uuid())
  date DateTime
  @@map("analytics_digests")
}
`,
      )
      const models = parseSchema(schemaPath)
      const modelToTable = new Map<string, string>([
        ['AnalyticsDigest', 'analytics_digests'],
      ])
      const v = checkIntentionallyRegionalSchema(models, modelToTable)
      const missingCol = v.find((x) =>
        x.message.includes('is not declared on'),
      )
      expect(missingCol).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// checkHomeRegionPartitionedSchema — fixtures
// ===========================================================================

describe('checkHomeRegionPartitionedSchema (live HOME_REGION_PARTITIONED)', () => {
  test('passes against the real schema today', () => {
    const models = parseSchema(`${REPO_ROOT}/prisma/schema.prisma`)
    const modelToTable = new Map<string, string>()
    const src = require('node:fs').readFileSync(
      `${REPO_ROOT}/prisma/schema.prisma`,
      'utf-8',
    ) as string
    const re = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const name = m[1]
      const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(m[2])
      modelToTable.set(name, mapMatch ? mapMatch[1] : name)
    }
    const v = checkHomeRegionPartitionedSchema(models, modelToTable)
    expect(v).toEqual([])
  })

  test('fixture: a partitioned entry whose partitionKeyColumn is missing fails', () => {
    // Real HOME_REGION_PARTITIONED names `Workspace.homeRegion`. Build a
    // synthetic Workspace model WITHOUT that column and confirm the check
    // reports it as undeclared. (Unlike the regional check, no @@unique is
    // required — safety is the runtime disjoint-partition property.)
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const schemaPath = join(tmp, 'schema.prisma')
      writeFileSync(
        schemaPath,
        `
model Workspace {
  id   String @id @default(uuid())
  slug String @unique
}
`,
      )
      const models = parseSchema(schemaPath)
      const modelToTable = new Map<string, string>([['Workspace', 'Workspace']])
      const v = checkHomeRegionPartitionedSchema(models, modelToTable)
      const missing = v.find((x) => x.message.includes('is not declared on'))
      expect(missing).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// checkUniqueRegistry — fixtures
// ===========================================================================

describe('checkUniqueRegistry', () => {
  test('flags a new unique not in ACCEPTED_UNIQUE_KEYS', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const schemaPath = join(tmp, 'schema.prisma')
      writeFileSync(
        schemaPath,
        `
model NewThing {
  id    String @id @default(uuid())
  email String @unique
  @@map("new_things")
}
`,
      )
      const models = parseSchema(schemaPath)
      const v = checkUniqueRegistry(models, new Set())
      const unclassified = v.find((x) =>
        x.message.includes('`NewThing.email`'),
      )
      expect(unclassified).toBeDefined()
      expect(unclassified!.message).toContain('not classified')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('flags a cron_locked rule whose writer is not in KNOWN_JOB_IDS', () => {
    // Synthesise a schema that matches one of the real rules so we can
    // exercise the cross-registry path without inventing a new model.
    // The live rule for `StorageUsage.workspaceId` is cron_locked
    // pointing at `storage-recalculate-all`. We pass an empty
    // knownJobIds and expect the cross-check to fire.
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const schemaPath = join(tmp, 'schema.prisma')
      writeFileSync(
        schemaPath,
        `
model StorageUsage {
  id          String @id @default(uuid())
  workspaceId String @unique
  @@map("storage_usage")
}
`,
      )
      const models = parseSchema(schemaPath)
      const v = checkUniqueRegistry(models, new Set())
      const missingWriter = v.find((x) =>
        x.message.includes('not in KNOWN_JOB_IDS'),
      )
      expect(missingWriter).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('flags a stale ACCEPTED_UNIQUE_KEYS entry that no longer matches any schema unique', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const schemaPath = join(tmp, 'schema.prisma')
      // Schema with ZERO uniques at all -> every ACCEPTED entry is stale.
      writeFileSync(schemaPath, `model OnlyId { id String @id @default(uuid()) }`)
      const models = parseSchema(schemaPath)
      const v = checkUniqueRegistry(models, new Set())
      const stale = v.find((x) => x.message.includes('does not match'))
      expect(stale).toBeDefined()
      // sanity: should report many stale entries when comparing live
      // ACCEPTED list against an empty schema.
      const staleCount = v.filter((x) =>
        x.message.includes('does not match any @unique'),
      ).length
      expect(staleCount).toBe(ACCEPTED_UNIQUE_KEYS.length)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// Schema parser — small sanity tests so a parser regression surfaces here
// rather than as a cascade of misleading allowlist failures.
// ===========================================================================

describe('parseSchema', () => {
  test('captures @unique on individual fields', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const p = join(tmp, 'schema.prisma')
      writeFileSync(
        p,
        `model A {
  id    String @id @default(uuid())
  email String @unique
}`,
      )
      const models = parseSchema(p)
      const a = models.get('A')!
      expect(a.uniques.map((u) => u.key)).toEqual(['A.email'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('captures @@unique([a, b]) and sorts columns alphabetically', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const p = join(tmp, 'schema.prisma')
      writeFileSync(
        p,
        `model B {
  id String @id @default(uuid())
  x  String
  y  String
  @@unique([y, x])
}`,
      )
      const models = parseSchema(p)
      const b = models.get('B')!
      expect(b.uniques).toHaveLength(1)
      expect(b.uniques[0].key).toBe('B.(x,y)')
      expect(b.uniques[0].columns).toEqual(['x', 'y'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('ignores @unique-looking text inside comments', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'check-mr-'))
    try {
      const p = join(tmp, 'schema.prisma')
      writeFileSync(
        p,
        `model C {
  id  String @id @default(uuid())
  // NOTE: previously had @unique here; removed.
  foo String
}`,
      )
      const models = parseSchema(p)
      const c = models.get('C')!
      expect(c.uniques).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
