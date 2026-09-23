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
import { adoptHydratedRepo, getHeadSha, packRepoArchive, seedRepoIfAbsent } from '../repo-store'
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
