// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/services/marketplace-install.service.ts`.
 *
 * Covers every public function:
 *   - getWorkspacesDir (env override + default)
 *   - copyWorkspaceFiles (source missing branch, filter rules)
 *   - installAgent (access denied / not-found / not-published / happy path /
 *     fs-failure rollback)
 *   - checkForUpdates (missing install / non-linked / has update + changelog
 *     fetch / up-to-date)
 *   - applyUpdate (missing install / non-linked / target=current / missing
 *     version row / snapshot apply / snapshot throws)
 *   - getInstallsForUser
 *   - getInstallsForListing (pagination clamping)
 *
 * `node:fs` and the Prisma client are stubbed. `workspace.service.ts`
 * (only `hasWorkspaceAccess` is used) is also stubbed so the test owns
 * the access-control answer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ─── fs mock ──────────────────────────────────────────────────────────

type FsCall = { kind: string; args: any[] }
const fsCalls: FsCall[] = []
let sourceExists = true
let cpFilter: ((src: string) => boolean) | null = null
let cpThrow: Error | null = null
let writeFileThrow: Error | null = null

const fsMock = {
  cpSync: (src: string, dest: string, opts: any) => {
    fsCalls.push({ kind: 'cpSync', args: [src, dest, opts] })
    cpFilter = opts?.filter ?? null
    if (cpThrow) throw cpThrow
  },
  existsSync: (p: string) => {
    fsCalls.push({ kind: 'existsSync', args: [p] })
    return sourceExists
  },
  mkdirSync: (p: string, opts: any) => {
    fsCalls.push({ kind: 'mkdirSync', args: [p, opts] })
  },
  writeFileSync: (p: string, data: any) => {
    fsCalls.push({ kind: 'writeFileSync', args: [p, data] })
    if (writeFileThrow) throw writeFileThrow
  },
  rmSync: (p: string, opts: any) => {
    fsCalls.push({ kind: 'rmSync', args: [p, opts] })
  },
}
mock.module('node:fs', () => fsMock)
mock.module('fs', () => fsMock)

// ─── Prisma mock ──────────────────────────────────────────────────────

let listings: Map<string, any>
let installs: any[]
let versions: any[]
let projects: Map<string, any>
let agentConfigs: any[]
let projectDeleteThrow: Error | null = null

function resetStores() {
  listings = new Map()
  installs = []
  versions = []
  projects = new Map()
  agentConfigs = []
  fsCalls.length = 0
  cpFilter = null
  cpThrow = null
  writeFileThrow = null
  sourceExists = true
  projectDeleteThrow = null
}
resetStores()

const listingTable = {
  findUnique: async (args: any) => {
    const l = listings.get(args.where.id)
    if (!l) return null
    if (args.include?.project) {
      const proj = projects.get(l.projectId) ?? null
      const includedProj = proj
        ? { ...proj, agentConfig: agentConfigs.find((c) => c.projectId === proj.id) ?? null }
        : null
      return { ...l, project: includedProj }
    }
    return l
  },
  update: async (args: any) => {
    const existing = listings.get(args.where.id)
    if (!existing) throw new Error('listing not found')
    if (args.data.installCount?.increment) {
      existing.installCount = (existing.installCount ?? 0) + args.data.installCount.increment
    }
    return existing
  },
}

const projectTable = {
  create: async (args: any) => {
    const id = `proj_${projects.size + 1}`
    const row = { id, ...args.data }
    projects.set(id, row)
    return row
  },
  delete: async (args: any) => {
    if (projectDeleteThrow) throw projectDeleteThrow
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

const installTable = {
  create: async (args: any) => {
    const row = { id: `inst_${installs.length + 1}`, ...args.data, createdAt: new Date() }
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
  findMany: async (args: any) => {
    let out = installs.filter((i) => {
      if (args.where?.userId && i.userId !== args.where.userId) return false
      if (args.where?.listingId && i.listingId !== args.where.listingId) return false
      return true
    })
    if (args.skip) out = out.slice(args.skip)
    if (args.take) out = out.slice(0, args.take)
    return out
  },
  count: async (args: any) => {
    return installs.filter((i) =>
      args.where?.listingId ? i.listingId === args.where.listingId : true,
    ).length
  },
  update: async (args: any) => {
    const inst = installs.find((i) => i.id === args.where.id)
    if (!inst) throw new Error('not found')
    Object.assign(inst, args.data)
    return inst
  },
}

const versionTable = {
  findFirst: async (args: any) => {
    return (
      versions.find(
        (v) => v.listingId === args.where.listingId && v.version === args.where.version,
      ) ?? null
    )
  },
}

const prismaStub: any = {
  marketplaceListing: listingTable,
  marketplaceInstall: installTable,
  marketplaceListingVersion: versionTable,
  project: projectTable,
  agentConfig: agentConfigTable,
  $transaction: async (fn: any) =>
    fn({
      marketplaceListing: listingTable,
      marketplaceInstall: installTable,
      marketplaceListingVersion: versionTable,
      project: projectTable,
      agentConfig: agentConfigTable,
    }),
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: prismaStub }))

// ─── manifest service mock (Phase 6) ────────────────────────────────
// installAgent now calls computeWorkspaceManifest after copying
// files; applyUpdate uses both compute + diff for drift detection.
// Tests override these via `manifestOverrides` between cases.
let manifestOverrides: {
  computeWorkspaceManifest?: () => Record<string, string>
  diffManifests?: (
    a: Record<string, string>,
    b: Record<string, string>,
  ) => { added: string[]; modified: string[]; deleted: string[] }
} = {}

mock.module('../services/marketplace-manifest.service', () => ({
  computeWorkspaceManifest: (projectId: string) =>
    manifestOverrides.computeWorkspaceManifest
      ? manifestOverrides.computeWorkspaceManifest()
      : { [`fingerprint-${projectId}`]: 'sha256-stub' },
  diffManifests: (a: Record<string, string>, b: Record<string, string>) =>
    manifestOverrides.diffManifests
      ? manifestOverrides.diffManifests(a, b)
      : { added: [], modified: [], deleted: [] },
  snapshotProjectWorkspace: () => ({}),
}))

// ─── snapshot storage mock ──────────────────────────────────────
// Records every S3 extract so tests can assert install/applyUpdate
// take the S3 path when a `workspaceSnapshotKey` is present on the
// version row. JSON-snapshot tests leave `extractCalls` empty.
const extractCalls: Array<{ key: string; destProjectId: string; expectedChecksum?: string | null }> = []
let extractThrow: Error | null = null
mock.module('../services/marketplace-snapshot-storage.service', () => ({
  extractSnapshotToProject: async (
    key: string,
    destProjectId: string,
    opts?: { expectedChecksum?: string | null },
  ) => {
    extractCalls.push({
      key,
      destProjectId,
      expectedChecksum: opts?.expectedChecksum ?? null,
    })
    if (extractThrow) throw extractThrow
  },
}))

// ─── shared-runtime S3 sync mock ─────────────────────────────────
// `pushWorkspaceToS3` is gated on `KUBERNETES_SERVICE_HOST` +
// `S3_WORKSPACES_BUCKET` and otherwise returns `skipped`. Tests that
// want to exercise the k8s path flip both env vars + can override
// `s3SyncBehavior` to simulate upload failures.
type S3SyncStub = {
  uploadAll: (force: boolean) => Promise<{ uploaded: number; archiveSize?: number; errors?: string[] }>
  shutdown: () => void
}
let s3SyncFactoryCalls: Array<{ localDir: string; projectId: string }> = []
let s3SyncBehavior: 'ok' | 'errors' | 'throws' | 'null-factory' = 'ok'
mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: (localDir: string, projectId: string): S3SyncStub | null => {
    s3SyncFactoryCalls.push({ localDir, projectId })
    if (s3SyncBehavior === 'null-factory') return null
    return {
      uploadAll: async () => {
        if (s3SyncBehavior === 'throws') throw new Error('s3 down')
        if (s3SyncBehavior === 'errors') {
          return { uploaded: 0, archiveSize: 0, errors: ['put failed: 503'] }
        }
        return { uploaded: 12, archiveSize: 4096, errors: [] }
      },
      shutdown: () => undefined,
    }
  },
}))

// ─── workspace.service mock (only hasWorkspaceAccess) ─────────────────

let workspaceAccessAnswer = true
mock.module('../services/workspace.service', () => ({
  hasWorkspaceAccess: async (_ws: string, _u: string) => workspaceAccessAnswer,
}))

const svc = await import('../services/marketplace-install.service')

beforeEach(() => {
  resetStores()
  workspaceAccessAnswer = true
  manifestOverrides = {}
  extractCalls.length = 0
  extractThrow = null
  s3SyncFactoryCalls = []
  s3SyncBehavior = 'ok'
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.S3_WORKSPACES_BUCKET
  delete process.env.MARKETPLACE_PURGE_LOCAL_AFTER_S3
})

afterEach(() => {
  delete process.env.WORKSPACES_DIR
})

// ──────────────────────────────────────────────────────────────────────
// getWorkspacesDir
// ──────────────────────────────────────────────────────────────────────

describe('getWorkspacesDir', () => {
  test('returns env override when WORKSPACES_DIR is set', () => {
    process.env.WORKSPACES_DIR = '/custom/path'
    expect(svc.getWorkspacesDir()).toBe('/custom/path')
  })

  test('returns project-root default when env not set', () => {
    delete process.env.WORKSPACES_DIR
    const out = svc.getWorkspacesDir()
    expect(out).toMatch(/workspaces$/)
  })
})

// ──────────────────────────────────────────────────────────────────────
// copyWorkspaceFiles
// ──────────────────────────────────────────────────────────────────────

describe('copyWorkspaceFiles', () => {
  test('mkdir always, but skips cp when source does not exist', () => {
    sourceExists = false
    svc.copyWorkspaceFiles('src1', 'dest1')
    expect(fsCalls.find((c) => c.kind === 'mkdirSync')).toBeTruthy()
    expect(fsCalls.find((c) => c.kind === 'cpSync')).toBeFalsy()
  })

  test('cp is called when source exists, filter rejects excluded dirs', () => {
    svc.copyWorkspaceFiles('src1', 'dest1')
    const cp = fsCalls.find((c) => c.kind === 'cpSync')!
    expect(cp).toBeTruthy()
    expect(cpFilter).toBeTruthy()
    const srcDir = cp.args[0] as string
    // Filter behavior
    expect(cpFilter!(srcDir)).toBe(true) // root passes
    expect(cpFilter!(`${srcDir}/node_modules`)).toBe(false)
    expect(cpFilter!(`${srcDir}/.git`)).toBe(false)
    expect(cpFilter!(`${srcDir}/.install-foo`)).toBe(false)
    // `dist/` MUST round-trip on the install copy: bundled templates
    // ship a pre-built `dist/index.html` for the canvas first-paint
    // preview. Drift detection's separate exclusion list keeps Vite
    // rebuilds from tripping the gate.
    expect(cpFilter!(`${srcDir}/dist`)).toBe(true)
    expect(cpFilter!(`${srcDir}/dist/index.html`)).toBe(true)
    expect(cpFilter!(`${srcDir}/src/components/Button.tsx`)).toBe(true)
    expect(cpFilter!(`${srcDir}/src/node_modules/leaked.js`)).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────
// installAgent
// ──────────────────────────────────────────────────────────────────────

function seedListing(overrides: any = {}) {
  const projId = 'src_proj'
  projects.set(projId, {
    id: projId,
    tier: 'pro',
    status: 'active',
    schemas: [],
    accessLevel: 'public',
    category: 'biz',
    siteTitle: 'st',
    siteDescription: 'sd',
    templateId: null,
    settings: { activeMode: 'agent' },
  })
  agentConfigs.push({
    projectId: projId,
    heartbeatInterval: 999,
    heartbeatEnabled: true,
    modelProvider: 'anthropic',
    modelName: 'claude-haiku-4-5',
    channels: [],
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursTimezone: null,
  })
  listings.set('lst_1', {
    id: 'lst_1',
    title: 'Cool Agent',
    shortDescription: 'short',
    projectId: projId,
    installModel: 'fork',
    currentVersion: '1.0.0',
    status: 'published',
    installCount: 0,
    ...overrides,
  })
}

describe('installAgent', () => {
  test('throws workspace_access_denied when hasWorkspaceAccess=false', async () => {
    workspaceAccessAnswer = false
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('workspace_access_denied')
  })

  test('throws listing_not_found when listing missing', async () => {
    await expect(
      svc.installAgent({ listingId: 'missing', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('listing_not_found')
  })

  test('throws listing_not_published when status != published', async () => {
    seedListing({ status: 'draft' })
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('listing_not_published')
  })

  test('happy path (legacy on-disk copy): no version row, no S3 key, falls back to copyWorkspaceFiles', async () => {
    seedListing()
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect(out.projectId).toMatch(/^proj_/)
    expect(out.installId).toMatch(/^inst_/)
    const proj = projects.get(out.projectId)
    expect(proj.name).toBe('Cool Agent')
    expect(proj.workspaceId).toBe('ws')
    expect(proj.createdBy).toBe('u')
    // agent config inherited
    const ac = agentConfigs.find((c) => c.projectId === out.projectId)
    expect(ac?.heartbeatInterval).toBe(999)
    expect(ac?.heartbeatEnabled).toBe(true)
    // install row + listing.installCount incremented
    expect(installs).toHaveLength(1)
    expect(listings.get('lst_1').installCount).toBe(1)
    // No version row → fall back to direct workspace copy.
    expect(fsCalls.find((c) => c.kind === 'cpSync')).toBeTruthy()
    expect(extractCalls).toHaveLength(0)
  })

  test('S3 path: version with workspaceSnapshotKey extracts from storage instead of copying', async () => {
    seedListing()
    versions.push({
      listingId: 'lst_1',
      version: '1.0.0',
      workspaceSnapshotKey: 'marketplace/listings/lst_1/1.0.0.tar.gz',
      workspaceSnapshotChecksum: 'sha256-stub',
    })
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect(extractCalls).toHaveLength(1)
    expect(extractCalls[0].key).toBe('marketplace/listings/lst_1/1.0.0.tar.gz')
    expect(extractCalls[0].destProjectId).toBe(out.projectId)
    expect(extractCalls[0].expectedChecksum).toBe('sha256-stub')
    // We did NOT fall back to the direct workspace copy.
    expect(fsCalls.find((c) => c.kind === 'cpSync')).toBeFalsy()
  })

  test('S3 extraction failure rolls back project, propagates error', async () => {
    seedListing()
    versions.push({
      listingId: 'lst_1',
      version: '1.0.0',
      workspaceSnapshotKey: 'marketplace/listings/lst_1/1.0.0.tar.gz',
    })
    extractThrow = new Error('s3 down')
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('s3 down')
    // Source project (src_proj) survived; new project was deleted.
    expect(projects.size).toBe(1)
    expect(installs).toHaveLength(0)
  })

  test('K8s mode: pushes the new workspace to S3 after materialization', async () => {
    seedListing()
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-staging'
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect(s3SyncFactoryCalls).toHaveLength(1)
    expect(s3SyncFactoryCalls[0].projectId).toBe(out.projectId)
    expect(s3SyncFactoryCalls[0].localDir).toContain(out.projectId)
    // Default: keep local copy (so applyUpdate's drift gate works).
    expect(installs).toHaveLength(1)
  })

  test('K8s mode: rolls back the project when S3 push fails', async () => {
    seedListing()
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-staging'
    s3SyncBehavior = 'throws'
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('marketplace_install_s3_push_failed')
    expect(installs).toHaveLength(0)
    // Source project (src_proj) survived; new project was deleted.
    expect(projects.size).toBe(1)
  })

  test('K8s mode: returns failure when S3 reports per-file errors', async () => {
    seedListing()
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-staging'
    s3SyncBehavior = 'errors'
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('marketplace_install_s3_push_failed')
    expect(installs).toHaveLength(0)
  })

  test('Local mode: skips the S3 push when not in k8s', async () => {
    seedListing()
    // KUBERNETES_SERVICE_HOST unset → skipped.
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect(out.installId).toMatch(/^inst_/)
    expect(s3SyncFactoryCalls).toHaveLength(0)
  })

  test('JSON snapshot fallback: legacy versions still install via applyWorkspaceSnapshot', async () => {
    seedListing()
    versions.push({
      listingId: 'lst_1',
      version: '1.0.0',
      workspaceSnapshot: { files: { 'a.txt': 'legacy' } },
    })
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect(extractCalls).toHaveLength(0)
    // applyWorkspaceSnapshot writes one file via writeFileSync.
    const writes = fsCalls.filter((c) => c.kind === 'writeFileSync')
    expect(writes.some((w) => (w.args[0] as string).endsWith('a.txt'))).toBe(true)
    expect(installs.find((i) => i.id === out.installId)).toBeTruthy()
  })

  test('rolls back project when copyWorkspaceFiles throws', async () => {
    seedListing()
    cpThrow = new Error('disk full')
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow('disk full')
    expect(projects.size).toBe(1) // only the source project; created was deleted
    expect(installs).toHaveLength(0)
  })

  test('handles null agentConfig + missing src.schemas with defaults', async () => {
    seedListing()
    // strip agent config + schemas off source project
    agentConfigs.length = 0
    const sp = projects.get('src_proj')!
    sp.schemas = undefined
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    const proj = projects.get(out.projectId)
    expect(proj.schemas).toEqual([])
    const ac = agentConfigs.find((c) => c.projectId === out.projectId)
    expect(ac?.heartbeatInterval).toBe(1800) // default
    expect(ac?.modelProvider).toBe('anthropic') // default
  })

  test('normalizes string settings as JSON', async () => {
    seedListing()
    const sp = projects.get('src_proj')!
    sp.settings = '{"foo":"bar"}'
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect((projects.get(out.projectId) as any).settings).toEqual({ foo: 'bar' })
  })

  test('falls back to defaults when settings string is invalid JSON', async () => {
    seedListing()
    const sp = projects.get('src_proj')!
    sp.settings = 'not-json'
    const out = await svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' })
    expect((projects.get(out.projectId) as any).settings).toMatchObject({
      activeMode: 'none',
      canvasEnabled: false,
    })
  })
})

// ──────────────────────────────────────────────────────────────────────
// checkForUpdates
// ──────────────────────────────────────────────────────────────────────

describe('checkForUpdates', () => {
  test('throws install_not_found when install missing', async () => {
    await expect(svc.checkForUpdates('nope')).rejects.toThrow('install_not_found')
  })

  // Phase 6 — fork installs now report updates the same way linked
  // installs do (the install_model split was retired). Whether to
  // surface the prompt is a UI decision, not a service decision.
  test('fork install reports update + changelog when available', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'fork',
      installedVersion: '1.0.0',
    })
    versions.push({ listingId: 'lst_1', version: '2.0.0', changelog: 'fork update' })
    const out = await svc.checkForUpdates('inst_1')
    expect(out.hasUpdate).toBe(true)
    expect(out.installedVersion).toBe('1.0.0')
    expect(out.currentVersion).toBe('2.0.0')
    expect(out.changelog).toBe('fork update')
  })

  test('linked install with newer version: returns hasUpdate + changelog', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '1.0.0',
    })
    versions.push({ listingId: 'lst_1', version: '2.0.0', changelog: 'new things' })
    const out = await svc.checkForUpdates('inst_1')
    expect(out.hasUpdate).toBe(true)
    expect(out.changelog).toBe('new things')
  })

  test('linked install already at current version: no update', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '2.0.0',
    })
    const out = await svc.checkForUpdates('inst_1')
    expect(out.hasUpdate).toBe(false)
    expect(out.changelog).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────
// applyUpdate
// ──────────────────────────────────────────────────────────────────────

describe('applyUpdate', () => {
  test('install_not_found', async () => {
    expect(await svc.applyUpdate('nope')).toEqual({ ok: false, error: 'install_not_found' })
  })

  test('already up to date: returns ok=true with no fs work', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '2.0.0',
    })
    const result = await svc.applyUpdate('inst_1')
    expect(result.ok).toBe(true)
    expect(fsCalls.find((c) => c.kind === 'writeFileSync')).toBeFalsy()
  })

  // Phase 6 — fork installs no longer short-circuit; they go through
  // the same drift gate as linked.
  test('fork install with no baseline applies snapshot like linked', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'fork',
      installedVersion: '1.0.0',
      projectId: 'proj_fork',
    })
    versions.push({
      listingId: 'lst_1',
      version: '2.0.0',
      workspaceSnapshot: { files: { 'a.txt': 'fresh' } },
    })
    const out = await svc.applyUpdate('inst_1')
    expect(out.ok).toBe(true)
    expect(installs[0].installedVersion).toBe('2.0.0')
  })

  test('version_not_found when target version missing', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '1.0.0',
      projectId: 'proj_x',
    })
    expect(await svc.applyUpdate('inst_1')).toEqual({ ok: false, error: 'version_not_found' })
  })

  test('applies snapshot with utf8 string entries, advances installedVersion', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '1.0.0',
      projectId: 'proj_x',
    })
    versions.push({
      listingId: 'lst_1',
      version: '2.0.0',
      workspaceSnapshot: {
        files: {
          'src/index.ts': 'console.log("hi")',
          'binary.bin': { data: Buffer.from('hello').toString('base64'), encoding: 'base64' },
          '../etc/passwd': 'no',
          '/abs/path': 'no',
          '': 'no',
        },
      },
    })
    const out = await svc.applyUpdate('inst_1')
    expect(out.ok).toBe(true)
    expect(installs[0].installedVersion).toBe('2.0.0')
    const writes = fsCalls.filter((c) => c.kind === 'writeFileSync')
    expect(writes).toHaveLength(2)
    expect(writes.some((w) => (w.args[0] as string).endsWith('src/index.ts'))).toBe(true)
    expect(writes.some((w) => (w.args[0] as string).endsWith('binary.bin'))).toBe(true)
  })

  test('snapshot apply throwing converts to ok=false:apply_failed', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '1.0.0',
      projectId: 'proj_x',
    })
    versions.push({
      listingId: 'lst_1',
      version: '2.0.0',
      workspaceSnapshot: { files: { 'ok.txt': 'data' } },
    })
    writeFileThrow = new Error('fs fail')
    const out = await svc.applyUpdate('inst_1')
    expect(out).toEqual({ ok: false, error: 'apply_failed' })
  })

  test('null snapshot is a no-op success path', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '1.0.0',
      projectId: 'proj_x',
    })
    versions.push({ listingId: 'lst_1', version: '2.0.0', workspaceSnapshot: null })
    const out = await svc.applyUpdate('inst_1')
    expect(out.ok).toBe(true)
    expect(installs[0].installedVersion).toBe('2.0.0')
  })

  test('flat snapshot (no .files wrapper) is treated as the file map', async () => {
    listings.set('lst_1', { id: 'lst_1', currentVersion: '2.0.0' })
    installs.push({
      id: 'inst_1',
      listingId: 'lst_1',
      installModel: 'linked',
      installedVersion: '1.0.0',
      projectId: 'proj_x',
    })
    versions.push({
      listingId: 'lst_1',
      version: '2.0.0',
      workspaceSnapshot: { 'a.txt': 'hello' },
    })
    const out = await svc.applyUpdate('inst_1')
    expect(out.ok).toBe(true)
    expect(fsCalls.find((c) => c.kind === 'writeFileSync')).toBeTruthy()
  })

  // Phase 6 — drift detection. We override the manifest service via
  // `manifestOverrides` (see the top-of-file mock) to simulate
  // baseline ≠ current without needing real files on disk.
  describe('drift detection', () => {
    test('detects drift and refuses without force', async () => {
      manifestOverrides = {
        computeWorkspaceManifest: () => ({ 'a.txt': 'NEW_HASH' }),
        diffManifests: () => ({ added: [], modified: ['a.txt'], deleted: [] }),
      }
      listings.set('lst_d', { id: 'lst_d', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_d',
        listingId: 'lst_d',
        installModel: 'linked',
        installedVersion: '1.0.0',
        projectId: 'proj_d',
        baselineManifest: { 'a.txt': 'OLD_HASH' },
      })
      versions.push({
        listingId: 'lst_d',
        version: '2.0.0',
        workspaceSnapshot: { files: { 'a.txt': 'fresh' } },
      })
      const out = await svc.applyUpdate('inst_d')
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.error).toBe('drift_detected')
        expect(out.diverged?.modified).toEqual(['a.txt'])
      }
      // Snapshot must NOT have been written.
      expect(fsCalls.find((c) => c.kind === 'writeFileSync')).toBeFalsy()
    })

    test('force overrides drift and writes snapshot', async () => {
      manifestOverrides = {
        computeWorkspaceManifest: () => ({ 'a.txt': 'POST_APPLY' }),
        diffManifests: () => ({ added: [], modified: ['a.txt'], deleted: [] }),
      }
      listings.set('lst_f', { id: 'lst_f', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_f',
        listingId: 'lst_f',
        installModel: 'linked',
        installedVersion: '1.0.0',
        projectId: 'proj_f',
        baselineManifest: { 'a.txt': 'OLD' },
      })
      versions.push({
        listingId: 'lst_f',
        version: '2.0.0',
        workspaceSnapshot: { files: { 'a.txt': 'forced' } },
      })
      const out = await svc.applyUpdate('inst_f', { force: true })
      expect(out.ok).toBe(true)
      const inst = installs.find((i) => i.id === 'inst_f')!
      expect(inst.installedVersion).toBe('2.0.0')
      // Baseline refreshed to the new on-disk manifest.
      expect(inst.baselineManifest).toEqual({ 'a.txt': 'POST_APPLY' })
    })

    test('K8s mode: applyUpdate pushes the updated workspace to S3 after writing files', async () => {
      listings.set('lst_p', { id: 'lst_p', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_p',
        listingId: 'lst_p',
        installModel: 'fork',
        installedVersion: '1.0.0',
        projectId: 'proj_p',
      })
      versions.push({
        listingId: 'lst_p',
        version: '2.0.0',
        workspaceSnapshot: { files: { 'a.txt': 'beta' } },
      })
      process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
      process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-staging'
      const out = await svc.applyUpdate('inst_p')
      expect(out.ok).toBe(true)
      expect(s3SyncFactoryCalls.find((c) => c.projectId === 'proj_p')).toBeTruthy()
      expect(installs[0].installedVersion).toBe('2.0.0')
    })

    test('K8s mode: applyUpdate fails apply when S3 push fails (no version advance)', async () => {
      listings.set('lst_pf', { id: 'lst_pf', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_pf',
        listingId: 'lst_pf',
        installModel: 'fork',
        installedVersion: '1.0.0',
        projectId: 'proj_pf',
      })
      versions.push({
        listingId: 'lst_pf',
        version: '2.0.0',
        workspaceSnapshot: { files: { 'a.txt': 'beta' } },
      })
      process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
      process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-staging'
      s3SyncBehavior = 'errors'
      const out = await svc.applyUpdate('inst_pf')
      expect(out).toEqual({ ok: false, error: 'apply_failed' })
      expect(installs[0].installedVersion).toBe('1.0.0')
    })

    test('S3 path: applyUpdate extracts tarball when version row has a key', async () => {
      listings.set('lst_s', { id: 'lst_s', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_s',
        listingId: 'lst_s',
        installModel: 'linked',
        installedVersion: '1.0.0',
        projectId: 'proj_s',
      })
      versions.push({
        listingId: 'lst_s',
        version: '2.0.0',
        workspaceSnapshotKey: 'marketplace/listings/lst_s/2.0.0.tar.gz',
        workspaceSnapshotChecksum: 'sha256-foo',
      })
      const out = await svc.applyUpdate('inst_s')
      expect(out.ok).toBe(true)
      expect(extractCalls).toHaveLength(1)
      expect(extractCalls[0].key).toBe('marketplace/listings/lst_s/2.0.0.tar.gz')
      expect(extractCalls[0].destProjectId).toBe('proj_s')
      expect(extractCalls[0].expectedChecksum).toBe('sha256-foo')
      expect(installs[0].installedVersion).toBe('2.0.0')
    })

    test('install with no baseline (legacy install) skips drift gate', async () => {
      manifestOverrides = {
        computeWorkspaceManifest: () => ({ 'a.txt': 'X' }),
        diffManifests: () => ({ added: [], modified: ['a.txt'], deleted: [] }),
      }
      listings.set('lst_n', { id: 'lst_n', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_n',
        listingId: 'lst_n',
        installModel: 'linked',
        installedVersion: '1.0.0',
        projectId: 'proj_n',
        // NO baselineManifest - simulates pre-Phase-6 install.
      })
      versions.push({
        listingId: 'lst_n',
        version: '2.0.0',
        workspaceSnapshot: { files: { 'a.txt': 'data' } },
      })
      const out = await svc.applyUpdate('inst_n')
      expect(out.ok).toBe(true)
    })

    test('install with EMPTY OBJECT baseline (multi-pod backfill case) skips drift gate', async () => {
      // Regression test: pre-fix, `backfillInstalls` set
      // `baselineManifest = {}` for legacy projects on multi-pod k8s
      // (their workspaces lived on warm-pool runtime pods, so the API
      // pod's `computeWorkspaceManifest` returned `{}`). The drift
      // gate then treated `{}` as truthy and `diffManifests({}, new)`
      // flagged every file in the new version as `added`, blocking
      // the user's update with `drift_detected`. The applyUpdate
      // belt-and-braces fix treats empty-object baselines the same
      // as null and skips the gate entirely.
      manifestOverrides = {
        computeWorkspaceManifest: () => ({ 'a.txt': 'NEW' }),
        diffManifests: () => ({ added: ['a.txt'], modified: [], deleted: [] }),
      }
      listings.set('lst_e', { id: 'lst_e', currentVersion: '2.0.0' })
      installs.push({
        id: 'inst_e',
        listingId: 'lst_e',
        installModel: 'linked',
        installedVersion: '1.0.0',
        projectId: 'proj_e',
        baselineManifest: {},
      })
      versions.push({
        listingId: 'lst_e',
        version: '2.0.0',
        workspaceSnapshot: { files: { 'a.txt': 'data' } },
      })
      const out = await svc.applyUpdate('inst_e')
      expect(out.ok).toBe(true)
      if (out.ok) expect(out.installedVersion).toBe('2.0.0')
    })
  })
})

// ──────────────────────────────────────────────────────────────────────
// getInstallsForUser
// ──────────────────────────────────────────────────────────────────────

describe('getInstallsForUser', () => {
  test('returns only this user’s installs', async () => {
    installs.push(
      { id: 'i1', userId: 'u1', listingId: 'lst_1' },
      { id: 'i2', userId: 'u1', listingId: 'lst_2' },
      { id: 'i3', userId: 'u2', listingId: 'lst_1' },
    )
    const out = await svc.getInstallsForUser('u1')
    expect(out.map((i: any) => i.id).sort()).toEqual(['i1', 'i2'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// getInstallsForListing
// ──────────────────────────────────────────────────────────────────────

describe('getInstallsForListing', () => {
  beforeEach(() => {
    for (let i = 1; i <= 25; i++) {
      installs.push({ id: `i${i}`, listingId: 'lst_x', userId: `u${i}` })
    }
  })

  test('returns page 1 with default limit', async () => {
    const out = await svc.getInstallsForListing('lst_x', 1, 10)
    expect(out.total).toBe(25)
    expect(out.installs).toHaveLength(10)
    expect(out.page).toBe(1)
    expect(out.limit).toBe(10)
  })

  test('clamps page below 1 up to 1', async () => {
    const out = await svc.getInstallsForListing('lst_x', 0, 10)
    expect(out.page).toBe(1)
  })

  test('clamps limit above 100 down to 100', async () => {
    const out = await svc.getInstallsForListing('lst_x', 1, 500)
    expect(out.limit).toBe(100)
  })

  test('clamps limit below 1 up to 1', async () => {
    const out = await svc.getInstallsForListing('lst_x', 1, 0)
    expect(out.limit).toBe(1)
    expect(out.installs).toHaveLength(1)
  })

  test('returns empty page when skip exceeds total', async () => {
    const out = await svc.getInstallsForListing('lst_x', 99, 10)
    expect(out.installs).toHaveLength(0)
    expect(out.total).toBe(25)
  })
})
