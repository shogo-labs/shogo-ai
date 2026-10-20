// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-61 Part A — checkpoints on a private ref, never on the user's branch.
 *
 * Unlike `checkpoint.service.test.ts` (which mocks git.service), this suite
 * runs the REAL git service against throwaway repositories, so it asserts the
 * acceptance invariants directly: branch tip, working-tree status, commit log,
 * the refs/shogo/checkpoints namespace, and what the snapshot tree contains.
 * Prisma is an in-memory stub — the DB shape is not what this card is about.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ─── in-memory prisma ────────────────────────────────────────────────────────

type ProjectRow = {
  id: string
  workingMode?: string | null
  settings?: unknown
  githubConnection?: { id: string } | null
}
type CheckpointRow = Record<string, any>

const db = {
  projects: new Map<string, ProjectRow>(),
  checkpoints: new Map<string, CheckpointRow>(),
  ghConns: new Map<string, { projectId: string; syncEnabled: boolean }>(),
}
let nextId = 0

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where, select }: any) => {
        const row = db.projects.get(where.id)
        if (!row) return null
        if (!select) return row
        const out: any = {}
        for (const key of Object.keys(select)) {
          if (select[key]) out[key] = (row as any)[key] ?? null
        }
        return out
      },
    },
    projectCheckpoint: {
      findUnique: async ({ where }: any) => db.checkpoints.get(where.id) ?? null,
      findFirst: async ({ where }: any) => {
        for (const row of db.checkpoints.values()) {
          if (where.id && row.id !== where.id) continue
          if (where.projectId && row.projectId !== where.projectId) continue
          if (where.commitSha && row.commitSha !== where.commitSha) continue
          return row
        }
        return null
      },
      findMany: async ({ where }: any) => {
        let rows = [...db.checkpoints.values()].filter((c) => c.projectId === where.projectId)
        rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return rows
      },
      create: async ({ data }: any) => {
        const row: CheckpointRow = {
          id: `cp_${++nextId}`,
          createdAt: new Date(Date.now() + nextId),
          name: null,
          description: null,
          filesChanged: 0,
          additions: 0,
          deletions: 0,
          includesDb: false,
          isAutomatic: false,
          createdBy: null,
          mode: 'branch',
          refName: null,
          ...data,
        }
        db.checkpoints.set(row.id, row)
        return row
      },
      deleteMany: async ({ where }: any) => {
        let count = 0
        for (const id of where.id.in) if (db.checkpoints.delete(id)) count++
        return { count }
      },
    },
    gitHubConnection: {
      findUnique: async ({ where }: any) => db.ghConns.get(where.projectId) ?? null,
    },
  },
}))

// A push must never happen for a ref-mode checkpoint: fail the suite if it does.
const pushCalls: any[] = []
mock.module('../github.service', () => ({
  isConfigured: () => true,
  pushToGitHub: (projectId: string, workspace: unknown) => {
    pushCalls.push({ projectId, workspace })
    return Promise.resolve({ success: true, pushed: true, pulled: false, commits: 1 })
  },
}))
mock.module('../github-workspace', () => ({
  runtimeGitHubWorkspace: (projectId: string) => ({ runtimeFor: projectId }),
}))

const checkpointService = await import('../checkpoint.service')
const gitService = await import('../git.service')

// ─── helpers ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sho61-'))
  tmpDirs.push(dir)
  return dir
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim()
}

function seedProject(o: { id: string; github?: boolean; settings?: unknown }): ProjectRow {
  const row: ProjectRow = {
    id: o.id,
    workingMode: 'managed',
    settings: o.settings ?? null,
    githubConnection: o.github ? { id: `${o.id}-conn` } : null,
  }
  db.projects.set(o.id, row)
  if (o.github) db.ghConns.set(o.id, { projectId: o.id, syncEnabled: true })
  return row
}

/** A repo with a tracked file, untracked source, memory history and ignored junk. */
async function seedDirtyRepo(): Promise<string> {
  const dir = makeRepo()
  await gitService.initRepo(dir)
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n- lesson one\n')
  mkdirSync(join(dir, '.shogo/memory-history/MEMORY.md'), { recursive: true })
  writeFileSync(join(dir, '.shogo/memory-history/MEMORY.md/2026-10-19.md'), '# Memory\n')
  writeFileSync(join(dir, '.shogo/index.db'), 'not project content\n')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist/app.js'), 'built\n')
  return dir
}

beforeEach(() => {
  db.projects.clear()
  db.checkpoints.clear()
  db.ghConns.clear()
  pushCalls.length = 0
  nextId = 0
  delete process.env.SHOGO_CHECKPOINT_MODE
})

afterAll(() => {
  delete process.env.SHOGO_CHECKPOINT_MODE
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// ─── resolveCheckpointMode ───────────────────────────────────────────────────

describe('resolveCheckpointMode', () => {
  it('defaults to ref for a GitHub-connected project and branch for a local-only one', () => {
    expect(checkpointService.resolveCheckpointMode({ githubConnection: { id: 'c' } })).toBe('ref')
    expect(checkpointService.resolveCheckpointMode({ githubConnection: null })).toBe('branch')
    expect(checkpointService.resolveCheckpointMode(null)).toBe('branch')
  })

  it('honours a project-level settings.checkpointMode override', () => {
    expect(
      checkpointService.resolveCheckpointMode({
        githubConnection: { id: 'c' },
        settings: { checkpointMode: 'branch' },
      }),
    ).toBe('branch')
    expect(
      checkpointService.resolveCheckpointMode({
        githubConnection: null,
        settings: { checkpointMode: 'ref' },
      }),
    ).toBe('ref')
  })

  it('lets SHOGO_CHECKPOINT_MODE override the project setting (kill switch)', () => {
    process.env.SHOGO_CHECKPOINT_MODE = 'branch'
    expect(
      checkpointService.resolveCheckpointMode({
        githubConnection: { id: 'c' },
        settings: { checkpointMode: 'ref' },
      }),
    ).toBe('branch')
  })

  it('ignores an unrecognised value in either source', () => {
    process.env.SHOGO_CHECKPOINT_MODE = 'nonsense'
    expect(
      checkpointService.resolveCheckpointMode({
        githubConnection: { id: 'c' },
        settings: { checkpointMode: 'sideways' },
      }),
    ).toBe('ref')
  })

  it('lets the operator kill switch and a project setting outrank a caller hint', () => {
    // The workspace auto-checkpoint passes `ref` for a connected project…
    expect(
      checkpointService.resolveCheckpointMode({ githubConnection: { id: 'c' } }, 'ref'),
    ).toBe('ref')
    // …but the kill switch wins, so an emergency rollback needs no code change.
    process.env.SHOGO_CHECKPOINT_MODE = 'branch'
    expect(
      checkpointService.resolveCheckpointMode({ githubConnection: { id: 'c' } }, 'ref'),
    ).toBe('branch')
    delete process.env.SHOGO_CHECKPOINT_MODE
    // …and so does the project owner's explicit setting.
    expect(
      checkpointService.resolveCheckpointMode(
        { githubConnection: { id: 'c' }, settings: { checkpointMode: 'branch' } },
        'ref',
      ),
    ).toBe('branch')
  })
})

// ─── createCheckpoint on a connected project ─────────────────────────────────

describe('createCheckpoint — ref mode (GitHub-connected project)', () => {
  it('records a snapshot on refs/shogo/checkpoints without touching the branch', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true })

    const headBefore = git(dir, 'rev-parse', 'main')
    const statusBefore = git(dir, 'status', '--porcelain')
    const logBefore = git(dir, 'log', '--oneline')

    const result = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: write_file (2 tool calls)',
      isAutomatic: true,
    })

    // The branch is untouched: same tip, same dirty tree, same log.
    expect(git(dir, 'rev-parse', 'main')).toBe(headBefore)
    expect(git(dir, 'status', '--porcelain')).toBe(statusBefore)
    expect(git(dir, 'log', '--oneline')).toBe(logBefore)

    // Exactly one snapshot ref, and the row points at it.
    expect(result.mode).toBe('ref')
    expect(result.refName).toMatch(/^refs\/shogo\/checkpoints\/main\//)
    const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/shogo/checkpoints')
      .split('\n')
      .filter(Boolean)
    expect(refs).toEqual([result.refName as string])
    expect(git(dir, 'rev-parse', result.refName as string)).toBe(result.commitSha)

    const row = db.checkpoints.get(result.id)!
    expect(row.mode).toBe('ref')
    expect(row.refName).toBe(result.refName as string)
    expect(row.commitSha).toBe(result.commitSha)

    // Nothing was pushed for a snapshot.
    expect(pushCalls).toHaveLength(0)
  })

  it('captures untracked source and memory history, and honours .gitignore', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true })

    const result = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: edit',
      isAutomatic: true,
    })

    const tree = git(dir, 'ls-tree', '-r', '--name-only', result.commitSha).split('\n')
    expect(tree).toContain('a.ts')
    expect(tree).toContain('MEMORY.md')
    expect(tree).toContain('.shogo/memory-history/MEMORY.md/2026-10-19.md')
    expect(tree).not.toContain('.shogo/index.db')
    expect(tree).not.toContain('dist/app.js')
  })

  it('does not move HEAD, the real index or the working tree', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true })

    const headBefore = git(dir, 'symbolic-ref', 'HEAD')
    const indexBefore = git(dir, 'ls-files', '--stage')
    const contentBefore = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')

    await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: edit',
    })

    expect(git(dir, 'symbolic-ref', 'HEAD')).toBe(headBefore)
    expect(git(dir, 'ls-files', '--stage')).toBe(indexBefore)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe(contentBefore)
    // No stray temp index left behind in .git/.
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false)
  })

  it('reuses the HEAD row instead of inventing an empty snapshot on a clean tree', async () => {
    const dir = makeRepo()
    await gitService.initRepo(dir)
    seedProject({ id: 'p1', github: true })

    const first = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'baseline',
      isAutomatic: true,
    })
    // Clean tree: no snapshot, so the row describes the real HEAD commit.
    expect(first.mode).toBe('branch')
    expect(first.commitSha).toBe(git(dir, 'rev-parse', 'HEAD'))

    const second = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'again',
      isAutomatic: true,
    })
    expect(second.id).toBe(first.id)
    expect(git(dir, 'for-each-ref', 'refs/shogo/checkpoints')).toBe('')
  })
})

describe('createCheckpoint — branch mode still the old behaviour', () => {
  it('commits onto the branch for a local-only project', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p2' })

    const logBefore = git(dir, 'log', '--oneline').split('\n').length
    const result = await checkpointService.createCheckpoint({
      projectId: 'p2',
      workspacePath: dir,
      message: 'AI: local checkpoint',
      isAutomatic: true,
    })

    expect(result.mode).toBe('branch')
    expect(result.refName).toBeNull()
    expect(git(dir, 'log', '--oneline').split('\n').length).toBe(logBefore + 1)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(result.commitSha)
    expect(git(dir, 'for-each-ref', 'refs/shogo/checkpoints')).toBe('')
  })

  it('records a branch commit when SHOGO_CHECKPOINT_MODE=branch is set', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true })
    process.env.SHOGO_CHECKPOINT_MODE = 'branch'

    const result = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: kill switch',
    })

    expect(result.mode).toBe('branch')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(result.commitSha)
  })

  it('records a branch commit when the project opts out via settings.checkpointMode', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true, settings: { checkpointMode: 'branch' } })

    const result = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: opted out',
    })

    expect(result.mode).toBe('branch')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(result.commitSha)
  })
})

// ─── rollback ────────────────────────────────────────────────────────────────

describe('rollback from a ref checkpoint', () => {
  it('restores the working tree byte-for-byte and leaves the branch tip alone', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true })

    const snapshot = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: before the mistake',
    })
    const original = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
    const tipBefore = git(dir, 'rev-parse', 'main')

    // The mistake.
    writeFileSync(join(dir, 'MEMORY.md'), '- Agent booted at 12:00\n')
    writeFileSync(join(dir, 'a.ts'), 'export const a = 999\n')

    const result = await checkpointService.rollback({
      projectId: 'p1',
      workspacePath: dir,
      checkpointId: snapshot.id,
    })

    expect(result.success).toBe(true)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe(original)
    expect(readFileSync(join(dir, 'a.ts'), 'utf-8')).toBe('export const a = 1\n')
    expect(git(dir, 'rev-parse', 'main')).toBe(tipBefore)
    expect(result.newCheckpoint?.mode).toBe('ref')
  })
})

// ─── prune ───────────────────────────────────────────────────────────────────

describe('pruneCheckpoints', () => {
  it('deletes the ref alongside the row so git can collect the objects', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p1', github: true })

    const first = await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: one',
    })
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
    await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: two',
    })
    writeFileSync(join(dir, 'c.ts'), 'export const c = 3\n')
    await checkpointService.createCheckpoint({
      projectId: 'p1',
      workspacePath: dir,
      message: 'AI: three',
    })

    expect(git(dir, 'rev-parse', '--verify', first.refName as string)).toBe(first.commitSha)

    const pruned = await checkpointService.pruneCheckpoints('p1', {
      keepCount: 1,
      keepDays: 0,
      workspacePath: dir,
    })

    expect(pruned).toBe(2)
    expect(db.checkpoints.size).toBe(1)
    // The pruned row's ref is gone; the survivor's is still there.
    expect(() => git(dir, 'rev-parse', '--verify', first.refName as string)).toThrow()

    git(dir, 'gc', '--prune=now', '--quiet')
    const dangling = git(dir, 'fsck', '--no-reflogs', '--unreachable')
      .split('\n')
      .filter((line) => line.includes('dangling commit'))
    expect(dangling).toEqual([])
  })
})

// ─── back-compat ─────────────────────────────────────────────────────────────

describe('legacy branch checkpoints', () => {
  it('pins a refs/shogo/checkpoints/legacy ref the first time a diff reads one', async () => {
    const dir = await seedDirtyRepo()
    seedProject({ id: 'p2' })

    const legacy = await checkpointService.createCheckpoint({
      projectId: 'p2',
      workspacePath: dir,
      message: 'AI: legacy branch checkpoint',
    })
    expect(legacy.mode).toBe('branch')

    await checkpointService.getDiff(dir, legacy.id)

    const legacyRef = `refs/shogo/checkpoints/legacy/${legacy.commitSha}`
    expect(git(dir, 'rev-parse', '--verify', legacyRef)).toBe(legacy.commitSha)
    // Pinning is idempotent.
    await checkpointService.getDiff(dir, legacy.id)
    expect(git(dir, 'rev-parse', '--verify', legacyRef)).toBe(legacy.commitSha)
  })
})
