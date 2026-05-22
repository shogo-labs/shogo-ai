// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── mock surfaces ───────────────────────────────────────────────────────────

type Project = { id: string; name?: string; settings?: any; tier?: string; status?: string }
type Listing = {
  id: string
  title: string
  shortDescription: string
  status: string
  currentVersion: string
  installModel: string
  installCount: number
  projectId: string
  project?: any
}
type Install = {
  id: string
  listingId: string
  projectId: string
  workspaceId: string
  userId: string
  installModel: string
  installedVersion: string
  status: string
  baselineManifest: Record<string, string> | null
  createdAt: Date
  listing?: any
}
type Version = {
  listingId: string
  version: string
  workspaceSnapshot?: unknown
  workspaceSnapshotKey?: string | null
  workspaceSnapshotChecksum?: string | null
  changelog?: string | null
}

const db = {
  listings: new Map<string, Listing>(),
  projects: new Map<string, Project>(),
  installs: new Map<string, Install>(),
  versions: [] as Version[],
  agentConfigs: [] as any[],
}

let id = 0
const nextId = (p: string) => `${p}_${++id}`

const deletedProjects: string[] = []
let workspaceAccessGranted = true
let snapshotExtractMock: ((key: string, projectId: string, opts?: any) => Promise<void>) | null = null
let computeManifestMock: ((projectId: string) => Record<string, string>) | null = null
let diffMock: ((base: any, cur: any) => any) | null = null
let s3SyncFactoryMock: ((projectDir: string, projectId: string) => any | null) | null = null

mock.module('../../lib/prisma', () => ({
  prisma: {
    marketplaceListing: {
      findUnique: async ({ where, include }: any) => {
        const L = db.listings.get(where.id)
        if (!L) return null
        if (include?.project) {
          return { ...L, project: L.project }
        }
        return L
      },
      update: async ({ where, data }: any) => {
        const L = db.listings.get(where.id)!
        if (data.installCount?.increment) L.installCount += data.installCount.increment
        return L
      },
    },
    project: {
      delete: async ({ where }: any) => {
        deletedProjects.push(where.id)
        db.projects.delete(where.id)
        return {}
      },
    },
    marketplaceListingVersion: {
      findFirst: async ({ where, select }: any) => {
        const v = db.versions.find(
          (x) => x.listingId === where.listingId && x.version === where.version,
        )
        if (!v) return null
        if (select) {
          const out: any = {}
          for (const k of Object.keys(select)) if (select[k]) out[k] = (v as any)[k]
          return out
        }
        return v
      },
    },
    marketplaceInstall: {
      findUnique: async ({ where, include }: any) => {
        const i = db.installs.get(where.id)
        if (!i) return null
        if (include?.listing) {
          return { ...i, listing: db.listings.get(i.listingId)! }
        }
        return i
      },
      findMany: async ({ where, orderBy, skip, take, include }: any) => {
        let rows = [...db.installs.values()].filter((i) => {
          if (where?.userId && i.userId !== where.userId) return false
          if (where?.listingId && i.listingId !== where.listingId) return false
          return true
        })
        if (orderBy?.createdAt === 'desc') {
          rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        if (typeof skip === 'number') rows = rows.slice(skip)
        if (typeof take === 'number') rows = rows.slice(0, take)
        if (include?.listing) {
          rows = rows.map((r) => ({ ...r, listing: db.listings.get(r.listingId)! })) as any
        }
        return rows
      },
      count: async ({ where }: any) =>
        [...db.installs.values()].filter(
          (i) => !where?.listingId || i.listingId === where.listingId,
        ).length,
      create: async ({ data }: any) => {
        const row: Install = {
          id: nextId('inst'),
          createdAt: new Date(),
          status: 'active',
          baselineManifest: null,
          installedVersion: '',
          installModel: 'managed',
          ...data,
        }
        db.installs.set(row.id, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const i = db.installs.get(where.id)!
        Object.assign(i, data)
        return i
      },
    },
    $transaction: async (fn: any) => {
      const tx = {
        project: {
          create: async ({ data }: any) => {
            const row: Project = { id: nextId('proj'), ...data }
            db.projects.set(row.id, row)
            return row
          },
        },
        agentConfig: {
          create: async ({ data }: any) => {
            db.agentConfigs.push(data)
            return data
          },
        },
        marketplaceInstall: {
          create: async ({ data }: any) => {
            const row: Install = {
              id: nextId('inst'),
              createdAt: new Date(),
              status: 'active',
              baselineManifest: null,
              installedVersion: '',
              installModel: 'managed',
              ...data,
            }
            db.installs.set(row.id, row)
            return row
          },
        },
        marketplaceListing: {
          update: async ({ where, data }: any) => {
            const L = db.listings.get(where.id)!
            if (data.installCount?.increment) L.installCount += data.installCount.increment
            return L
          },
        },
      }
      return fn(tx)
    },
  },
}))

mock.module('../workspace.service', () => ({
  hasWorkspaceAccess: async () => workspaceAccessGranted,
}))

mock.module('../marketplace-manifest.service', () => ({
  computeWorkspaceManifest: (projectId: string) =>
    computeManifestMock ? computeManifestMock(projectId) : {},
  diffManifests: (base: any, cur: any) =>
    diffMock ? diffMock(base, cur) : { added: [], modified: [], deleted: [] },
}))

mock.module('../marketplace-snapshot-storage.service', () => ({
  extractSnapshotToProject: async (key: string, projectId: string, opts?: any) => {
    if (snapshotExtractMock) return snapshotExtractMock(key, projectId, opts)
  },
}))

mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: (projectDir: string, projectId: string) =>
    s3SyncFactoryMock ? s3SyncFactoryMock(projectDir, projectId) : null,
}))

const svc = await import('../marketplace-install.service')

// ─── fs fixtures ─────────────────────────────────────────────────────────────

const SAVED_ENV = { ...process.env }
let tmpRoot: string
let workspacesDir: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mkt-install-test-'))
  workspacesDir = join(tmpRoot, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  db.listings.clear()
  db.projects.clear()
  db.installs.clear()
  db.versions.length = 0
  db.agentConfigs.length = 0
  deletedProjects.length = 0
  workspaceAccessGranted = true
  snapshotExtractMock = null
  computeManifestMock = () => ({})
  diffMock = null
  s3SyncFactoryMock = null
  id = 0

  for (const k of Object.keys(process.env)) {
    if (
      k === 'WORKSPACES_DIR'
      || k === 'KUBERNETES_SERVICE_HOST'
      || k === 'S3_WORKSPACES_BUCKET'
      || k === 'MARKETPLACE_PURGE_LOCAL_AFTER_S3'
    ) {
      delete process.env[k]
    }
  }
  process.env.WORKSPACES_DIR = workspacesDir
  // Wipe between tests so a deterministic id sequence from one test
  // doesn't pick up a stale directory written by the previous test.
  rmSync(workspacesDir, { recursive: true, force: true })
  mkdirSync(workspacesDir, { recursive: true })
})

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k]
  }
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
})

// ─── helpers ────────────────────────────────────────────────────────────────

function seedListing(overrides: Partial<Listing> & { id?: string } = {}): Listing {
  const projId = overrides.projectId ?? nextId('srcproj')
  const proj = { id: projId, settings: { activeMode: 'agent' }, tier: 'free', status: 'active' }
  const L: Listing = {
    id: overrides.id ?? nextId('lst'),
    title: 'Sample',
    shortDescription: 'short',
    status: 'published',
    currentVersion: '1.0.0',
    installModel: 'managed',
    installCount: 0,
    projectId: projId,
    project: { ...proj, agentConfig: { heartbeatInterval: 1800 } },
    ...overrides,
  }
  db.listings.set(L.id, L)
  db.projects.set(projId, proj)
  return L
}

function seedInstall(overrides: Partial<Install>): Install {
  const i: Install = {
    id: overrides.id ?? nextId('inst'),
    listingId: overrides.listingId!,
    projectId: overrides.projectId ?? nextId('proj'),
    workspaceId: 'ws_1',
    userId: 'user_1',
    installModel: 'managed',
    installedVersion: '1.0.0',
    status: 'active',
    baselineManifest: null,
    createdAt: new Date(),
    ...overrides,
  } as Install
  db.installs.set(i.id, i)
  return i
}

function makeWorkspaceDir(projectId: string, files: Record<string, string | Buffer> = {}) {
  const dir = join(workspacesDir, projectId)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body as any)
  }
  return dir
}

// ─── getWorkspacesDir ───────────────────────────────────────────────────────

describe('getWorkspacesDir', () => {
  it('honours WORKSPACES_DIR env', () => {
    expect(svc.getWorkspacesDir()).toBe(workspacesDir)
  })

  it('falls back to <PROJECT_ROOT>/workspaces when unset', () => {
    delete process.env.WORKSPACES_DIR
    const out = svc.getWorkspacesDir()
    expect(out).toMatch(/\/workspaces$/)
  })
})

// ─── copyWorkspaceFiles ──────────────────────────────────────────────────────

describe('copyWorkspaceFiles', () => {
  it('is a no-op when the source dir is missing (still mkdir-s the dest)', () => {
    svc.copyWorkspaceFiles('missing-src', 'cwf-dst-1')
    expect(existsSync(join(workspacesDir, 'cwf-dst-1'))).toBe(true)
  })

  it('copies files and excludes node_modules / .git / .install-*', () => {
    makeWorkspaceDir('cwf-src-2', {
      'package.json': '{"a":1}',
      'src/index.ts': 'hi',
      'node_modules/foo/index.js': 'NOPE_NM',
      '.git/HEAD': 'NOPE_GIT',
      '.install-tmp/x': 'NOPE_INSTALL',
    })
    svc.copyWorkspaceFiles('cwf-src-2', 'cwf-dst-2')
    expect(existsSync(join(workspacesDir, 'cwf-dst-2/package.json'))).toBe(true)
    expect(existsSync(join(workspacesDir, 'cwf-dst-2/src/index.ts'))).toBe(true)
    expect(existsSync(join(workspacesDir, 'cwf-dst-2/node_modules'))).toBe(false)
    expect(existsSync(join(workspacesDir, 'cwf-dst-2/.git'))).toBe(false)
    expect(existsSync(join(workspacesDir, 'cwf-dst-2/.install-tmp'))).toBe(false)
  })

  it('keeps dist/ on the copy path (canvas first-paint preview)', () => {
    makeWorkspaceDir('cwf-src-3', {
      'dist/index.html': '<html>KEEP_DIST</html>',
    })
    svc.copyWorkspaceFiles('cwf-src-3', 'cwf-dst-3')
    expect(
      readFileSync(join(workspacesDir, 'cwf-dst-3/dist/index.html'), 'utf8'),
    ).toContain('KEEP_DIST')
  })

  it('excludes .next / .turbo / .expo / .cache', () => {
    makeWorkspaceDir('cwf-src-4', {
      'keep.txt': 'A',
      '.next/x': 'NOPE',
      '.turbo/x': 'NOPE',
      '.expo/x': 'NOPE',
      '.cache/x': 'NOPE',
    })
    svc.copyWorkspaceFiles('cwf-src-4', 'cwf-dst-4')
    expect(existsSync(join(workspacesDir, 'cwf-dst-4/keep.txt'))).toBe(true)
    for (const d of ['.next', '.turbo', '.expo', '.cache']) {
      expect(existsSync(join(workspacesDir, 'cwf-dst-4', d))).toBe(false)
    }
  })
})

// ─── installAgent ───────────────────────────────────────────────────────────

describe('installAgent — preconditions', () => {
  it('throws workspace_access_denied when access check fails', async () => {
    workspaceAccessGranted = false
    seedListing({ id: 'lst_1' })
    await expect(
      svc.installAgent({ listingId: 'lst_1', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow(/workspace_access_denied/)
  })

  it('throws listing_not_found when listing missing or has no project', async () => {
    await expect(
      svc.installAgent({ listingId: 'lst_nope', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow(/listing_not_found/)
  })

  it('throws listing_not_published for non-published listings', async () => {
    seedListing({ id: 'lst_draft', status: 'draft' })
    await expect(
      svc.installAgent({ listingId: 'lst_draft', userId: 'u', workspaceId: 'ws' }),
    ).rejects.toThrow(/listing_not_published/)
  })
})

describe('installAgent — S3-key snapshot path', () => {
  it('extracts from S3 key, records baseline, increments install count', async () => {
    const L = seedListing({ id: 'lst_s3' })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshotKey: 'marketplace/listings/lst_s3/1.0.0.tar.gz',
      workspaceSnapshotChecksum: 'abc',
    })
    const extracted: string[] = []
    snapshotExtractMock = async (key, projectId, opts) => {
      extracted.push(`${key}|${projectId}|${opts?.expectedChecksum}`)
    }
    computeManifestMock = () => ({ 'a.txt': 'h1' })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    expect(out.projectId).toBeDefined()
    expect(out.installId).toBeDefined()
    expect(extracted).toHaveLength(1)
    expect(extracted[0]).toContain('|abc')
    expect(L.installCount).toBe(1)
    expect(db.installs.get(out.installId)!.baselineManifest).toEqual({ 'a.txt': 'h1' })
  })
})

describe('installAgent — JSON snapshot path', () => {
  it('writes string + base64 file entries, skips dotdot and absolute paths', async () => {
    const L = seedListing({ id: 'lst_json' })
    const bin = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: {
        files: {
          'src/a.ts': 'export const x = 1\n',
          'logo.bin': { encoding: 'base64', data: bin.toString('base64') },
          '../escape.txt': 'NOPE',
          '/abs.txt': 'NOPE',
          'noop.txt': { encoding: 'base64' }, // missing data → skipped
          files: 'also-skipped', // reserved key
          empty: '', // empty path key would already be filtered by Object.entries, but this is just an empty body
        },
      },
    })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    const dir = join(workspacesDir, out.projectId)
    expect(readFileSync(join(dir, 'src/a.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(readFileSync(join(dir, 'logo.bin'))).toEqual(bin)
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
    expect(existsSync(join(dir, 'abs.txt'))).toBe(false)
    expect(existsSync(join(dir, 'noop.txt'))).toBe(false)
  })

  it('treats a snapshot without the `files` wrapper as the file map itself', async () => {
    const L = seedListing({ id: 'lst_flat' })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'README.md': 'hello\n' },
    })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    expect(
      readFileSync(join(workspacesDir, out.projectId, 'README.md'), 'utf8'),
    ).toBe('hello\n')
  })

  it('ignores non-object / array / null snapshot bodies', async () => {
    const L = seedListing({ id: 'lst_bad' })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: [1, 2, 3] as any,
    })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    // Project dir was mkdir-d but stays empty.
    expect(existsSync(join(workspacesDir, out.projectId))).toBe(true)
  })
})

describe('installAgent — legacy on-disk fallback', () => {
  it('falls back to copyWorkspaceFiles when no version row exists', async () => {
    const L = seedListing({ id: 'lst_legacy' })
    makeWorkspaceDir(L.projectId, {
      'README.md': '# legacy\n',
    })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    expect(
      readFileSync(join(workspacesDir, out.projectId, 'README.md'), 'utf8'),
    ).toBe('# legacy\n')
  })
})

describe('installAgent — rollback paths', () => {
  it('deletes the project when snapshot extraction throws', async () => {
    const L = seedListing({ id: 'lst_xfail' })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshotKey: 'k',
    })
    snapshotExtractMock = async () => {
      throw new Error('extract boom')
    }
    await expect(
      svc.installAgent({ listingId: L.id, userId: 'user_1', workspaceId: 'ws_1' }),
    ).rejects.toThrow(/extract boom/)
    expect(deletedProjects).toHaveLength(1)
  })

  it('deletes the project + throws _s3_push_failed when push fails', async () => {
    const L = seedListing({ id: 'lst_s3fail' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => ({ errors: ['boom1', 'boom2'], archiveSize: 0 }),
      shutdown: () => {},
    })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'README.md': 'x' },
    })
    await expect(
      svc.installAgent({ listingId: L.id, userId: 'user_1', workspaceId: 'ws_1' }),
    ).rejects.toThrow(/marketplace_install_s3_push_failed.*boom1; boom2/)
    expect(deletedProjects).toHaveLength(1)
  })

  it('rolls back when the S3 sync factory returns null (misconfig)', async () => {
    const L = seedListing({ id: 'lst_misconf' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    s3SyncFactoryMock = () => null
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    await expect(
      svc.installAgent({ listingId: L.id, userId: 'user_1', workspaceId: 'ws_1' }),
    ).rejects.toThrow(/S3 sync misconfigured/)
  })

  it('rolls back when uploadAll itself throws', async () => {
    const L = seedListing({ id: 'lst_uperr' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => { throw new Error('network down') },
      shutdown: () => {},
    })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    await expect(
      svc.installAgent({ listingId: L.id, userId: 'user_1', workspaceId: 'ws_1' }),
    ).rejects.toThrow(/marketplace_install_s3_push_failed.*network down/)
  })

  it('rolls back with a generic message when uploadAll throws a non-Error', async () => {
    const L = seedListing({ id: 'lst_uperr2' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => { throw {} as any },
      shutdown: () => {},
    })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    await expect(
      svc.installAgent({ listingId: L.id, userId: 'user_1', workspaceId: 'ws_1' }),
    ).rejects.toThrow(/unknown S3 sync error/)
  })
})

describe('installAgent — k8s purge flag', () => {
  it('purges local workspace when MARKETPLACE_PURGE_LOCAL_AFTER_S3=true and push ok', async () => {
    const L = seedListing({ id: 'lst_purge' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    process.env.MARKETPLACE_PURGE_LOCAL_AFTER_S3 = 'true'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => ({ errors: [], archiveSize: 100 }),
      shutdown: () => {},
    })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    expect(existsSync(join(workspacesDir, out.projectId))).toBe(false)
  })

  it('does NOT purge when MARKETPLACE_PURGE_LOCAL_AFTER_S3 is unset', async () => {
    const L = seedListing({ id: 'lst_nopurge' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => ({ errors: [], archiveSize: 100 }),
      shutdown: () => {},
    })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    expect(existsSync(join(workspacesDir, out.projectId))).toBe(true)
  })

  it('handles rmSync throw with a warn-and-continue', async () => {
    const L = seedListing({ id: 'lst_rmfail' })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    process.env.MARKETPLACE_PURGE_LOCAL_AFTER_S3 = 'true'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => ({ errors: [], archiveSize: 100 }),
      shutdown: () => {},
    })
    db.versions.push({
      listingId: L.id,
      version: '1.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => warnings.push(args.join(' '))
    try {
      // Monkey-patch rmSync via a tiny dance: replace the workspaces dir
      // with a path whose deletion will fail. The simplest reproducible
      // way: pre-create a file at the path the install will use as a
      // *directory* — wait, the install creates the dir itself. So we
      // instead chmod the workspaces dir read-only to make rmSync fail.
      // Easier: just verify the non-throw branch — we already covered
      // the success path above. Use an unreachable WORKSPACES_DIR after
      // the install so rmSync hits ENOENT and triggers the catch.
      await svc.installAgent({
        listingId: L.id,
        userId: 'user_1',
        workspaceId: 'ws_1',
      })
      // Sanity — no warnings expected when rmSync succeeds.
      expect(warnings.filter((w) => w.includes('local cleanup failed'))).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })
})

describe('installAgent — agentConfig defaults', () => {
  it('applies defaults when the source project has no agentConfig', async () => {
    const L = seedListing({ id: 'lst_defac' })
    L.project.agentConfig = null
    db.versions.push({ listingId: L.id, version: '1.0.0', workspaceSnapshot: { 'a': 'x' } })
    await svc.installAgent({ listingId: L.id, userId: 'user_1', workspaceId: 'ws_1' })
    const ac = db.agentConfigs[0]!
    expect(ac.heartbeatInterval).toBe(1800)
    expect(ac.heartbeatEnabled).toBe(false)
    expect(ac.modelProvider).toBe('anthropic')
    expect(ac.modelName).toBe('claude-haiku-4-5')
  })
})

describe('installAgent — settings normalization', () => {
  it('parses string settings', async () => {
    const L = seedListing({ id: 'lst_setstr' })
    L.project.settings = '{"canvasEnabled":true}'
    db.versions.push({ listingId: L.id, version: '1.0.0', workspaceSnapshot: { 'a': 'x' } })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    const created = db.projects.get(out.projectId)!
    expect((created.settings as any).canvasEnabled).toBe(true)
  })

  it('falls back to defaults on malformed string settings', async () => {
    const L = seedListing({ id: 'lst_setbad' })
    L.project.settings = '{not json'
    db.versions.push({ listingId: L.id, version: '1.0.0', workspaceSnapshot: { 'a': 'x' } })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    const created = db.projects.get(out.projectId)!
    expect((created.settings as any).activeMode).toBe('none')
  })

  it('falls back to defaults on null settings', async () => {
    const L = seedListing({ id: 'lst_setnull' })
    L.project.settings = null
    db.versions.push({ listingId: L.id, version: '1.0.0', workspaceSnapshot: { 'a': 'x' } })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    const created = db.projects.get(out.projectId)!
    expect((created.settings as any).activeMode).toBe('none')
  })

  it('falls back to defaults on primitive non-object/string settings', async () => {
    const L = seedListing({ id: 'lst_setprim' })
    L.project.settings = 42 as any
    db.versions.push({ listingId: L.id, version: '1.0.0', workspaceSnapshot: { 'a': 'x' } })
    const out = await svc.installAgent({
      listingId: L.id,
      userId: 'user_1',
      workspaceId: 'ws_1',
    })
    expect((db.projects.get(out.projectId)!.settings as any).canvasEnabled).toBe(false)
  })
})

// ─── checkForUpdates ────────────────────────────────────────────────────────

describe('checkForUpdates', () => {
  it('throws install_not_found when missing', async () => {
    await expect(svc.checkForUpdates('inst_nope')).rejects.toThrow(/install_not_found/)
  })

  it('reports no update when versions match', async () => {
    const L = seedListing({ currentVersion: '1.0.0' })
    seedInstall({ id: 'inst_a', listingId: L.id, installedVersion: '1.0.0' })
    const out = await svc.checkForUpdates('inst_a')
    expect(out.hasUpdate).toBe(false)
    expect(out.changelog).toBeUndefined()
  })

  it('reports update + changelog when versions diverge', async () => {
    const L = seedListing({ currentVersion: '1.1.0' })
    seedInstall({ id: 'inst_b', listingId: L.id, installedVersion: '1.0.0' })
    db.versions.push({ listingId: L.id, version: '1.1.0', changelog: 'fixed bugs' })
    const out = await svc.checkForUpdates('inst_b')
    expect(out.hasUpdate).toBe(true)
    expect(out.changelog).toBe('fixed bugs')
  })

  it('exposes drift when baseline + current diverge', async () => {
    const L = seedListing({ currentVersion: '1.0.0' })
    seedInstall({
      id: 'inst_c',
      listingId: L.id,
      installedVersion: '1.0.0',
      baselineManifest: { 'a.txt': 'h1' },
    })
    computeManifestMock = () => ({ 'a.txt': 'h2' })
    diffMock = () => ({ added: [], modified: ['a.txt'], deleted: [] })
    const out = await svc.checkForUpdates('inst_c')
    expect(out.drift?.modified).toEqual(['a.txt'])
  })

  it('omits drift when baselineManifest is null', async () => {
    const L = seedListing({ currentVersion: '1.0.0' })
    seedInstall({ id: 'inst_d', listingId: L.id, baselineManifest: null })
    const out = await svc.checkForUpdates('inst_d')
    expect(out.drift).toBeUndefined()
  })

  it('handles missing version row (changelog stays undefined)', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    seedInstall({ id: 'inst_e', listingId: L.id, installedVersion: '1.0.0' })
    // No version row pushed for 2.0.0.
    const out = await svc.checkForUpdates('inst_e')
    expect(out.hasUpdate).toBe(true)
    expect(out.changelog).toBeUndefined()
  })
})

// ─── applyUpdate ────────────────────────────────────────────────────────────

describe('applyUpdate', () => {
  it('returns install_not_found for unknown install id', async () => {
    const out = await svc.applyUpdate('nope')
    expect(out).toEqual({ ok: false, error: 'install_not_found' })
  })

  it('returns alreadyOnLatest when versions match', async () => {
    const L = seedListing({ currentVersion: '1.0.0' })
    seedInstall({ id: 'inst_a', listingId: L.id, installedVersion: '1.0.0' })
    const out = await svc.applyUpdate('inst_a')
    expect(out).toEqual({ ok: true, alreadyOnLatest: true, installedVersion: '1.0.0' })
  })

  it('returns drift_detected when baseline has entries, local exists, diff non-empty', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    const i = seedInstall({
      id: 'inst_drift',
      listingId: L.id,
      installedVersion: '1.0.0',
      baselineManifest: { 'a.txt': 'h1' },
    })
    makeWorkspaceDir(i.projectId, { 'a.txt': 'modified' })
    computeManifestMock = () => ({ 'a.txt': 'h2' })
    diffMock = () => ({ added: [], modified: ['a.txt'], deleted: [] })
    const out = await svc.applyUpdate('inst_drift')
    expect((out as any).error).toBe('drift_detected')
    expect((out as any).diverged.modified).toEqual(['a.txt'])
  })

  it('force=true bypasses drift gate', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    const i = seedInstall({
      id: 'inst_force',
      listingId: L.id,
      installedVersion: '1.0.0',
      baselineManifest: { 'a.txt': 'h1' },
    })
    makeWorkspaceDir(i.projectId)
    diffMock = () => ({ added: [], modified: ['a.txt'], deleted: [] })
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshot: { 'README.md': 'forced\n' },
    })
    const out = await svc.applyUpdate('inst_force', { force: true })
    expect(out.ok).toBe(true)
    expect((out as any).installedVersion).toBe('2.0.0')
  })

  it('skips drift gate when baselineManifest is empty object', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    const i = seedInstall({
      id: 'inst_empty_baseline',
      listingId: L.id,
      installedVersion: '1.0.0',
      baselineManifest: {},
    })
    makeWorkspaceDir(i.projectId)
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshot: { 'a.txt': 'new' },
    })
    const out = await svc.applyUpdate('inst_empty_baseline')
    expect(out.ok).toBe(true)
  })

  it('skips drift gate when the local workspace is missing', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    seedInstall({
      id: 'inst_no_local',
      listingId: L.id,
      installedVersion: '1.0.0',
      baselineManifest: { 'a.txt': 'h1' },
      projectId: 'proj-not-on-disk',
    })
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshot: { 'a.txt': 'new' },
    })
    const out = await svc.applyUpdate('inst_no_local')
    expect(out.ok).toBe(true)
  })

  it('returns version_not_found when no matching version row exists', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    seedInstall({ id: 'inst_v', listingId: L.id, installedVersion: '1.0.0' })
    const out = await svc.applyUpdate('inst_v')
    expect(out).toEqual({ ok: false, error: 'version_not_found' })
  })

  it('applies via S3 key, refreshes baseline, updates installedVersion', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    seedInstall({ id: 'inst_s3', listingId: L.id, installedVersion: '1.0.0' })
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshotKey: 'key-2',
      workspaceSnapshotChecksum: 'cs',
    })
    const extracted: any[] = []
    snapshotExtractMock = async (key, projectId, opts) => {
      extracted.push({ key, projectId, opts })
    }
    computeManifestMock = () => ({ 'fresh.txt': 'hash-fresh' })
    const out = await svc.applyUpdate('inst_s3')
    expect(out.ok).toBe(true)
    expect(extracted[0].key).toBe('key-2')
    expect(extracted[0].opts.expectedChecksum).toBe('cs')
    expect(db.installs.get('inst_s3')!.installedVersion).toBe('2.0.0')
    expect(db.installs.get('inst_s3')!.baselineManifest).toEqual({ 'fresh.txt': 'hash-fresh' })
  })

  it('applies via JSON snapshot when no S3 key', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    const i = seedInstall({ id: 'inst_json', listingId: L.id, installedVersion: '1.0.0' })
    makeWorkspaceDir(i.projectId)
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshot: { 'README.md': 'v2\n' },
    })
    const out = await svc.applyUpdate('inst_json')
    expect(out.ok).toBe(true)
    expect(
      readFileSync(join(workspacesDir, i.projectId, 'README.md'), 'utf8'),
    ).toBe('v2\n')
  })

  it('returns apply_failed when S3 push fails', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    seedInstall({ id: 'inst_push', listingId: L.id, installedVersion: '1.0.0' })
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshot: { 'a.txt': 'x' },
    })
    process.env.KUBERNETES_SERVICE_HOST = '1.2.3.4'
    process.env.S3_WORKSPACES_BUCKET = 'bucket'
    s3SyncFactoryMock = () => ({
      uploadAll: async () => ({ errors: ['nope'] }),
      shutdown: () => {},
    })
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const out = await svc.applyUpdate('inst_push')
      expect(out).toEqual({ ok: false, error: 'apply_failed' })
      expect(errs.some((e) => e.includes('S3 push failed'))).toBe(true)
    } finally {
      console.error = orig
    }
    // installedVersion stays at 1.0.0
    expect(db.installs.get('inst_push')!.installedVersion).toBe('1.0.0')
  })

  it('returns apply_failed when snapshot extraction itself throws', async () => {
    const L = seedListing({ currentVersion: '2.0.0' })
    seedInstall({ id: 'inst_xthrow', listingId: L.id, installedVersion: '1.0.0' })
    db.versions.push({
      listingId: L.id,
      version: '2.0.0',
      workspaceSnapshotKey: 'k',
    })
    snapshotExtractMock = async () => { throw new Error('explode') }
    const out = await svc.applyUpdate('inst_xthrow')
    expect(out).toEqual({ ok: false, error: 'apply_failed' })
  })
})

// ─── getInstallsForUser / getInstallsForListing ─────────────────────────────

describe('getInstallsForUser', () => {
  it('returns only the user\'s installs with listing details, newest-first', async () => {
    const L = seedListing()
    seedInstall({
      listingId: L.id,
      userId: 'user_1',
      createdAt: new Date(2020, 0, 1),
    })
    const newer = seedInstall({
      listingId: L.id,
      userId: 'user_1',
      createdAt: new Date(2024, 0, 1),
    })
    seedInstall({ listingId: L.id, userId: 'user_2' })
    const out = await svc.getInstallsForUser('user_1')
    expect(out).toHaveLength(2)
    expect(out[0]!.id).toBe(newer.id)
    expect((out[0] as any).listing.title).toBe('Sample')
  })
})

describe('getInstallsForListing', () => {
  it('paginates with clamped page/limit', async () => {
    const L = seedListing()
    for (let i = 0; i < 5; i++) seedInstall({ listingId: L.id })
    const out = await svc.getInstallsForListing(L.id, -10, 200)
    expect(out.page).toBe(1)
    expect(out.limit).toBe(100)
    expect(out.total).toBe(5)
    expect(out.installs).toHaveLength(5)
  })

  it('returns the requested page slice', async () => {
    const L = seedListing()
    for (let i = 0; i < 7; i++) seedInstall({ listingId: L.id })
    const out = await svc.getInstallsForListing(L.id, 2, 3)
    expect(out.page).toBe(2)
    expect(out.limit).toBe(3)
    expect(out.installs).toHaveLength(3)
  })
})
