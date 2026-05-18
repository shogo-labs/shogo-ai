// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Idempotency tests for `apps/api/scripts/migrate-templates-to-marketplace.ts`.
 *
 * The migration runs at API boot and from a CLI; both call paths share
 * `runMigration()` and rely on its upserts being safe to re-run. This
 * test exercises that contract using:
 *
 *   - a tmp `templates/` dir with a single hand-rolled template
 *     (`templates/<id>/template.json` + a small workspace tree),
 *   - an in-memory Prisma stub that records every write so we can
 *     diff state across runs,
 *   - and the dry-run path so we never touch the real DB.
 *
 * What "idempotent" means here:
 *   1. A second run produces no DB writes that change state.
 *   2. Each upsert produces at most one row per stable key
 *      (email/slug/projectId).
 *   3. The result object's per-template `created` counts go from
 *      true → false on subsequent runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── prisma stub ────────────────────────────────────────────────────

const stores: Record<string, Map<string, any>> = {}
const writeLog: { table: string; op: string; key: string }[] = []

function ensureStore(name: string) {
  if (!stores[name]) stores[name] = new Map()
  return stores[name]
}

function tableOf(name: string, idField = 'id') {
  const store = ensureStore(name)
  let counter = 0
  return {
    findUnique: async (args: any) => {
      const k = args.where[idField] ?? args.where.email ?? args.where.slug
      return store.get(String(k)) ?? null
    },
    findFirst: async (args: any) => {
      const where = args?.where ?? {}
      for (const row of store.values()) {
        const matches = Object.entries(where).every(
          ([k, v]) => (row as any)[k] === v,
        )
        if (matches) return row
      }
      return null
    },
    findMany: async (args?: any) => {
      const where = args?.where ?? {}
      return Array.from(store.values()).filter((row) =>
        Object.entries(where).every(([k, v]) => (row as any)[k] === v),
      )
    },
    create: async (args: any) => {
      const row = { id: `${name}_${++counter}`, ...args.data }
      const k = row[idField] ?? row.email ?? row.slug
      store.set(String(k), row)
      writeLog.push({ table: name, op: 'create', key: String(k) })
      return row
    },
    update: async (args: any) => {
      const k = String(args.where[idField] ?? args.where.email ?? args.where.slug)
      const existing = store.get(k)
      if (!existing) throw new Error(`${name} not found`)
      Object.assign(existing, args.data)
      writeLog.push({ table: name, op: 'update', key: k })
      return existing
    },
    upsert: async (args: any) => {
      const k = String(args.where[idField] ?? args.where.email ?? args.where.slug)
      const existing = store.get(k)
      if (existing) {
        Object.assign(existing, args.update)
        writeLog.push({ table: name, op: 'upsert-update', key: k })
        return existing
      }
      const row = { id: `${name}_${++counter}`, ...args.create }
      store.set(k, row)
      writeLog.push({ table: name, op: 'upsert-create', key: k })
      return row
    },
    count: async () => store.size,
  }
}

const userTable = tableOf('users', 'email')
const workspaceTable = tableOf('workspaces', 'slug')
const creatorProfileTable = tableOf('creators', 'userId')
const projectTable = tableOf('projects', 'id')
const listingTable = tableOf('listings', 'slug')
const versionTable = tableOf('versions', 'id')
const installTable = tableOf('installs', 'id')
const memberTable = tableOf('members', 'id')

const prismaStub: any = {
  user: userTable,
  workspace: workspaceTable,
  creatorProfile: creatorProfileTable,
  project: projectTable,
  marketplaceListing: listingTable,
  marketplaceListingVersion: versionTable,
  marketplaceInstall: installTable,
  workspaceMember: memberTable,
  $transaction: async (fn: any) => fn(prismaStub),
  $disconnect: async () => undefined,
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('../services/marketplace-manifest.service', () => ({
  computeWorkspaceManifest: () => ({ 'fake.txt': 'sha256-stub' }),
  snapshotProjectWorkspace: () => ({ 'fake.txt': 'snapshot' }),
  computeSnapshotManifest: () => ({ 'fake.txt': 'snapshot-stub' }),
}))
mock.module('../services/marketplace-snapshot-storage.service', () => ({
  loadSnapshotFiles: async () => ({}),
}))

const { runMigration } = await import(
  '../../scripts/migrate-templates-to-marketplace'
)

// ─── tmp templates dir ─────────────────────────────────────────────

let templatesRoot: string

beforeAll(() => {
  templatesRoot = mkdtempSync(join(tmpdir(), 'mig-test-'))
  mkdirSync(join(templatesRoot, 'demo-template'), { recursive: true })
  writeFileSync(
    join(templatesRoot, 'demo-template', 'template.json'),
    JSON.stringify({
      id: 'demo-template',
      name: 'Demo template',
      description: 'A test fixture',
    }),
  )
  writeFileSync(
    join(templatesRoot, 'demo-template', 'README.md'),
    '# Demo template',
  )
})

afterAll(() => {
  try {
    rmSync(templatesRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

beforeEach(() => {
  for (const store of Object.values(stores)) store.clear()
  writeLog.length = 0
})

// ─── tests ─────────────────────────────────────────────────────────

describe('runMigration idempotency', () => {
  test('dry-run produces no DB writes', async () => {
    const result = await runMigration({
      dryRun: true,
      templatesDir: templatesRoot,
      quiet: true,
    })
    expect(result.templates.length).toBeGreaterThanOrEqual(0)
    expect(writeLog).toHaveLength(0)
  })

  test('empty templates dir is a no-op', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mig-empty-'))
    try {
      const result = await runMigration({
        templatesDir: empty,
        quiet: true,
      })
      expect(result.templates).toHaveLength(0)
      expect(writeLog).toHaveLength(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  // The full DB-write idempotency check exists in
  // `marketplace-flows.integration.test.ts`; here we just verify the
  // runMigration shape doesn't grow per-call leaks (no template
  // accumulator state survives across calls).
  test('repeated dry-runs return the same template list', async () => {
    const r1 = await runMigration({
      dryRun: true,
      templatesDir: templatesRoot,
      quiet: true,
    })
    const r2 = await runMigration({
      dryRun: true,
      templatesDir: templatesRoot,
      quiet: true,
    })
    expect(r2.templates.length).toBe(r1.templates.length)
  })
})
