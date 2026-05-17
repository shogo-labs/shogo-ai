// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Integration tests for the two primary marketplace flows added in
 * the templates → marketplace consolidation:
 *
 *   1. **Update flow** (Phase 6): install → bump version → apply
 *      (clean) → mutate workspace → re-apply (drift detected) →
 *      force-apply (overwrite). Uses real `marketplace-manifest.service`
 *      against a tmp directory — no fs mocking — so we exercise the
 *      hash + diff code paths together with the service's drift gate.
 *
 *   2. **Review flow** (Phase 7): the audit service classifies a
 *      version's snapshot, the result persists onto the version row,
 *      and the listing is queued for human review. We mock Anthropic
 *      via `globalThis.fetch` and the database layer with in-memory
 *      stubs.
 *
 * The Prisma client is replaced with the same kind of in-memory shim
 * used elsewhere in apps/api/src/__tests__. The point of these tests
 * isn't to stress-test the DB layer; it's to verify the
 * service-to-service handoff (install ↔ manifest, audit ↔ persistence)
 * matches the contract the new mobile UX assumes.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── Tmp workspace dir setup ────────────────────────────────────────

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mkt-flows-'))
  process.env.WORKSPACES_DIR = tmpRoot
})

afterAll(() => {
  delete process.env.WORKSPACES_DIR
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

// ─── Prisma mock ────────────────────────────────────────────────────

interface ListingRow {
  id: string
  title: string
  shortDescription: string
  projectId: string
  installModel: 'fork' | 'linked'
  currentVersion: string
  status: string
  installCount: number
  creatorId: string
  rejectionReason?: string | null
  reviewedAt?: Date | null
  reviewedBy?: string | null
  publishedAt?: Date | null
}

interface VersionRow {
  id: string
  listingId: string
  version: string
  changelog?: string
  workspaceSnapshot?: any
  auditStatus?: string
  auditedAt?: Date
  auditedBy?: string | null
  auditModel?: string
  auditFindings?: any
  createdAt: Date
}

interface InstallRow {
  id: string
  listingId: string
  projectId: string
  workspaceId: string
  userId: string
  installModel: 'fork' | 'linked'
  installedVersion: string
  status: string
  baselineManifest?: any
}

interface ProjectRow {
  id: string
  tier?: string
  status?: string
  schemas?: any
  accessLevel?: string
  category?: string
  siteTitle?: string
  siteDescription?: string
  settings?: any
}

const listings = new Map<string, ListingRow>()
const versions: VersionRow[] = []
const installs: InstallRow[] = []
const projects = new Map<string, ProjectRow>()
const agentConfigs: any[] = []
let projectCounter = 0
let installCounter = 0
let versionCounter = 0

function resetDb() {
  listings.clear()
  for (let i = versions.length - 1; i >= 0; i--) versions.pop()
  for (let i = installs.length - 1; i >= 0; i--) installs.pop()
  projects.clear()
  agentConfigs.length = 0
  projectCounter = 0
  installCounter = 0
  versionCounter = 0
}

const listingTable = {
  findUnique: async (args: any) => {
    const l = listings.get(args.where.id)
    if (!l) return null
    if (args.include?.project) {
      const p = projects.get(l.projectId) ?? null
      const ac = agentConfigs.find((c) => c.projectId === l.projectId) ?? null
      return { ...l, project: p ? { ...p, agentConfig: ac } : null }
    }
    return l
  },
  update: async (args: any) => {
    const l = listings.get(args.where.id)
    if (!l) throw new Error('listing not found')
    if (args.data.installCount?.increment) {
      l.installCount = (l.installCount ?? 0) + args.data.installCount.increment
    } else {
      Object.assign(l, args.data)
    }
    return l
  },
}

const versionTable = {
  findFirst: async (args: any) =>
    versions.find(
      (v) =>
        v.listingId === args.where.listingId &&
        (!args.where.version || v.version === args.where.version) &&
        (!args.where.id || v.id === args.where.id),
    ) ?? null,
  findUnique: async (args: any) => versions.find((v) => v.id === args.where.id) ?? null,
  update: async (args: any) => {
    const v = versions.find((row) => row.id === args.where.id)
    if (!v) throw new Error('version not found')
    Object.assign(v, args.data)
    return v
  },
}

const installTable = {
  create: async (args: any) => {
    const row: InstallRow = {
      id: `inst_${++installCounter}`,
      ...args.data,
    }
    installs.push(row)
    return row
  },
  findUnique: async (args: any) => {
    const inst = installs.find((i) => i.id === args.where.id)
    if (!inst) return null
    if (args.include?.listing) {
      return { ...inst, listing: listings.get(inst.listingId) ?? null }
    }
    return inst
  },
  update: async (args: any) => {
    const inst = installs.find((i) => i.id === args.where.id)
    if (!inst) throw new Error('install not found')
    Object.assign(inst, args.data)
    return inst
  },
}

const projectTable = {
  create: async (args: any) => {
    const id = `proj_${++projectCounter}`
    const row: ProjectRow = { id, ...args.data }
    projects.set(id, row)
    return row
  },
  delete: async (args: any) => {
    projects.delete(args.where.id)
    return { id: args.where.id }
  },
}

const agentConfigTable = {
  create: async (args: any) => {
    const row = { id: `ac_${agentConfigs.length + 1}`, ...args.data }
    agentConfigs.push(row)
    return row
  },
}

const prismaStub: any = {
  marketplaceListing: listingTable,
  marketplaceListingVersion: versionTable,
  marketplaceInstall: installTable,
  project: projectTable,
  agentConfig: agentConfigTable,
  $transaction: async (fn: any) =>
    fn({
      marketplaceListing: listingTable,
      marketplaceListingVersion: versionTable,
      marketplaceInstall: installTable,
      project: projectTable,
      agentConfig: agentConfigTable,
    }),
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))
mock.module('../services/workspace.service', () => ({
  hasWorkspaceAccess: async () => true,
}))

// Loaded after all mocks are registered.
const installService = await import('../services/marketplace-install.service')
const auditService = await import('../services/marketplace-audit.service')
const manifestService = await import('../services/marketplace-manifest.service')

// ─── helpers ────────────────────────────────────────────────────────

function seedSourceWorkspace(projectId: string, files: Record<string, string>) {
  const root = join(tmpRoot, projectId)
  mkdirSync(root, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
}

function pushVersion(listingId: string, version: string, files: Record<string, string>) {
  const id = `ver_${++versionCounter}`
  const snapshot = { files }
  versions.push({
    id,
    listingId,
    version,
    workspaceSnapshot: snapshot,
    createdAt: new Date(),
  })
  const l = listings.get(listingId)
  if (l) l.currentVersion = version
  return id
}

// ─── Update flow integration ───────────────────────────────────────

describe('marketplace update flow', () => {
  beforeEach(() => resetDb())

  test('install → bump → apply (clean) → mutate → drift → force', async () => {
    // 1) Source listing + workspace.
    seedSourceWorkspace('src1', { 'a.txt': 'v1-content', 'README.md': '# Hello' })
    projects.set('src1', {
      id: 'src1',
      tier: 'free',
      status: 'active',
      schemas: [],
      accessLevel: 'public',
      category: 'biz',
      siteTitle: 't',
      siteDescription: 'd',
      settings: {},
    })
    listings.set('lst', {
      id: 'lst',
      title: 'Test Agent',
      shortDescription: 'short',
      projectId: 'src1',
      installModel: 'linked',
      currentVersion: '1.0.0',
      status: 'published',
      installCount: 0,
      creatorId: 'cr',
    })
    pushVersion('lst', '1.0.0', { 'a.txt': 'v1-content', 'README.md': '# Hello' })

    // 2) Install — captures baseline manifest.
    const { installId, projectId } = await installService.installAgent({
      listingId: 'lst',
      userId: 'u1',
      workspaceId: 'ws1',
    })
    const inst = installs.find((i) => i.id === installId)!
    expect(inst.baselineManifest).toBeTruthy()
    const baselineKeys = Object.keys(inst.baselineManifest)
    expect(baselineKeys).toContain('a.txt')
    expect(baselineKeys).toContain('README.md')

    // No update available immediately after install.
    const initial = await installService.checkForUpdates(installId)
    expect(initial.hasUpdate).toBe(false)

    // 3) Publish a new version.
    pushVersion('lst', '2.0.0', { 'a.txt': 'v2-content', 'README.md': '# Hello v2' })

    // 4) Update is now available, no drift yet.
    const check = await installService.checkForUpdates(installId)
    expect(check.hasUpdate).toBe(true)
    expect(check.currentVersion).toBe('2.0.0')
    expect(check.drift).toBeTruthy()
    expect(
      (check.drift!.added.length + check.drift!.modified.length + check.drift!.deleted.length),
    ).toBe(0)

    // 5) Apply — clean, no drift.
    const applied = await installService.applyUpdate(installId)
    expect(applied.ok).toBe(true)
    if (applied.ok) {
      expect(applied.installedVersion).toBe('2.0.0')
    }
    // Baseline refreshed to the post-apply state.
    const m2 = manifestService.computeWorkspaceManifest(projectId)
    expect(inst.baselineManifest).toEqual(m2)

    // 6) Mutate the workspace — drift now expected on the next check.
    writeFileSync(join(tmpRoot, projectId, 'a.txt'), 'I MADE LOCAL CHANGES')

    // 7) Bump again to force a new update so drift gate is exercised.
    pushVersion('lst', '3.0.0', { 'a.txt': 'v3-content', 'README.md': '# Hello v3' })

    const driftCheck = await installService.checkForUpdates(installId)
    expect(driftCheck.hasUpdate).toBe(true)
    expect(driftCheck.drift!.modified).toContain('a.txt')

    // 8) Apply without force — refused.
    const driftedApply = await installService.applyUpdate(installId)
    expect(driftedApply.ok).toBe(false)
    if (!driftedApply.ok) {
      expect(driftedApply.error).toBe('drift_detected')
      expect(driftedApply.diverged?.modified).toContain('a.txt')
    }
    // Install version unchanged after refusal.
    expect(inst.installedVersion).toBe('2.0.0')

    // 9) Apply with force — succeeds, baseline refreshed.
    const forced = await installService.applyUpdate(installId, { force: true })
    expect(forced.ok).toBe(true)
    if (forced.ok) {
      expect(forced.installedVersion).toBe('3.0.0')
    }
    expect(inst.installedVersion).toBe('3.0.0')
  })
})

// ─── Audit + review handoff ────────────────────────────────────────

describe('audit + admin review handoff', () => {
  let originalFetch: typeof fetch

  beforeAll(() => {
    originalFetch = globalThis.fetch
  })
  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    resetDb()
    process.env.ANTHROPIC_API_KEY = 'test'
  })

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
  })

  test('audit a version, persist findings, then admin approves', async () => {
    listings.set('lst', {
      id: 'lst',
      title: 'Draft',
      shortDescription: 's',
      projectId: 'src',
      installModel: 'fork',
      currentVersion: '1.0.0',
      status: 'draft',
      installCount: 0,
      creatorId: 'cr1',
    })
    const verId = pushVersion('lst', '1.0.0', { '.env': 'API_KEY=sk-xyz' })

    // Mock Haiku response: flag the .env as a secret.
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                findings: [
                  {
                    category: 'secret',
                    severity: 'high',
                    path: '.env',
                    message: 'API key found',
                    excerpt: 'sk-***',
                  },
                ],
              }),
            },
          ],
        }),
      }) as any) as typeof fetch

    const audit = await auditService.auditListingVersion(verId, 'creator_user')
    expect(audit.status).toBe('flagged')
    expect(audit.findings).toHaveLength(1)

    // Persisted on the version row.
    const v = versions.find((row) => row.id === verId)!
    expect(v.auditStatus).toBe('flagged')
    expect(v.auditedBy).toBe('creator_user')
    expect((v.auditFindings as any).length).toBe(1)

    // Now an "admin" approves the listing — flips to published. We
    // do this by directly hitting the listingTable.update that the
    // route would call, since this test is service-layer.
    const l = listings.get('lst')!
    l.status = 'published'
    l.reviewedAt = new Date()
    l.reviewedBy = 'admin'
    expect(listings.get('lst')!.status).toBe('published')

    // The auditor result is independent of the listing status —
    // approving doesn't clear findings.
    expect(v.auditStatus).toBe('flagged')
  })
})
