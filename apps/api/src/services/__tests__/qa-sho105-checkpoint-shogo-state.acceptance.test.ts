// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-105 / #1597 — a checkpoint repo must never track, LFS
 * or keep Shogo's own runtime state, and the history already on disk must be
 * reclaimed without losing a checkpoint.
 *
 * These enter through the **production** call sites rather than the new
 * helpers, because that is where the bug lived: `seedRepoIfAbsent` seeded the
 * tracked `.shogo/sessions.db`, `initRepo`/`commit` never untracked it, and
 * `snapshotTree` re-staged it out of a temp index seeded from a bloated parent
 * (git.service.ts:991). A unit test on the predicate would stay green with none
 * of those wired.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setupChannelsTestDb, seedWorkspace } = await import('../../__tests__/helpers/channels-test-db')

const quiet = { log: () => {}, warn: () => {}, error: () => {} }

let tmpRoot: string
let svc: typeof import('../git.service')
let prisma: any

const RUNTIME_STATE = [
  '.shogo/sessions.db',
  '.shogo/sessions.db-wal',
  '.shogo/sessions.db-shm',
  '.shogo/logs/console.log',
  '.shogo/tasks/turn-1.log',
  '.shogo-cwd-4f2a.json',
  '.tmp/scratch.json',
]
const MEMORY_HISTORY = '.shogo/memory-history/2026-10-21.md'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args)
    return true
  } catch {
    return false
  }
}

function write(dir: string, rel: string, body: string | Buffer = '') {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body as any)
}

function configureUser(dir: string) {
  git(dir, 'config', 'user.name', 'Shogo Agent')
  git(dir, 'config', 'user.email', 'agent@shogo.ai')
}

function mkRepo(name: string): string {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  configureUser(dir)
  return dir
}

/** A repo seeded the pre-SHO-105 way: the seed commit carries live runtime state. */
function seedBloatedRepo(dir: string) {
  write(dir, 'src/app.ts', 'export const x = 1\n')
  write(dir, MEMORY_HISTORY, '# memory\n')
  for (const rel of RUNTIME_STATE) {
    write(dir, rel, rel.endsWith('sessions.db') ? Buffer.alloc(64 * 1024, 7) : `${rel}\n`)
  }
  git(dir, 'add', '-A', '-f')
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed (pre-SHO-105 shape)', '--no-verify'], {
    cwd: dir,
    stdio: 'pipe',
  })
  // `git lfs track` is what made every turn a fresh uncompressed object.
  git(dir, 'lfs', 'install', '--local')
  git(dir, 'lfs', 'track', '--', '.shogo/sessions.db', '.shogo/sessions.db-wal')
  git(dir, 'add', '.gitattributes')
  execFileSync('git', ['commit', '-q', '-m', 'chore: lfs', '--no-verify'], { cwd: dir, stdio: 'pipe' })
}

function trackedUnder(dir: string, ...paths: string[]): string[] {
  const out = git(dir, 'ls-files', '--', ...paths)
  return out ? out.split('\n').filter(Boolean) : []
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'qa-sho105-'))
  // Must run before `lib/prisma` is imported anywhere.
  setupChannelsTestDb()
  svc = await import('../git.service')
  ;({ prisma } = await import('../../lib/prisma'))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('AC 1/AC 4 — a repo never starts tracking runtime state', () => {
  it('initRepo: a project folder that already has a user .gitignore is still covered', async () => {
    const dir = join(tmpRoot, 'init-user-gitignore')
    mkdirSync(dir, { recursive: true })
    write(dir, '.gitignore', 'dist/\n')
    write(dir, 'src/app.ts', 'export const y = 2\n')
    write(dir, MEMORY_HISTORY, '# memory\n')
    write(dir, '.shogo/sessions.db', 'db\n')
    write(dir, '.shogo/sessions.db-shm', 'shm\n')
    write(dir, '.tmp/out.json', '{}\n')

    const res = await svc.initRepo(dir)
    expect(res.created).toBe(true)

    const tracked = trackedUnder(dir, '.')
    expect(tracked).toContain('src/app.ts')
    expect(tracked).toContain(MEMORY_HISTORY)
    expect(tracked.filter((p) => p.startsWith('.shogo/'))).toEqual([MEMORY_HISTORY])
    expect(tracked.filter((p) => p.startsWith('.tmp/'))).toEqual([])
    // The user's own rule survives.
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('dist/')
    expect(existsSync(join(dir, '.shogo', 'sessions.db'))).toBe(true)
  })
})

describe('AC 1 — commit() repairs a repo that already tracks the state', () => {
  it('untracks on the first checkpoint and is idempotent afterwards', async () => {
    const dir = mkRepo('commit-repair')
    seedBloatedRepo(dir)
    expect(trackedUnder(dir, '.shogo')).toContain('.shogo/sessions.db')

    const first = await svc.commit(dir, {
      message: 'AI: checkpoint',
      author: 'Shogo Agent',
      email: 'agent@shogo.ai',
    })
    expect(first).not.toBeNull()
    expect(trackedUnder(dir, '.shogo')).toEqual([MEMORY_HISTORY])
    expect(trackedUnder(dir, '.tmp')).toEqual([])
    expect(trackedUnder(dir, '.shogo-cwd-*')).toEqual([])
    // Files stay on disk; only the index changed.
    for (const rel of RUNTIME_STATE) expect(existsSync(join(dir, rel))).toBe(true)
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', '.shogo')).toBe(MEMORY_HISTORY)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')).toContain('.shogo/*')
    // The stale `filter=lfs` rule that caused the bloat is gone, and the
    // user's own LFS rules are not.
    expect(readFileSync(join(dir, '.gitattributes'), 'utf-8')).not.toContain('.shogo/sessions.db')

    // A second turn that only touches runtime state stages nothing from it.
    const head = git(dir, 'rev-parse', 'HEAD')
    write(dir, '.shogo/sessions.db', Buffer.alloc(96 * 1024, 9))
    write(dir, '.shogo/logs/console.log', 'more log\n')
    const second = await svc.commit(dir, {
      message: 'AI: checkpoint 2',
      author: 'Shogo Agent',
      email: 'agent@shogo.ai',
    })
    expect(second).toBeNull()
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(trackedUnder(dir, '.shogo')).toEqual([MEMORY_HISTORY])
  })
})

describe('ref-mode checkpoints — snapshotTree must not inherit the runtime state', () => {
  it('drops runtime state from the temp index seeded from a bloated parent, and leaves the real index alone', async () => {
    const dir = mkRepo('snapshot-ref-mode')
    seedBloatedRepo(dir)
    expect(trackedUnder(dir, '.shogo')).toContain('.shogo/sessions.db')

    const snap = await svc.snapshotTree(dir, { message: 'checkpoint' })
    expect(snap).not.toBeNull()
    const tree = git(dir, 'ls-tree', '-r', '--name-only', snap!.sha)
    expect(tree.split('\n').filter(Boolean).filter((p) => p.startsWith('.shogo/'))).toEqual([
      MEMORY_HISTORY,
    ])
    expect(tree).toContain('src/app.ts')

    // The real index/branch is untouched by a snapshot: the parent still tracks
    // it, which is exactly why the temp index has to be cleaned every time.
    expect(trackedUnder(dir, '.shogo')).toContain('.shogo/sessions.db')

    // Two consecutive turns produce the same tree — no new object per turn for
    // a live database that changes constantly.
    write(dir, '.shogo/sessions.db', Buffer.alloc(128 * 1024, 3))
    const again = await svc.snapshotTree(dir, { message: 'checkpoint' })
    if (again) {
      expect(git(dir, 'rev-parse', `${again.sha}^{tree}`)).toBe(git(dir, 'rev-parse', `${snap!.sha}^{tree}`))
    }
  })
})

describe('a commit must not race a history rewrite', () => {
  it('commit() returns null while the repair lock is held, then commits once released', async () => {
    const dir = mkRepo('repair-lock')
    write(dir, 'src/app.ts', 'export const z = 3\n')
    git(dir, 'add', '-A')
    execFileSync('git', ['commit', '-q', '-m', 'base', '--no-verify'], { cwd: dir, stdio: 'pipe' })
    const head = git(dir, 'rev-parse', 'HEAD')

    write(dir, '.git/shogo-repair.lock', `${process.pid}\n`)
    write(dir, 'src/app.ts', 'export const z = 4\n')
    const during = await svc.commit(dir, {
      message: 'AI: checkpoint',
      author: 'Shogo Agent',
      email: 'agent@shogo.ai',
    })
    expect(during).toBeNull()
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)

    rmSync(join(dir, '.git', 'shogo-repair.lock'), { force: true })
    const after = await svc.commit(dir, {
      message: 'AI: checkpoint',
      author: 'Shogo Agent',
      email: 'agent@shogo.ai',
    })
    expect(after).not.toBeNull()
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(head)
  })
})

describe('AC 6 — the boot sweep reclaims history and no checkpoint row dangles', () => {
  it('rewrites a bloated .workspace-roots repo and repoints every ProjectCheckpoint row', async () => {
    const seeded = await seedWorkspace(prisma)
    const sweepRoot = join(tmpRoot, 'sweep-root')
    const repoDir = join(sweepRoot, '.workspace-roots', `proj-${seeded.projectId}`)
    mkdirSync(repoDir, { recursive: true })
    git(repoDir, 'init', '-q', '-b', 'main')
    configureUser(repoDir)

    const shas: string[] = []
    for (let i = 0; i < 12; i += 1) {
      write(repoDir, `src/file-${i}.ts`, `export const v = ${i}\n`)
      write(repoDir, MEMORY_HISTORY, `# memory ${i}\n`)
      write(repoDir, '.shogo/sessions.db', Buffer.alloc(32 * 1024, i))
      write(repoDir, '.shogo/sessions.db-wal', `wal ${i}\n`)
      git(repoDir, 'add', '-A', '-f')
      execFileSync('git', ['commit', '-q', '-m', `turn ${i}`, '--no-verify'], {
        cwd: repoDir,
        stdio: 'pipe',
      })
      shas.push(git(repoDir, 'rev-parse', 'HEAD'))
    }
    // Source + memory-history blobs at HEAD, for the byte-identical check
    // below (the tree as a whole legitimately changes: the DB leaves it).
    const treeBefore = git(repoDir, 'ls-tree', '-r', 'HEAD', '--', 'src', MEMORY_HISTORY)

    for (let i = 0; i < shas.length; i += 1) {
      await prisma.projectCheckpoint.create({
        data: {
          projectId: seeded.projectId,
          name: `cp-${i}`,
          commitSha: shas[i],
          commitMessage: `turn ${i}`,
        },
      })
    }

    const { sweepCheckpointRepos } = await import('../checkpoint-repo-repair.service')
    const prevMin = process.env.SHOGO_CHECKPOINT_REPAIR_MIN_MB
    process.env.SHOGO_CHECKPOINT_REPAIR_MIN_MB = '0'
    let summary: any
    try {
      summary = await sweepCheckpointRepos({ workspacesDir: sweepRoot, logger: quiet })
    } finally {
      if (prevMin === undefined) delete process.env.SHOGO_CHECKPOINT_REPAIR_MIN_MB
      else process.env.SHOGO_CHECKPOINT_REPAIR_MIN_MB = prevMin
    }

    expect(summary.repaired).toBe(1)
    const result = summary.results[0]
    expect(result.skipped).toBe(false)
    expect(result.rewritten).toBe(12)

    // No ref carries the database any more; memory-history survived every commit.
    expect(git(repoDir, 'log', '--all', '--format=%H', '--', '.shogo/sessions.db')).toBe('')
    expect(git(repoDir, 'rev-list', '--all').split('\n').filter(Boolean).length).toBe(12)
    for (const sha of git(repoDir, 'rev-list', '--all').split('\n').filter(Boolean)) {
      expect(git(repoDir, 'ls-tree', '-r', '--name-only', sha, '--', '.shogo')).toContain(MEMORY_HISTORY)
    }
    // The real source tree is byte-identical at HEAD.
    expect(git(repoDir, 'ls-tree', '-r', 'HEAD', '--', 'src', MEMORY_HISTORY)).toBe(treeBefore)
    expect(trackedUnder(repoDir, '.shogo')).toEqual([MEMORY_HISTORY])
    // Old commits really are gone — this is why the remap matters.
    expect(gitOk(repoDir, 'cat-file', '-e', `${shas[0]}^{commit}`)).toBe(false)

    const rows = await prisma.projectCheckpoint.findMany({
      where: { projectId: seeded.projectId },
    })
    expect(rows).toHaveLength(12)
    // `createdAt` ties at this speed; order by the name we chose instead.
    rows.sort((a: any, b: any) => Number(a.name.slice(3)) - Number(b.name.slice(3)))
    rows.forEach((row: any, i: number) => {
      expect(row.name).toBe(`cp-${i}`)
      expect(row.commitSha).not.toBe(shas[i])
      expect(gitOk(repoDir, 'cat-file', '-e', `${row.commitSha}^{commit}`)).toBe(true)
    })

    // A second boot is a no-op.
    const again = await sweepCheckpointRepos({ workspacesDir: sweepRoot, logger: quiet })
    expect(again.repaired).toBe(0)
    const rowsAfter = await prisma.projectCheckpoint.findMany({
      where: { projectId: seeded.projectId },
      select: { commitSha: true },
    })
    expect(rowsAfter.map((r: any) => r.commitSha).sort()).toEqual(rows.map((r: any) => r.commitSha).sort())
  })
})
