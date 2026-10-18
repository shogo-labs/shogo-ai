// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-11 acceptance tests — real git, real filesystem.
 *
 * The unit tests next door mock `git.service`, so they can only prove that
 * `initRepo`/`commit` were never *called*. This file runs the real git binary
 * against a throwaway repo, because the damage SHO-11 describes is git state:
 * an appended `.gitignore`, a rewritten `user.*`, a `git rm --cached`, and an
 * `AI:` commit that ends up in someone else's PR.
 *
 * Only Prisma is mocked — there is no database in this suite's scope, and the
 * assertion we need from it ("no ProjectCheckpoint row") is exactly a check on
 * which Prisma calls were made.
 *
 * Acceptance criteria covered:
 *  - foreign `origin`, no `GitHubConnection`: no commit, `.gitignore` and
 *    `.git/config` `user.*` byte-identical, no checkpoint row, no `.shogo`;
 *  - rollback on the same repo refuses before any `checkout`/`read-tree`;
 *  - `GitHubConnection` present: still checkpoints (the gate is not over-broad);
 *  - no `origin` at all: still checkpoints exactly as today.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── prisma mock (the only mocked module) ────────────────────────────────────

type ProjectRow = { id: string; workingMode: string | null; hasGithubConnection: boolean }
type CheckpointRow = Record<string, any>

const db = {
  projects: new Map<string, ProjectRow>(),
  checkpoints: new Map<string, CheckpointRow>(),
  createdCheckpoints: [] as any[],
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where, select }: any) => {
        const p = db.projects.get(where.id)
        if (!p) return null
        if (!select) return p
        // Mirrors Prisma's nested select for the relation: null when absent.
        return {
          id: p.id,
          workingMode: p.workingMode,
          githubConnection: select.githubConnection
            ? p.hasGithubConnection
              ? { id: 'gh_conn_1' }
              : null
            : undefined,
        }
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
      findMany: async ({ where }: any) =>
        [...db.checkpoints.values()].filter((c) => c.projectId === where.projectId),
      create: async ({ data }: any) => {
        const row = { id: `cp_${db.checkpoints.size + 1}`, createdAt: new Date(), ...data }
        db.checkpoints.set(row.id, row)
        db.createdCheckpoints.push(row)
        return row
      },
      deleteMany: async () => ({ count: 0 }),
      update: async ({ where, data }: any) => ({ ...db.checkpoints.get(where.id), ...data }),
    },
    // syncAfterCheckpoint() bails out when there is no connection row.
    gitHubConnection: { findUnique: async () => null },
  },
}))

const svc = await import('../checkpoint.service')
const git = await import('../git.service')

// ─── real-git helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = []

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * A committed repo owned by somebody else: `origin` points at their GitHub and
 * `.git/config` carries their identity. This is the hand-made clone an agent
 * project is created from.
 */
function makeForeignRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sho11-foreign-'))
  tmpDirs.push(root)
  sh(root, 'init', '-b', 'main')
  sh(root, 'config', 'user.name', 'Repo Owner')
  sh(root, 'config', 'user.email', 'owner@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  writeFileSync(join(root, 'app.ts'), 'export const v = 1\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-m', 'initial')
  sh(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
  return root
}

/** A fresh, never-tracked folder — what Shogo's own `initRepo` sees. */
function makePlainFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'sho11-plain-'))
  tmpDirs.push(root)
  writeFileSync(join(root, 'app.ts'), 'export const v = 1\n')
  return root
}

function seedProject(id: string, opts: { workingMode?: string; githubConnection?: boolean } = {}) {
  db.projects.set(id, {
    id,
    workingMode: opts.workingMode ?? 'managed',
    hasGithubConnection: opts.githubConnection ?? false,
  })
}

beforeEach(() => {
  db.projects.clear()
  db.checkpoints.clear()
  db.createdCheckpoints.length = 0
})

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

// ─── getOriginRemoteUrl ──────────────────────────────────────────────────────

describe('getOriginRemoteUrl (real git)', () => {
  it('returns the configured origin URL, trimmed', async () => {
    const repo = makeForeignRepo()
    expect(await git.getOriginRemoteUrl(repo)).toBe('https://github.com/acme/app.git')
  })

  it('returns null for a repo with no origin, and for a non-repo folder', async () => {
    const plain = makePlainFolder()
    sh(plain, 'init', '-b', 'main')
    expect(await git.getOriginRemoteUrl(plain)).toBeNull()
    expect(await git.getOriginRemoteUrl(makePlainFolder())).toBeNull()
  })
})

// ─── the bug itself ──────────────────────────────────────────────────────────

describe('createCheckpoint on a repo Shogo does not own (real git)', () => {
  it('writes nothing: no commit, no .gitignore edit, no identity rewrite, no row', async () => {
    const repo = makeForeignRepo()
    seedProject('p_foreign')

    // The agent turn's edit — uncommitted, exactly like a real turn.
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2\n')

    const gitignoreBefore = sha256(join(repo, '.gitignore'))
    const gitignoreTextBefore = readFileSync(join(repo, '.gitignore'), 'utf-8')
    const configBefore = readFileSync(join(repo, '.git', 'config'), 'utf-8')
    const headBefore = sh(repo, 'rev-parse', 'HEAD')
    const countBefore = sh(repo, 'rev-list', '--count', 'HEAD')

    await expect(
      svc.createCheckpoint({ projectId: 'p_foreign', workspacePath: repo, message: 'AI: edit (1 tool call)' }),
    ).rejects.toMatchObject({ code: 'checkpoints_disabled_foreign_repo' })

    // No commit landed on their branch (this is what reached PR #1477).
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(sh(repo, 'rev-list', '--count', 'HEAD')).toBe(countBefore)
    expect(sh(repo, 'log', '-1', '--pretty=%s')).toBe('initial')
    // …and the edit is still sitting there uncommitted, not swallowed.
    expect(sh(repo, 'status', '--porcelain')).toContain('app.ts')

    // initRepo's three side effects never happened.
    expect(sha256(join(repo, '.gitignore'))).toBe(gitignoreBefore)
    expect(readFileSync(join(repo, '.gitignore'), 'utf-8')).toBe(gitignoreTextBefore)
    expect(sh(repo, 'config', '--get', 'user.name')).toBe('Repo Owner')
    expect(sh(repo, 'config', '--get', 'user.email')).toBe('owner@example.com')
    expect(readFileSync(join(repo, '.git', 'config'), 'utf-8')).toBe(configBefore)
    // Shogo never even started tracking state in their folder.
    expect(existsSync(join(repo, '.shogo'))).toBe(false)

    // No ProjectCheckpoint row.
    expect(db.createdCheckpoints).toEqual([])
    expect(db.checkpoints.size).toBe(0)
  })

  it('still commits the same repo once a GitHubConnection hands it to Shogo', async () => {
    const repo = makeForeignRepo()
    seedProject('p_connected', { githubConnection: true })
    writeFileSync(join(repo, 'app.ts'), 'export const v = 3\n')

    const headBefore = sh(repo, 'rev-parse', 'HEAD')
    const cp = await svc.createCheckpoint({
      projectId: 'p_connected',
      workspacePath: repo,
      message: 'AI: edit (1 tool call)',
    })

    expect(cp.id).toBeTruthy()
    expect(sh(repo, 'rev-parse', 'HEAD')).not.toBe(headBefore)
    expect(db.createdCheckpoints.length).toBe(1)
    expect(sh(repo, 'status', '--porcelain')).toBe('')
  })

  it('still checkpoints a folder with no origin, initialising the repo as today', async () => {
    const folder = makePlainFolder()
    seedProject('p_owned')

    const cp = await svc.createCheckpoint({
      projectId: 'p_owned',
      workspacePath: folder,
      message: 'Workspace baseline',
      isAutomatic: true,
    })

    expect(cp.id).toBeTruthy()
    expect(existsSync(join(folder, '.git'))).toBe(true)
    // initRepo commits the initial tree itself; the checkpoint then records HEAD.
    expect(sh(folder, 'log', '-1', '--pretty=%s')).toBe('Initial commit')
    expect(await git.getOriginRemoteUrl(folder)).toBeNull()
    expect(db.createdCheckpoints.length).toBe(1)
  })

  it('keeps external mode on its own error code and message', async () => {
    const repo = makeForeignRepo()
    seedProject('p_ext', { workingMode: 'external' })
    await expect(
      svc.createCheckpoint({ projectId: 'p_ext', workspacePath: repo, message: 'm' }),
    ).rejects.toMatchObject({ code: 'checkpoints_disabled_in_external_mode' })
    expect(db.createdCheckpoints).toEqual([])
  })
})

// ─── rollback ────────────────────────────────────────────────────────────────

describe('rollback on a repo Shogo does not own (real git)', () => {
  it('refuses without checking out or resetting the working tree', async () => {
    const repo = makeForeignRepo()
    seedProject('p_foreign')
    const headBefore = sh(repo, 'rev-parse', 'HEAD')
    db.checkpoints.set('cp_target', {
      id: 'cp_target',
      projectId: 'p_foreign',
      commitSha: headBefore,
      branch: 'main',
      commitMessage: 'initial',
      name: 'Target',
      description: null,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      includesDb: false,
      isAutomatic: false,
      createdAt: new Date(),
    })

    // A dirty working tree the checkpoint's pre-rollback save would commit.
    writeFileSync(join(repo, 'app.ts'), 'export const v = 9\n')

    await expect(
      svc.rollback({ projectId: 'p_foreign', workspacePath: repo, checkpointId: 'cp_target' }),
    ).rejects.toMatchObject({ code: 'checkpoints_disabled_foreign_repo' })

    // No pre-rollback commit, no checkout, no read-tree, edit still intact.
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(sh(repo, 'status', '--porcelain')).toContain('app.ts')
    expect(readFileSync(join(repo, 'app.ts'), 'utf-8')).toBe('export const v = 9\n')
    expect(sh(repo, 'config', '--get', 'user.email')).toBe('owner@example.com')
    expect(db.createdCheckpoints).toEqual([])
  })
})

// ─── workspace turns ─────────────────────────────────────────────────────────

describe('workspace auto-checkpoint on a foreign repo (real git)', () => {
  it('reports skipped-foreign-repo and leaves the folder untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sho11-ws-'))
    tmpDirs.push(root)
    const folder = join(root, 'p2')
    mkdirSync(folder)
    sh(folder, 'init', '-b', 'main')
    sh(folder, 'config', 'user.name', 'Repo Owner')
    sh(folder, 'config', 'user.email', 'owner@example.com')
    writeFileSync(join(folder, '.gitignore'), 'node_modules\n')
    sh(folder, 'add', '-A')
    sh(folder, 'commit', '-m', 'initial')
    sh(folder, 'remote', 'add', 'origin', 'git@github.com:acme/other.git')
    writeFileSync(join(folder, 'x.ts'), 'export const x = 1\n')

    seedProject('p2')
    const headBefore = sh(folder, 'rev-parse', 'HEAD')
    const gitignoreBefore = sha256(join(folder, '.gitignore'))

    const { autoCheckpointWorkspaceProjects } = await import('../workspace-checkpoint.service')
    const results = await autoCheckpointWorkspaceProjects(['p2'], {
      workspacesDir: root,
      _loadProjectMeta: async () =>
        new Map([['p2', { workingMode: 'managed', hasGithubConnection: false }]]),
    })

    expect(results).toEqual([{ projectId: 'p2', status: 'skipped-foreign-repo' }])
    expect(sh(folder, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(sha256(join(folder, '.gitignore'))).toBe(gitignoreBefore)
    expect(sh(folder, 'config', '--get', 'user.name')).toBe('Repo Owner')
    expect(sh(folder, 'status', '--porcelain')).toContain('x.ts')
    expect(db.createdCheckpoints).toEqual([])
  })
})
