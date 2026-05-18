// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `backfillInstalls` baseline-manifest sourcing tests.
 *
 * Pre-fix `backfillInstalls` called `computeWorkspaceManifest(projectId)`,
 * which reads the local API-pod filesystem. On multi-pod k8s this is
 * (almost always) empty for legacy projects whose workspaces live on
 * warm-pool runtime pods. The empty `{}` baseline then poisoned every
 * subsequent `applyUpdate` call: drift detection flagged every file
 * in the new version as `added` and surfaced `drift_detected` to the
 * user, blocking updates unless they clicked "force overwrite".
 *
 * Post-fix the baseline is derived from the listing version's
 * snapshot (S3-first, jsonb-fallback) so it represents the
 * "as-of-install" file set, and an unmodified install's drift gate
 * reports zero changes.
 *
 * These tests pin that contract end-to-end through `runMigration`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── prisma stub ────────────────────────────────────────────────────

const stores: Record<string, Map<string, any>> = {}

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
        const matches = Object.entries(where).every(([k, v]) => {
          if (v && typeof v === 'object' && 'not' in (v as any)) {
            return (row as any)[k] !== (v as any).not
          }
          return (row as any)[k] === v
        })
        if (matches) return row
      }
      return null
    },
    findMany: async (args?: any) => {
      const where = args?.where ?? {}
      return Array.from(store.values()).filter((row) =>
        Object.entries(where).every(([k, v]) => {
          if (v && typeof v === 'object' && 'not' in (v as any)) {
            return (row as any)[k] !== (v as any).not
          }
          return (row as any)[k] === v
        }),
      )
    },
    create: async (args: any) => {
      const row = { id: `${name}_${++counter}`, ...args.data }
      const k = row[idField] ?? row.email ?? row.slug
      store.set(String(k), row)
      return row
    },
    update: async (args: any) => {
      const k = String(args.where[idField] ?? args.where.email ?? args.where.slug)
      const existing = store.get(k)
      if (!existing) throw new Error(`${name} not found`)
      Object.assign(existing, args.data)
      return existing
    },
    upsert: async (args: any) => {
      const k = String(args.where[idField] ?? args.where.email ?? args.where.slug)
      const existing = store.get(k)
      if (existing) {
        Object.assign(existing, args.update)
        return existing
      }
      const row = { id: `${name}_${++counter}`, ...args.create }
      store.set(k, row)
      return row
    },
    count: async () => store.size,
  }
}

const projectTable = tableOf('projects', 'id')
const listingTable = tableOf('listings', 'slug')
const versionTable = tableOf('versions', 'id')
const installTable = tableOf('installs', 'id')

const prismaStub: any = {
  user: tableOf('users', 'email'),
  workspace: tableOf('workspaces', 'slug'),
  creatorProfile: tableOf('creators', 'userId'),
  project: projectTable,
  marketplaceListing: listingTable,
  marketplaceListingVersion: versionTable,
  marketplaceInstall: installTable,
  workspaceMember: tableOf('members', 'id'),
  // The migration script accesses `prisma.member` (legacy WorkspaceMember
  // alias). Wired here so `ensureOfficialEntities` doesn't TypeError.
  member: tableOf('members', 'id'),
  agentConfig: tableOf('agentConfigs', 'id'),
  $transaction: async (fn: any) => fn(prismaStub),
  $disconnect: async () => undefined,
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

// snapshotProjectWorkspace returns the snapshot stored on the listing
// version. For these tests we don't care about the actual files; what
// matters is that backfillInstalls reads BACK that same snapshot to
// derive the baseline manifest.
const STUB_SNAPSHOT_FILES = {
  'src/index.ts': 'export const x = 1\n',
  'package.json': '{"name":"demo"}\n',
  'dist/index.html': '<html></html>\n',
}

mock.module('../services/marketplace-manifest.service', () => ({
  computeWorkspaceManifest: () => ({}),
  snapshotProjectWorkspace: () => ({ files: STUB_SNAPSHOT_FILES }),
  computeSnapshotManifest: (snapshot: any) => {
    // Real impl SHA256s each file; the test stub just maps
    // path → 'hash:<bytelength>' so we can assert determinism without
    // pulling in node:crypto here.
    const files = snapshot?.files ?? {}
    const out: Record<string, string> = {}
    for (const [path, content] of Object.entries(files as Record<string, string>)) {
      out[path] = `hash:${content.length}`
    }
    return out
  },
}))

let s3LoadCalls = 0
mock.module('../services/marketplace-snapshot-storage.service', () => ({
  loadSnapshotFiles: async (key: string) => {
    s3LoadCalls += 1
    if (key === 'missing-key') throw new Error('NoSuchKey')
    return STUB_SNAPSHOT_FILES
  },
}))

const { runMigration } = await import('../../scripts/migrate-templates-to-marketplace')

// ─── tmp templates dir ─────────────────────────────────────────────

let templatesRoot: string

beforeAll(() => {
  templatesRoot = mkdtempSync(join(tmpdir(), 'mig-baseline-'))
  mkdirSync(join(templatesRoot, 'demo-template'), { recursive: true })
  writeFileSync(
    join(templatesRoot, 'demo-template', 'template.json'),
    JSON.stringify({
      id: 'demo-template',
      name: 'Demo template',
      description: 'A test fixture',
    }),
  )
  writeFileSync(join(templatesRoot, 'demo-template', 'README.md'), '# Demo template')
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
  s3LoadCalls = 0
})

// ─── helpers ───────────────────────────────────────────────────────

const SEED_VERSION = '1.0.0'

interface SeedOpts {
  /** Whether the listing version has an S3 key populated. */
  hasS3Key?: boolean
  /** Whether the legacy jsonb workspaceSnapshot is set. */
  hasLegacySnapshot?: boolean
}

/**
 * Seed a legacy install scenario:
 *   - A `Project` with `templateId='demo-template'` (the legacy field).
 *   - A `MarketplaceListing` keyed by the same template id.
 *   - A `MarketplaceListingVersion` v1.0.0 with the requested snapshot
 *     storage shape (S3, legacy jsonb, or both).
 *
 * Returns the seeded project's id.
 */
async function seedLegacyInstall(opts: SeedOpts = {}): Promise<string> {
  const projectId = 'project_legacy_1'
  await projectTable.create({
    data: {
      id: projectId,
      workspaceId: 'ws_1',
      createdBy: 'user_1',
      templateId: 'demo-template',
    },
  })

  await listingTable.create({
    data: {
      slug: 'demo-template',
      templateId: 'demo-template',
      currentVersion: SEED_VERSION,
    },
  })
  // bridge slug → id used by templateIdToListing map
  const listingRow = await listingTable.findUnique({ where: { slug: 'demo-template' } })

  await versionTable.create({
    data: {
      id: 'version_1',
      listingId: listingRow.id,
      version: SEED_VERSION,
      workspaceSnapshot: opts.hasLegacySnapshot ? { files: STUB_SNAPSHOT_FILES } : null,
      workspaceSnapshotKey: opts.hasS3Key ? 's3-key/demo' : null,
      workspaceSnapshotChecksum: opts.hasS3Key ? 'sha256:stub' : null,
    },
  })

  return projectId
}

// ─── tests ─────────────────────────────────────────────────────────

describe('backfillInstalls — baseline manifest sourcing', () => {
  test('derives baselineManifest from S3 snapshot when workspaceSnapshotKey is set', async () => {
    await seedLegacyInstall({ hasS3Key: true, hasLegacySnapshot: false })

    await runMigration({ templatesDir: templatesRoot, quiet: true })

    const installs = Array.from(stores.installs.values())
    expect(installs).toHaveLength(1)
    const baseline = installs[0].baselineManifest as Record<string, string>

    // Manifest matches the file set returned by loadSnapshotFiles.
    expect(Object.keys(baseline).sort()).toEqual(
      Object.keys(STUB_SNAPSHOT_FILES).sort(),
    )
    expect(baseline['dist/index.html']).toBe(`hash:${STUB_SNAPSHOT_FILES['dist/index.html'].length}`)
    expect(s3LoadCalls).toBeGreaterThanOrEqual(1)
  })

  test('falls back to the legacy jsonb workspaceSnapshot when S3 key is missing', async () => {
    await seedLegacyInstall({ hasS3Key: false, hasLegacySnapshot: true })

    await runMigration({ templatesDir: templatesRoot, quiet: true })

    const installs = Array.from(stores.installs.values())
    expect(installs).toHaveLength(1)
    const baseline = installs[0].baselineManifest as Record<string, string>

    expect(Object.keys(baseline)).toContain('src/index.ts')
    // S3 was never consulted because workspaceSnapshotKey was null.
    expect(s3LoadCalls).toBe(0)
  })

  test('falls back to legacy jsonb when S3 download throws', async () => {
    await seedLegacyInstall({ hasS3Key: false, hasLegacySnapshot: true })
    // Override the version row to point at a missing key — exercises
    // the catch path in loadVersionBaselineManifest.
    const versionRow = Array.from(stores.versions.values())[0]
    versionRow.workspaceSnapshotKey = 'missing-key'
    versionRow.workspaceSnapshot = { files: STUB_SNAPSHOT_FILES }

    await runMigration({ templatesDir: templatesRoot, quiet: true })

    const installs = Array.from(stores.installs.values())
    expect(installs).toHaveLength(1)
    const baseline = installs[0].baselineManifest as Record<string, string>
    expect(Object.keys(baseline)).toContain('src/index.ts')
  })

  test('produces a NON-EMPTY baseline manifest (regression: empty {} blocked updates)', async () => {
    await seedLegacyInstall({ hasS3Key: true, hasLegacySnapshot: false })

    await runMigration({ templatesDir: templatesRoot, quiet: true })

    const installs = Array.from(stores.installs.values())
    const baseline = installs[0].baselineManifest as Record<string, string>
    expect(Object.keys(baseline).length).toBeGreaterThan(0)
  })

  // (The "neither S3 nor legacy snapshot" edge case isn't directly
  // testable through `runMigration` because the migration itself
  // creates a v1.0.0 version row with a non-null `workspaceSnapshot`
  // before backfill runs — there's no observable state where that
  // would actually be `null`. The defensive `applyUpdate` empty-check
  // fix is what protects against this prod-only shape; that's pinned
  // by the install-service drift-gate test.)
})
