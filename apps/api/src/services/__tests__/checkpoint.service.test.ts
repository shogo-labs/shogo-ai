// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── mocks ───────────────────────────────────────────────────────────────────

// In-memory prisma surface
type Project = { id: string; workingMode?: string | null }
type Checkpoint = {
  id: string
  projectId: string
  commitSha: string
  commitMessage: string
  branch: string
  name: string | null
  description: string | null
  filesChanged: number
  additions: number
  deletions: number
  includesDb: boolean
  isAutomatic: boolean
  createdBy: string | null
  createdAt: Date
}
type GHConn = { projectId: string; syncEnabled: boolean }

const db = {
  projects: new Map<string, Project>(),
  checkpoints: new Map<string, Checkpoint>(),
  ghConns: new Map<string, GHConn>(),
}
let nextId = 0
const id = (p: string) => `${p}_${++nextId}`

const prismaCalls = {
  createCheckpoint: [] as any[],
  deleteManyCheckpoint: [] as any[],
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where, select }: any) => {
        const p = db.projects.get(where.id)
        if (!p) return null
        if (select) {
          const out: any = {}
          for (const k of Object.keys(select)) if (select[k]) out[k] = (p as any)[k]
          return out
        }
        return p
      },
    },
    projectCheckpoint: {
      findUnique: async ({ where }: any) => db.checkpoints.get(where.id) ?? null,
      findFirst: async ({ where }: any) => {
        for (const c of db.checkpoints.values()) {
          if (where.projectId && c.projectId !== where.projectId) continue
          if (where.commitSha && c.commitSha !== where.commitSha) continue
          return c
        }
        return null
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...db.checkpoints.values()].filter(
          (c) => c.projectId === where.projectId
            && (!where.createdAt?.lt || c.createdAt < where.createdAt.lt),
        )
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        if (typeof take === 'number') rows = rows.slice(0, take)
        return rows
      },
      create: async ({ data }: any) => {
        prismaCalls.createCheckpoint.push(data)
        const c: Checkpoint = {
          id: id('cp'),
          createdAt: new Date(),
          name: data.name ?? null,
          description: data.description ?? null,
          filesChanged: data.filesChanged ?? 0,
          additions: data.additions ?? 0,
          deletions: data.deletions ?? 0,
          includesDb: data.includesDb ?? false,
          isAutomatic: data.isAutomatic ?? false,
          createdBy: data.createdBy ?? null,
          ...data,
        }
        db.checkpoints.set(c.id, c)
        return c
      },
      deleteMany: async ({ where }: any) => {
        prismaCalls.deleteManyCheckpoint.push(where)
        let n = 0
        for (const id of where.id.in) {
          if (db.checkpoints.delete(id)) n++
        }
        return { count: n }
      },
    },
    gitHubConnection: {
      findUnique: async ({ where }: any) => db.ghConns.get(where.projectId) ?? null,
    },
  },
}))

// git.service mock with controllable impls
const gitCalls = {
  initRepo: [] as string[],
  commit: [] as any[],
  getCommit: [] as any[],
  saveCheckpointMetadata: [] as any[],
  getStatus: [] as string[],
  checkout: [] as any[],
  getDiff: [] as any[],
}

let initRepoImpl = async (_p: string) => ({ branch: 'main' })
let commitImpl = async (_p: string, _opts: any) =>
  ({ sha: 'sha_new', message: 'msg', filesChanged: 1, additions: 2, deletions: 3 } as any)
let getCommitImpl = async (_p: string, _ref: string) =>
  ({ sha: 'sha_head', message: 'head msg', filesChanged: 4, additions: 5, deletions: 6 } as any)
let getStatusImpl = async (_p: string) => ({ hasChanges: false } as any)
let checkoutImpl = async (_p: string, _ref: string, _opts: any) =>
  ({ success: true } as any)
let getDiffImpl = async (_p: string, _from: string, _to: string) =>
  ({ files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1 }], totalAdditions: 1, totalDeletions: 1 } as any)
let saveCheckpointMetadataImpl = async (_p: string, _m: any) => {}

mock.module('../git.service', () => ({
  initRepo: (p: string) => { gitCalls.initRepo.push(p); return initRepoImpl(p) },
  commit: (p: string, o: any) => { gitCalls.commit.push({ p, o }); return commitImpl(p, o) },
  getCommit: (p: string, r: string) => { gitCalls.getCommit.push({ p, r }); return getCommitImpl(p, r) },
  saveCheckpointMetadata: (p: string, m: any) => {
    gitCalls.saveCheckpointMetadata.push({ p, m })
    return saveCheckpointMetadataImpl(p, m)
  },
  getStatus: (p: string) => { gitCalls.getStatus.push(p); return getStatusImpl(p) },
  checkout: (p: string, r: string, o: any) => { gitCalls.checkout.push({ p, r, o }); return checkoutImpl(p, r, o) },
  getDiff: (p: string, f: string, t: string) => { gitCalls.getDiff.push({ p, f, t }); return getDiffImpl(p, f, t) },
}))

// github.service (lazy-imported by syncAfterCheckpoint)
let ghIsConfigured = true
let pushSpy: { calls: any[]; impl: (...a: any[]) => Promise<any> } = {
  calls: [],
  impl: async () => ({}),
}
mock.module('../github.service', () => ({
  isConfigured: () => ghIsConfigured,
  pushToGitHub: (projectId: string, workspacePath: string) => {
    pushSpy.calls.push({ projectId, workspacePath })
    return pushSpy.impl(projectId, workspacePath)
  },
}))

// fs / fs/promises / child_process
let existsImpl: (p: string) => boolean = () => true
const fsCalls = { mkdir: [] as string[], unlink: [] as string[] }
let unlinkImpl: (p: string) => Promise<void> = async (p: string) => { fsCalls.unlink.push(p) }

mock.module('fs', () => ({
  existsSync: (p: string) => existsImpl(p),
  mkdirSync: (p: string) => { fsCalls.mkdir.push(p) },
}))

mock.module('fs/promises', () => ({
  writeFile: async () => {},
  readFile: async () => '',
  unlink: (p: string) => unlinkImpl(p),
}))

const execCalls: { cmd: string; opts?: any }[] = []
let execImpl: (cmd: string, opts?: any) => string | Buffer = () => ''

mock.module('child_process', () => ({
  execSync: (cmd: string, opts?: any) => {
    execCalls.push({ cmd, opts })
    return execImpl(cmd, opts)
  },
}))

const svc = await import('../checkpoint.service')

// ─── helpers ────────────────────────────────────────────────────────────────

function seedProject(o: Partial<Project> & { id: string }): Project {
  const p: Project = { workingMode: 'managed', ...o }
  db.projects.set(p.id, p)
  return p
}

function seedCheckpoint(o: Partial<Checkpoint> & { projectId: string }): Checkpoint {
  const c: Checkpoint = {
    id: o.id ?? id('cp'),
    projectId: o.projectId,
    commitSha: 'sha_existing',
    commitMessage: 'msg',
    branch: 'main',
    name: null,
    description: null,
    filesChanged: 1,
    additions: 0,
    deletions: 0,
    includesDb: false,
    isAutomatic: false,
    createdBy: null,
    createdAt: new Date(),
    ...o,
  }
  db.checkpoints.set(c.id, c)
  return c
}

beforeEach(() => {
  db.projects.clear()
  db.checkpoints.clear()
  db.ghConns.clear()
  prismaCalls.createCheckpoint.length = 0
  prismaCalls.deleteManyCheckpoint.length = 0
  for (const k of Object.keys(gitCalls)) (gitCalls as any)[k].length = 0
  pushSpy.calls.length = 0
  pushSpy.impl = async () => ({})
  ghIsConfigured = true
  fsCalls.mkdir.length = 0
  fsCalls.unlink.length = 0
  execCalls.length = 0
  existsImpl = () => true
  unlinkImpl = async (p: string) => { fsCalls.unlink.push(p) }
  execImpl = () => ''
  initRepoImpl = async () => ({ branch: 'main' })
  commitImpl = async () => ({
    sha: 'sha_new', message: 'msg', filesChanged: 1, additions: 2, deletions: 3,
  } as any)
  getCommitImpl = async () => ({
    sha: 'sha_head', message: 'head msg', filesChanged: 4, additions: 5, deletions: 6,
  } as any)
  getStatusImpl = async () => ({ hasChanges: false } as any)
  checkoutImpl = async () => ({ success: true } as any)
  getDiffImpl = async () => ({
    files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1 }],
    totalAdditions: 1, totalDeletions: 1,
  } as any)
  saveCheckpointMetadataImpl = async () => {}
  nextId = 0
  delete process.env.PROJECTS_DATABASE_URL
  delete process.env.DATABASE_URL
})

afterEach(async () => {
  // Drain the fire-and-forget syncAfterCheckpoint Promises so they finish
  // before the next test mutates the spy/mocks. queueMicrotask gives them
  // one event-loop tick to run.
  await new Promise((r) => setTimeout(r, 0))
})

// ─── CheckpointsDisabledError ────────────────────────────────────────────────

describe('CheckpointsDisabledError', () => {
  it('has the canonical code + name', () => {
    const e = new svc.CheckpointsDisabledError()
    expect(e.code).toBe('checkpoints_disabled_in_external_mode')
    expect(e.name).toBe('CheckpointsDisabledError')
    expect(e.message).toMatch(/external \(folder-linked\) projects/)
  })
})

// ─── createCheckpoint ────────────────────────────────────────────────────────

describe('createCheckpoint — gating + happy path', () => {
  it('throws CheckpointsDisabledError when project.workingMode === "external"', async () => {
    seedProject({ id: 'p_ext', workingMode: 'external' })
    await expect(
      svc.createCheckpoint({ projectId: 'p_ext', workspacePath: '/ws', message: 'm' }),
    ).rejects.toBeInstanceOf(svc.CheckpointsDisabledError)
  })

  it('proceeds when project is missing entirely (defense-in-depth allows null)', async () => {
    await expect(
      svc.createCheckpoint({ projectId: 'p_none', workspacePath: '/ws', message: 'm' }),
    ).resolves.toBeDefined()
  })

  it('throws when workspace dir does not exist', async () => {
    seedProject({ id: 'p1' })
    existsImpl = () => false
    await expect(
      svc.createCheckpoint({ projectId: 'p1', workspacePath: '/missing', message: 'm' }),
    ).rejects.toThrow(/Workspace not found: \/missing/)
  })

  it('creates the .shogo directory when missing', async () => {
    seedProject({ id: 'p2' })
    existsImpl = (p: string) => !p.endsWith('.shogo') // workspace exists, .shogo doesn't
    await svc.createCheckpoint({
      projectId: 'p2', workspacePath: '/ws', message: 'm',
    })
    expect(fsCalls.mkdir.some((d) => d.endsWith('.shogo'))).toBe(true)
  })

  it('skips mkdir for .shogo when it already exists', async () => {
    seedProject({ id: 'p2b' })
    existsImpl = () => true
    await svc.createCheckpoint({
      projectId: 'p2b', workspacePath: '/ws', message: 'm',
    })
    expect(fsCalls.mkdir).toEqual([])
  })

  it('persists a new commit + checkpoint row, returns the mapped result', async () => {
    seedProject({ id: 'p3' })
    const out = await svc.createCheckpoint({
      projectId: 'p3', workspacePath: '/ws', message: 'my msg',
      name: 'n', description: 'd', createdBy: 'u',
    })
    expect(out.commitSha).toBe('sha_new')
    expect(out.filesChanged).toBe(1)
    expect(out.additions).toBe(2)
    expect(out.deletions).toBe(3)
    expect(out.name).toBe('n')
    expect(out.description).toBe('d')
    expect(out.includesDb).toBe(false)
    expect(prismaCalls.createCheckpoint).toHaveLength(1)
    expect(gitCalls.saveCheckpointMetadata).toHaveLength(1)
  })

  it('includes a database snapshot when includeDatabase=true and DATABASE_URL is set', async () => {
    seedProject({ id: 'p_db' })
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d'
    await svc.createCheckpoint({
      projectId: 'p_db', workspacePath: '/ws', message: 'm',
      includeDatabase: true,
    })
    expect(execCalls.some((c) => c.cmd.startsWith('pg_dump'))).toBe(true)
    const env = execCalls.find((c) => c.cmd.startsWith('pg_dump'))!.opts.env
    expect(env.PGHOST).toBe('h')
    expect(env.PGPORT).toBe('5432')
    expect(env.PGUSER).toBe('u')
    expect(env.PGPASSWORD).toBe('p')
  })

  it('warns and skips DB snapshot when no DATABASE_URL is set', async () => {
    seedProject({ id: 'p_db2' })
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      await svc.createCheckpoint({
        projectId: 'p_db2', workspacePath: '/ws', message: 'm', includeDatabase: true,
      })
      expect(warns.some((w) => w.includes('No database URL configured'))).toBe(true)
      expect(execCalls.some((c) => c.cmd.startsWith('pg_dump'))).toBe(false)
    } finally {
      console.warn = orig
    }
  })

  it('defaults port to 5432 when URL has no port', async () => {
    seedProject({ id: 'p_db3' })
    process.env.DATABASE_URL = 'postgres://u:p@h/d'
    await svc.createCheckpoint({
      projectId: 'p_db3', workspacePath: '/ws', message: 'm', includeDatabase: true,
    })
    const env = execCalls.find((c) => c.cmd.startsWith('pg_dump'))!.opts.env
    expect(env.PGPORT).toBe('5432')
  })

  it('cleans up the partial snapshot file when pg_dump fails', async () => {
    seedProject({ id: 'p_db4' })
    process.env.DATABASE_URL = 'postgres://u:p@h/d'
    execImpl = (cmd: string) => {
      if (cmd.startsWith('pg_dump')) throw new Error('pg_dump failed')
      return ''
    }
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      await expect(
        svc.createCheckpoint({
          projectId: 'p_db4', workspacePath: '/ws', message: 'm', includeDatabase: true,
        }),
      ).rejects.toThrow(/pg_dump failed/)
      expect(fsCalls.unlink).toHaveLength(1)
    } finally {
      console.error = orig
    }
  })

  it('swallows unlink failure during snapshot cleanup', async () => {
    seedProject({ id: 'p_db5' })
    process.env.DATABASE_URL = 'postgres://u:p@h/d'
    execImpl = (cmd: string) => {
      if (cmd.startsWith('pg_dump')) throw new Error('pg_dump failed')
      return ''
    }
    unlinkImpl = async () => { throw new Error('also failed') }
    await expect(
      svc.createCheckpoint({
        projectId: 'p_db5', workspacePath: '/ws', message: 'm', includeDatabase: true,
      }),
    ).rejects.toThrow(/pg_dump failed/) // still rethrown
  })

  it('uses PROJECTS_DATABASE_URL when set (preferred over DATABASE_URL)', async () => {
    seedProject({ id: 'p_db6' })
    process.env.PROJECTS_DATABASE_URL = 'postgres://x:y@h2:6432/db2'
    process.env.DATABASE_URL = 'postgres://other:other@bad:1/never'
    await svc.createCheckpoint({
      projectId: 'p_db6', workspacePath: '/ws', message: 'm', includeDatabase: true,
    })
    const env = execCalls.find((c) => c.cmd.startsWith('pg_dump'))!.opts.env
    expect(env.PGHOST).toBe('h2')
    expect(env.PGUSER).toBe('x')
  })
})

describe('createCheckpoint — no changes to commit', () => {
  it('returns the existing checkpoint row when one already exists for HEAD', async () => {
    seedProject({ id: 'p_nc' })
    commitImpl = async () => null as any // no changes
    seedCheckpoint({
      id: 'cp_existing', projectId: 'p_nc', commitSha: 'sha_head', commitMessage: 'prev',
    })
    const out = await svc.createCheckpoint({
      projectId: 'p_nc', workspacePath: '/ws', message: 'new attempt',
    })
    expect(out.id).toBe('cp_existing')
    expect(out.message).toBe('prev')
    expect(prismaCalls.createCheckpoint).toHaveLength(0)
  })

  it('creates a checkpoint for HEAD when no prior checkpoint exists', async () => {
    seedProject({ id: 'p_nc2' })
    commitImpl = async () => null as any
    const out = await svc.createCheckpoint({
      projectId: 'p_nc2', workspacePath: '/ws', message: 'capture HEAD',
    })
    expect(out.commitSha).toBe('sha_head')
    expect(out.filesChanged).toBe(4)
    expect(prismaCalls.createCheckpoint).toHaveLength(1)
    // saveCheckpointMetadata is NOT called on the "no changes" path
    expect(gitCalls.saveCheckpointMetadata).toHaveLength(0)
  })

  it('uses HEAD commit.message when caller-provided message is empty', async () => {
    seedProject({ id: 'p_nc3' })
    commitImpl = async () => null as any
    const out = await svc.createCheckpoint({
      projectId: 'p_nc3', workspacePath: '/ws', message: '',
    })
    expect(out.message).toBe('head msg')
  })

  it('throws when no commits exist at all (empty repo + no changes)', async () => {
    seedProject({ id: 'p_nc4' })
    commitImpl = async () => null as any
    getCommitImpl = async () => null as any
    await expect(
      svc.createCheckpoint({ projectId: 'p_nc4', workspacePath: '/ws', message: 'm' }),
    ).rejects.toThrow(/No commits in repository and no changes to commit/)
  })
})

// ─── syncAfterCheckpoint (fire-and-forget) ──────────────────────────────────

describe('syncAfterCheckpoint', () => {
  it('is a no-op when no GitHub connection exists', async () => {
    await svc.syncAfterCheckpoint('p1', '/ws')
    expect(pushSpy.calls).toHaveLength(0)
  })

  it('is a no-op when connection.syncEnabled=false', async () => {
    db.ghConns.set('p2', { projectId: 'p2', syncEnabled: false })
    await svc.syncAfterCheckpoint('p2', '/ws')
    expect(pushSpy.calls).toHaveLength(0)
  })

  it('is a no-op when github.service.isConfigured() returns false', async () => {
    db.ghConns.set('p3', { projectId: 'p3', syncEnabled: true })
    ghIsConfigured = false
    await svc.syncAfterCheckpoint('p3', '/ws')
    expect(pushSpy.calls).toHaveLength(0)
  })

  it('fires github.pushToGitHub when connection + isConfigured', async () => {
    db.ghConns.set('p4', { projectId: 'p4', syncEnabled: true })
    await svc.syncAfterCheckpoint('p4', '/ws')
    // tick to flush microtask
    await new Promise((r) => setTimeout(r, 0))
    expect(pushSpy.calls).toEqual([{ projectId: 'p4', workspacePath: '/ws' }])
  })

  it('logs but swallows push failure', async () => {
    db.ghConns.set('p5', { projectId: 'p5', syncEnabled: true })
    pushSpy.impl = async () => { throw new Error('push exploded') }
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      await svc.syncAfterCheckpoint('p5', '/ws')
      await new Promise((r) => setTimeout(r, 0))
      expect(warns.some((w) => w.includes('Auto-sync to GitHub failed'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  it('logs but swallows top-level errors (prisma.findUnique throws)', async () => {
    // Reach into the prisma mock and replace findUnique with a throwing impl.
    const prismaMod = (await import('../../lib/prisma')) as any
    const origFindUnique = prismaMod.prisma.gitHubConnection.findUnique
    prismaMod.prisma.gitHubConnection.findUnique = async () => {
      throw new Error('prisma exploded')
    }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      await svc.syncAfterCheckpoint('p6', '/ws')
      expect(warns.some((w) => w.includes('syncAfterCheckpoint error'))).toBe(true)
    } finally {
      console.warn = origWarn
      prismaMod.prisma.gitHubConnection.findUnique = origFindUnique
    }
  })
})

// ─── listCheckpoints / getCheckpoint / getCheckpointByCommit ────────────────

describe('listCheckpoints', () => {
  it('returns checkpoints newest-first, limited to 50 by default', async () => {
    seedProject({ id: 'p' })
    for (let i = 0; i < 3; i++) {
      seedCheckpoint({
        projectId: 'p',
        id: `cp_${i}`,
        commitSha: `s${i}`,
        createdAt: new Date(2024, 0, i + 1),
      })
    }
    const out = await svc.listCheckpoints('p')
    expect(out.map((c) => c.commitSha)).toEqual(['s2', 's1', 's0'])
  })

  it('respects the `before` cursor', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      projectId: 'p', id: 'cp_old', commitSha: 's_old',
      createdAt: new Date(2024, 0, 1),
    })
    seedCheckpoint({
      projectId: 'p', id: 'cp_mid', commitSha: 's_mid',
      createdAt: new Date(2024, 0, 5),
    })
    seedCheckpoint({
      projectId: 'p', id: 'cp_new', commitSha: 's_new',
      createdAt: new Date(2024, 0, 10),
    })
    const out = await svc.listCheckpoints('p', { before: 'cp_mid' })
    expect(out.map((c) => c.commitSha)).toEqual(['s_old'])
  })

  it('honors a custom limit', async () => {
    seedProject({ id: 'p' })
    for (let i = 0; i < 5; i++) {
      seedCheckpoint({
        projectId: 'p', id: `cp_${i}`, commitSha: `s${i}`,
        createdAt: new Date(2024, 0, i + 1),
      })
    }
    const out = await svc.listCheckpoints('p', { limit: 2 })
    expect(out).toHaveLength(2)
  })

  it('ignores `before` when the cursor checkpoint does not exist', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({ projectId: 'p', id: 'cp_a' })
    const out = await svc.listCheckpoints('p', { before: 'cp_missing' })
    expect(out).toHaveLength(1)
  })
})

describe('getCheckpoint', () => {
  it('maps the row to CheckpointResult', async () => {
    seedCheckpoint({ id: 'cp_one', projectId: 'p', commitSha: 's', commitMessage: 'm' })
    const out = await svc.getCheckpoint('cp_one')
    expect(out!.id).toBe('cp_one')
    expect(out!.message).toBe('m')
  })

  it('returns null when missing', async () => {
    expect(await svc.getCheckpoint('nope')).toBeNull()
  })
})

describe('getCheckpointByCommit', () => {
  it('finds the matching checkpoint', async () => {
    seedCheckpoint({ projectId: 'p', id: 'cp_x', commitSha: 'sha_x' })
    const out = await svc.getCheckpointByCommit('p', 'sha_x')
    expect(out!.id).toBe('cp_x')
  })

  it('returns null when not found', async () => {
    expect(await svc.getCheckpointByCommit('p', 'nope')).toBeNull()
  })
})

// ─── rollback ────────────────────────────────────────────────────────────────

describe('rollback', () => {
  it('returns error when the checkpoint does not exist', async () => {
    const out = await svc.rollback({ projectId: 'p', workspacePath: '/ws', checkpointId: 'nope' })
    expect(out.success).toBe(false)
    expect(out.error).toBe('Checkpoint not found')
  })

  it('returns error when checkpoint belongs to a different project', async () => {
    seedCheckpoint({ id: 'cp_x', projectId: 'other_proj', commitSha: 's' })
    const out = await svc.rollback({ projectId: 'mine', workspacePath: '/ws', checkpointId: 'cp_x' })
    expect(out.success).toBe(false)
    expect(out.error).toBe('Checkpoint does not belong to this project')
  })

  it('creates a pre-rollback checkpoint when workspace has changes', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({ id: 'cp_target', projectId: 'p', commitSha: 'sha_target', branch: 'main' })
    getStatusImpl = async () => ({ hasChanges: true } as any)
    const out = await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_target',
    })
    expect(out.success).toBe(true)
    // Two checkpoints created: pre-rollback auto-save + rollback marker
    expect(prismaCalls.createCheckpoint.length).toBeGreaterThanOrEqual(1)
    expect(out.newCheckpoint).not.toBeNull()
  })

  it('logs and continues when pre-rollback checkpoint creation throws', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({ id: 'cp_target', projectId: 'p', commitSha: 'sha_target', branch: 'main' })
    getStatusImpl = async () => ({ hasChanges: true } as any)
    // Make createCheckpoint's internal commit call throw
    let firstCall = true
    commitImpl = async () => {
      if (firstCall) {
        firstCall = false
        throw new Error('commit failed')
      }
      return { sha: 'sha_post', message: 'm', filesChanged: 0, additions: 0, deletions: 0 } as any
    }
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const out = await svc.rollback({
        projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_target',
      })
      expect(out.success).toBe(true)
      expect(warns.some((w) => w.includes('Failed to create pre-rollback'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  it('returns failure with the git error when checkout fails', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_chk', projectId: 'p', commitSha: 'sha_chk', branch: 'main', name: 'My CP',
    })
    checkoutImpl = async () => ({ success: false, error: 'merge conflict' } as any)
    const out = await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_chk',
    })
    expect(out.success).toBe(false)
    expect(out.error).toBe('merge conflict')
    expect(out.previousCheckpoint.name).toBe('My CP')
  })

  it('uses default "Git checkout failed" message when checkout error is absent', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({ id: 'cp_chk2', projectId: 'p', commitSha: 'sha_x', branch: 'main' })
    checkoutImpl = async () => ({ success: false } as any) // no error message
    const out = await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_chk2',
    })
    expect(out.error).toBe('Git checkout failed')
  })

  it('restores database when includeDatabase=true AND checkpoint.includesDb=true', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_db', projectId: 'p', commitSha: 'sha_db', branch: 'main', includesDb: true,
    })
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d'
    existsImpl = () => true // snapshot file exists
    await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_db', includeDatabase: true,
    })
    expect(execCalls.some((c) => c.cmd.startsWith('gunzip -c'))).toBe(true)
  })

  it('logs but does not fail when database restore throws', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_db2', projectId: 'p', commitSha: 'sha_db', branch: 'main', includesDb: true,
    })
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d'
    execImpl = (cmd: string) => {
      if (cmd.startsWith('gunzip')) throw new Error('gunzip failed')
      return ''
    }
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const out = await svc.rollback({
        projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_db2', includeDatabase: true,
      })
      expect(out.success).toBe(true)
      expect(errs.some((e) => e.includes('Database restore failed'))).toBe(true)
    } finally {
      console.error = orig
    }
  })

  it('skips DB restore when no snapshot file exists', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_db3', projectId: 'p', commitSha: 'sha_db', branch: 'main', includesDb: true,
    })
    process.env.DATABASE_URL = 'postgres://u:p@h/d'
    existsImpl = (p: string) => !p.endsWith('database.sql.gz')
    await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_db3', includeDatabase: true,
    })
    expect(execCalls.some((c) => c.cmd.startsWith('gunzip'))).toBe(false)
  })

  it('skips DB restore when DATABASE_URL is unset', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_db4', projectId: 'p', commitSha: 'sha_db', branch: 'main', includesDb: true,
    })
    await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_db4', includeDatabase: true,
    })
    expect(execCalls.some((c) => c.cmd.startsWith('gunzip'))).toBe(false)
  })

  it('logs but does not fail when post-rollback checkpoint creation throws', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({ id: 'cp_post', projectId: 'p', commitSha: 'sha_x', branch: 'main' })
    // No pre-rollback auto-save (clean tree), so the only createCheckpoint call
    // is the post-rollback marker. Make its internal commit throw.
    commitImpl = async () => { throw new Error('commit failed') }
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const out = await svc.rollback({
        projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_post',
      })
      expect(out.success).toBe(true)
      expect(out.newCheckpoint).toBeNull()
      expect(warns.some((w) => w.includes('Failed to create post-rollback'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  it('restores the checkpoint tree without rewriting history (read-tree, no reset --hard)', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({ id: 'cp_tree', projectId: 'p', commitSha: 'sha_target', branch: 'main' })
    const out = await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_tree',
    })
    expect(out.success).toBe(true)
    // Tree is restored with read-tree -u --reset (HEAD stays on the branch tip).
    expect(execCalls.some((c) => c.cmd === 'git read-tree -u --reset sha_target')).toBe(true)
    // The destructive branch rewind must not happen anymore.
    expect(execCalls.some((c) => c.cmd.includes('reset --hard'))).toBe(false)
    // We only ever checkout the branch, never detach onto the commit.
    expect(gitCalls.checkout.every((c: any) => c.r === 'main')).toBe(true)
  })

  it('returns failure when restoring the checkpoint tree fails', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_rt_fail', projectId: 'p', commitSha: 'sha_target', branch: 'main', name: 'Tree CP',
    })
    execImpl = (cmd: string) => {
      if (cmd.startsWith('git read-tree')) throw new Error('read-tree boom')
      return ''
    }
    const out = await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_rt_fail',
    })
    expect(out.success).toBe(false)
    expect(out.error).toBe('read-tree boom')
    expect(out.previousCheckpoint.name).toBe('Tree CP')
  })

  it('uses short SHA in messages when checkpoint.name is null', async () => {
    seedProject({ id: 'p' })
    seedCheckpoint({
      id: 'cp_noname', projectId: 'p', commitSha: 'abcdef0123456789', branch: 'main', name: null,
    })
    getStatusImpl = async () => ({ hasChanges: true } as any)
    await svc.rollback({
      projectId: 'p', workspacePath: '/ws', checkpointId: 'cp_noname',
    })
    const preRollback = prismaCalls.createCheckpoint.find((c) =>
      typeof c.commitMessage === 'string' && c.commitMessage.includes('abcdef0'))
    expect(preRollback).toBeDefined()
  })
})

// ─── getDiff ─────────────────────────────────────────────────────────────────

describe('getDiff', () => {
  it('returns null when the from-checkpoint is missing', async () => {
    expect(await svc.getDiff('/ws', 'nope')).toBeNull()
  })

  it('diffs from checkpoint to HEAD by default', async () => {
    seedCheckpoint({ id: 'cp_from', projectId: 'p', commitSha: 'sha_from' })
    const out = await svc.getDiff('/ws', 'cp_from')
    expect(out!.commitSha).toBe('sha_from')
    expect(gitCalls.getDiff[0]).toEqual({ p: '/ws', f: 'sha_from', t: 'HEAD' })
  })

  it('diffs between two checkpoints when toCheckpointId is provided', async () => {
    seedCheckpoint({ id: 'cp_from', projectId: 'p', commitSha: 'sha_a' })
    seedCheckpoint({ id: 'cp_to', projectId: 'p', commitSha: 'sha_b' })
    await svc.getDiff('/ws', 'cp_from', 'cp_to')
    expect(gitCalls.getDiff[0]).toEqual({ p: '/ws', f: 'sha_a', t: 'sha_b' })
  })

  it('falls back to HEAD when the to-checkpoint id is given but missing', async () => {
    seedCheckpoint({ id: 'cp_from', projectId: 'p', commitSha: 'sha_a' })
    await svc.getDiff('/ws', 'cp_from', 'nope')
    expect(gitCalls.getDiff[0]).toEqual({ p: '/ws', f: 'sha_a', t: 'HEAD' })
  })
})

// ─── getProjectStatus / ensureGitRepo ───────────────────────────────────────

describe('getProjectStatus', () => {
  it('delegates to gitService.getStatus', async () => {
    getStatusImpl = async () => ({ hasChanges: true, branch: 'main' } as any)
    const out = await svc.getProjectStatus('/ws')
    expect((out as any).hasChanges).toBe(true)
  })
})

describe('ensureGitRepo', () => {
  it('creates the workspace dir when it does not exist, then init-s the repo', async () => {
    existsImpl = () => false
    await svc.ensureGitRepo('/missing-ws')
    expect(fsCalls.mkdir).toContain('/missing-ws')
    expect(gitCalls.initRepo).toContain('/missing-ws')
  })

  it('skips mkdir when the workspace already exists', async () => {
    existsImpl = () => true
    await svc.ensureGitRepo('/ws')
    expect(fsCalls.mkdir).toEqual([])
    expect(gitCalls.initRepo).toContain('/ws')
  })
})

// ─── pruneCheckpoints ────────────────────────────────────────────────────────

describe('pruneCheckpoints', () => {
  it('returns 0 when count is at-or-below keepCount', async () => {
    seedProject({ id: 'p' })
    for (let i = 0; i < 5; i++) {
      seedCheckpoint({
        projectId: 'p', id: `cp_${i}`, createdAt: new Date(2024, 0, i + 1),
      })
    }
    expect(await svc.pruneCheckpoints('p', { keepCount: 10 })).toBe(0)
  })

  it('returns 0 when nothing matches the retention filter', async () => {
    // 5 named checkpoints, all recent — keepCount=2, but the rest are within
    // the keepDays window AND named → filter returns false → nothing pruned.
    seedProject({ id: 'p' })
    const recent = new Date()
    for (let i = 0; i < 5; i++) {
      seedCheckpoint({
        projectId: 'p', id: `cp_${i}`, name: 'kept-named',
        createdAt: new Date(recent.getTime() - i * 1000),
      })
    }
    expect(await svc.pruneCheckpoints('p', { keepCount: 2, keepDays: 365 })).toBe(0)
  })

  it('prunes everything older than keepCount that is unnamed or beyond keepDays', async () => {
    seedProject({ id: 'p' })
    const longAgo = new Date(2020, 0, 1)
    const recent = new Date()
    for (let i = 0; i < 3; i++) {
      seedCheckpoint({
        projectId: 'p', id: `cp_recent_${i}`,
        createdAt: new Date(recent.getTime() - i * 1000),
      })
    }
    for (let i = 0; i < 3; i++) {
      seedCheckpoint({
        projectId: 'p', id: `cp_old_${i}`,
        createdAt: new Date(longAgo.getTime() + i * 1000),
      })
    }
    const pruned = await svc.pruneCheckpoints('p', { keepCount: 2, keepDays: 30 })
    expect(pruned).toBeGreaterThan(0)
    expect(prismaCalls.deleteManyCheckpoint).toHaveLength(1)
  })

  it('respects keepCount + keepDays defaults', async () => {
    seedProject({ id: 'p' })
    for (let i = 0; i < 110; i++) {
      seedCheckpoint({
        projectId: 'p', id: `cp_${i}`,
        createdAt: new Date(Date.now() - i * 60_000),
      })
    }
    expect(await svc.pruneCheckpoints('p')).toBeGreaterThan(0)
  })
})
