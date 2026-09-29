// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end durability of a project's git history across a runtime restart,
 * against real git + tar (no mocks).
 *
 * Regression for the 2026-09 metal data loss, where:
 *   - the agent's own `git commit` left a clean tree, so the sync saw
 *     "nothing staged" and never persisted it;
 *   - a fresh guest seeded `.git` from the template before the host restored
 *     the durable one, and the durable `.git` was overlaid onto it without
 *     rebuilding the working tree;
 *   - a half-failed seed left an empty `.git` that became durable history.
 */

import { describe, test, expect } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitWorkspaceSync } from '../git-sync'
import {
  AdoptDeadlineError,
  adoptHydratedRepo,
  adoptHydratedRepoBefore,
  getHeadSha,
  normalizeKeepPaths,
  packRepoArchive,
  seedRepoIfAbsent,
} from '../repo-store'
import { applyGitSafeDirectoryEnv } from '../git-safe-dir'

const NOOP = { log: () => {}, warn: () => {}, error: () => {} }
const STAGING = '.shogo/local/repo-staging'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' },
  }).trim()
}

function write(dir: string, rel: string, contents: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), contents)
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Host side of a cold boot: extract the durable `.git` into the staging dir. */
function stageDurableRepo(archive: string, workspace: string): string {
  const staging = join(workspace, STAGING)
  mkdirSync(staging, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', staging])
  return staging
}

describe('metal git durability across a restart', () => {
  test("the agent's own commit is persisted and a fresh workspace restores exactly that HEAD", async () => {
    const ws1 = tmp('dur-pod1-')
    const ws2 = tmp('dur-pod2-')
    const store = join(tmp('dur-store-'), 'repo.git.tar.gz')
    try {
      write(ws1, 'src/App.tsx', 'v1\n')
      await seedRepoIfAbsent(ws1, { logger: NOOP })

      const persisted: string[] = []
      const sync = new GitWorkspaceSync({
        workspaceDir: ws1,
        cloudApiUrl: 'http://unused',
        runtimeAuthSecret: 'x',
        projectId: 'p1',
        localOnly: true,
        debounceMs: 5,
        logger: NOOP,
        stageExcludes: ['.shogo/local'],
        afterCommit: async (sha) => {
          await packRepoArchive(ws1, store)
          persisted.push(sha)
        },
      })

      // The agent edits and commits from its own shell: nothing is left staged.
      write(ws1, 'src/App.tsx', 'v2 — halo login\n')
      git(ws1, 'add', '-A')
      git(ws1, 'commit', '-q', '-m', 'halo login screen')
      const agentSha = git(ws1, 'rev-parse', 'HEAD')
      expect(git(ws1, 'status', '--porcelain')).toBe('')

      sync.triggerSync(true)
      await until(() => persisted.includes(agentSha))

      // Fresh guest: source from the (older) suspend backup, a throwaway `.git`
      // seeded from that tree before the host's hydrate landed, and runtime
      // state that is not in git.
      write(ws2, 'src/App.tsx', 'v1\n')
      await seedRepoIfAbsent(ws2, { logger: NOOP })
      write(ws2, 'prisma/dev.db', 'users')

      const res = await adoptHydratedRepo(ws2, stageDurableRepo(store, ws2), { logger: NOOP })

      expect(res.headSha).toBe(agentSha)
      expect(await getHeadSha(ws2)).toBe(agentSha)
      expect(readFileSync(join(ws2, 'src/App.tsx'), 'utf-8')).toBe('v2 — halo login\n')
      expect(readFileSync(join(ws2, 'prisma/dev.db'), 'utf-8')).toBe('users')
      expect(existsSync(join(ws2, STAGING))).toBe(false)
      // The older source tree was a tracked diff against HEAD: kept, not lost.
      expect(res.preservedRef).toMatch(/^refs\/shogo\/pre-hydrate\//)
      expect(git(ws2, 'show', `${res.preservedRef}:src/App.tsx`)).toBe('v1')
      // And the next auto-commit has nothing to revert.
      expect(git(ws2, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    } finally {
      for (const d of [ws1, ws2, join(store, '..')]) rmSync(d, { recursive: true, force: true })
    }
  })

  test('the staging dir is never committed by the sync', async () => {
    const ws = tmp('dur-exclude-')
    try {
      write(ws, 'a.txt', '1')
      await seedRepoIfAbsent(ws, { logger: NOOP })
      mkdirSync(join(ws, STAGING, '.git'), { recursive: true })
      writeFileSync(join(ws, STAGING, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      write(ws, 'a.txt', '2')
      let done = false
      const sync = new GitWorkspaceSync({
        workspaceDir: ws,
        cloudApiUrl: 'http://unused',
        runtimeAuthSecret: 'x',
        projectId: 'p1',
        localOnly: true,
        debounceMs: 5,
        logger: NOOP,
        stageExcludes: ['.shogo/local'],
        afterCommit: () => { done = true },
      })
      sync.triggerSync(true)
      await until(() => done)
      expect(git(ws, 'ls-files')).toBe('a.txt')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('adopting a durable repo with no commits leaves the hydrated tree alone', async () => {
    const ws = tmp('dur-unborn-')
    const empty = tmp('dur-empty-')
    try {
      git(empty, 'init', '-q', '-b', 'main')
      const archive = join(empty, '..', `${Date.now()}-empty.tar.gz`)
      await packRepoArchive(empty, archive)

      write(ws, 'src/App.tsx', 'real source\n')
      await seedRepoIfAbsent(ws, { logger: NOOP })

      const res = await adoptHydratedRepo(ws, stageDurableRepo(archive, ws), { logger: NOOP })
      expect(res).toEqual({ headSha: null, reset: false, preservedRef: null })
      expect(readFileSync(join(ws, 'src/App.tsx'), 'utf-8')).toBe('real source\n')
      rmSync(archive, { force: true })
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('adopt refuses to run without a staged .git (and touches nothing)', async () => {
    const ws = tmp('dur-nostage-')
    try {
      write(ws, 'a.txt', '1')
      await seedRepoIfAbsent(ws, { logger: NOOP })
      const head = await getHeadSha(ws)
      await expect(adoptHydratedRepo(ws, join(ws, STAGING), { logger: NOOP })).rejects.toThrow('no staged .git')
      expect(await getHeadSha(ws)).toBe(head)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

/**
 * 2026-09-28: a workspace's durable repo stopped advancing (its exports were
 * refused) while the source backup kept up with the user. Every cold boot then
 * reset the hydrated tree to the stale HEAD, and the next source backup saved
 * the rewound tree.
 */
describe('a stale durable repo never rewinds newer source', () => {
  /** Durable repo at `files`, packed as the host would store it. Returns the archive and its HEAD. */
  async function durableRepoAt(files: Record<string, string>): Promise<{ archive: string; sha: string; dir: string }> {
    const dir = tmp('dur-stale-')
    for (const [rel, body] of Object.entries(files)) write(dir, rel, body)
    await seedRepoIfAbsent(dir, { logger: NOOP })
    const archive = join(dir, '..', `${Date.now()}-${Math.random().toString(36).slice(2)}-repo.tar.gz`)
    await packRepoArchive(dir, archive)
    return { archive, sha: git(dir, 'rev-parse', 'HEAD'), dir }
  }

  /** A fresh guest: the (newer) source backup hydrated, and a throwaway seeded `.git`. */
  async function freshGuest(files: Record<string, string>): Promise<string> {
    const ws = tmp('dur-guest-')
    for (const [rel, body] of Object.entries(files)) write(ws, rel, body)
    await seedRepoIfAbsent(ws, { logger: NOOP })
    return ws
  }

  test('without keepPaths the reset rewinds tracked files to the stale HEAD (the incident)', async () => {
    const repo = await durableRepoAt({ 'src/App.tsx': 'v1\n' })
    const ws = await freshGuest({ 'src/App.tsx': 'v2 — the user kept working\n' })
    try {
      await adoptHydratedRepo(ws, stageDurableRepo(repo.archive, ws), { logger: NOOP })
      expect(readFileSync(join(ws, 'src/App.tsx'), 'utf-8')).toBe('v1\n')
    } finally {
      for (const d of [ws, repo.dir]) rmSync(d, { recursive: true, force: true })
      rmSync(repo.archive, { force: true })
    }
  })

  test("keepPaths ['.'] keeps the newer tree on top of the durable history", async () => {
    const repo = await durableRepoAt({ 'src/App.tsx': 'v1\n', 'src/Old.tsx': 'old\n' })
    const ws = await freshGuest({ 'src/App.tsx': 'v2 — the user kept working\n', 'src/Login.tsx': 'login\n' })
    try {
      const res = await adoptHydratedRepo(ws, stageDurableRepo(repo.archive, ws), { logger: NOOP, keepPaths: ['.'] })
      expect(res).toMatchObject({ reset: false, keptPaths: ['.'] })
      expect(readFileSync(join(ws, 'src/App.tsx'), 'utf-8')).toBe('v2 — the user kept working\n')
      expect(readFileSync(join(ws, 'src/Login.tsx'), 'utf-8')).toBe('login\n')
      // The newer tree is committed on top of the durable history, so any
      // repo export from here on carries it rather than the stale HEAD.
      expect(res.headSha).toBe(git(ws, 'rev-parse', 'HEAD'))
      expect(git(ws, 'rev-parse', 'HEAD^')).toBe(repo.sha)
      expect(git(ws, 'show', 'HEAD:src/App.tsx')).toBe('v2 — the user kept working')
      expect(git(ws, 'show', 'HEAD:src/Login.tsx')).toBe('login')
      expect(git(ws, 'status', '--porcelain')).toBe('')
      expect(existsSync(join(ws, STAGING))).toBe(false)
    } finally {
      for (const d of [ws, repo.dir]) rmSync(d, { recursive: true, force: true })
      rmSync(repo.archive, { force: true })
    }
  })

  test('a workspace runtime keeps only the members whose source is newer', async () => {
    const repo = await durableRepoAt({ 'm1/App.tsx': 'm1 v1\n', 'm2/App.tsx': 'm2 v3\n', 'README.md': 'root\n' })
    const ws = await freshGuest({ 'm1/App.tsx': 'm1 v2\n', 'm2/App.tsx': 'm2 v2 (older than the repo)\n', 'README.md': 'root\n' })
    try {
      const res = await adoptHydratedRepo(ws, stageDurableRepo(repo.archive, ws), { logger: NOOP, keepPaths: ['m1'] })
      expect(res).toMatchObject({ reset: true, keptPaths: ['m1'] })
      expect(readFileSync(join(ws, 'm1/App.tsx'), 'utf-8')).toBe('m1 v2\n')
      expect(readFileSync(join(ws, 'm2/App.tsx'), 'utf-8')).toBe('m2 v3\n')
      expect(git(ws, 'rev-parse', 'HEAD^')).toBe(repo.sha)
      expect(git(ws, 'diff', '--name-only', 'HEAD^', 'HEAD')).toBe('m1/App.tsx')
      expect(git(ws, 'status', '--porcelain')).toBe('')
    } finally {
      for (const d of [ws, repo.dir]) rmSync(d, { recursive: true, force: true })
      rmSync(repo.archive, { force: true })
    }
  })

  test('keepPaths only accepts the whole tree or top-level names', () => {
    expect(normalizeKeepPaths(undefined)).toEqual([])
    expect(normalizeKeepPaths(['.', 'm1/', 'm1', '.github'])).toEqual(['.', 'm1', '.github'])
    for (const bad of [['a/b'], ['..'], ['.git'], [''], ['a\\b'], [1], 'm1']) {
      expect(() => normalizeKeepPaths(bad)).toThrow()
    }
  })
})

describe('adoptHydratedRepoBefore (the guest side of the host deadline)', () => {
  async function setup(): Promise<{ ws: string; archive: string; seedSha: string; cleanup: () => void }> {
    const src = tmp('dur-dl-src-')
    write(src, 'a.txt', 'repo\n')
    await seedRepoIfAbsent(src, { logger: NOOP })
    const archive = join(src, '..', `${Date.now()}-${Math.random().toString(36).slice(2)}-dl.tar.gz`)
    await packRepoArchive(src, archive)
    const ws = tmp('dur-dl-ws-')
    write(ws, 'a.txt', 'hydrated\n')
    await seedRepoIfAbsent(ws, { logger: NOOP })
    const seedSha = git(ws, 'rev-parse', 'HEAD')
    return {
      ws,
      archive,
      seedSha,
      cleanup: () => {
        for (const d of [ws, src]) rmSync(d, { recursive: true, force: true })
        rmSync(archive, { force: true })
      },
    }
  }

  test('a git layer that is still busy at the deadline gets a decline, and nothing changes after it settles', async () => {
    const { ws, archive, seedSha, cleanup } = await setup()
    try {
      let settle!: () => void
      const ready = new Promise<void>((r) => { settle = r })
      const staging = stageDurableRepo(archive, ws)
      await expect(
        adoptHydratedRepoBefore(ws, staging, { deadline: Date.now() + 50, ready, logger: NOOP }),
      ).rejects.toBeInstanceOf(AdoptDeadlineError)
      settle()
      await new Promise((r) => setTimeout(r, 50))
      expect(git(ws, 'rev-parse', 'HEAD')).toBe(seedSha)
      expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('hydrated\n')
      expect(existsSync(staging)).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('a deadline that passes while pausing the sync still declines, and the sync is resumed', async () => {
    const { ws, archive, seedSha, cleanup } = await setup()
    try {
      const calls: string[] = []
      await expect(
        adoptHydratedRepoBefore(ws, stageDurableRepo(archive, ws), {
          deadline: Date.now() + 30,
          ready: Promise.resolve(),
          pause: async () => {
            calls.push('pause')
            await new Promise((r) => setTimeout(r, 60))
          },
          resume: () => calls.push('resume'),
          logger: NOOP,
        }),
      ).rejects.toBeInstanceOf(AdoptDeadlineError)
      expect(calls).toEqual(['pause', 'resume'])
      expect(git(ws, 'rev-parse', 'HEAD')).toBe(seedSha)
    } finally {
      cleanup()
    }
  })

  test('within the deadline it adopts as before', async () => {
    const { ws, archive, cleanup } = await setup()
    try {
      const res = await adoptHydratedRepoBefore(ws, stageDurableRepo(archive, ws), {
        deadline: Date.now() + 5_000,
        ready: Promise.reject(new Error('git layer failed')),
        logger: NOOP,
      })
      expect(res.reset).toBe(true)
      expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('repo\n')
    } finally {
      cleanup()
    }
  })
})

describe('seedRepoIfAbsent failure handling', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

  test.skipIf(isRoot)('throws and removes the half-built .git instead of leaving an empty repo behind', async () => {
    const ws = tmp('dur-seedfail-')
    try {
      write(ws, 'ok.txt', 'fine')
      write(ws, 'locked.txt', 'secret')
      chmodSync(join(ws, 'locked.txt'), 0o000)
      await expect(seedRepoIfAbsent(ws, { logger: NOOP })).rejects.toThrow(/git add exited/)
      expect(existsSync(join(ws, '.git'))).toBe(false)
    } finally {
      try { chmodSync(join(ws, 'locked.txt'), 0o644) } catch {}
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('applyGitSafeDirectoryEnv', () => {
  test('no-op for non-root processes', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyGitSafeDirectoryEnv(env, 1001)).toBe(false)
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  })

  test('appends safe.directory=* for root, after any existing entries, once', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' }
    expect(applyGitSafeDirectoryEnv(env, 0)).toBe(true)
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_1).toBe('safe.directory')
    expect(env.GIT_CONFIG_VALUE_1).toBe('*')
    expect(applyGitSafeDirectoryEnv(env, 0)).toBe(false)
    expect(env.GIT_CONFIG_COUNT).toBe('2')
  })

  test('git reads it as protected (command-line scope) config', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.GIT_CONFIG_COUNT
    applyGitSafeDirectoryEnv(env, 0)
    const out = execFileSync('git', ['config', '--show-scope', '--get-all', 'safe.directory'], { env, encoding: 'utf-8' })
    expect(out).toContain('command')
    expect(out).toContain('*')
  })
})
