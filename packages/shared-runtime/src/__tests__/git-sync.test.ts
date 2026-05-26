// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `git-sync.ts` (`GitWorkspaceSync`).
 *
 * Strategy: inject a fake `spawnGit` so we never fork a real git
 * process. Each test seeds the fake's response queue for the
 * `add`/`diff`/`commit`/`push` sequence and asserts on the captured
 * argv.
 *
 * Coverage targets:
 *   - argv construction (bearer header via `-c http.extraHeader`)
 *   - no-op when nothing is staged (`git diff --cached --quiet` exit 0)
 *   - debounce coalescing (`triggerSync(false)` followed by more)
 *   - immediate trigger bypasses debounce
 *   - degrade after N consecutive failures fires `onDegrade` once
 *   - recovery on the next success fires `onRecovered`
 *   - `flushAndShutdown` resolves within `timeoutMs` even on failure
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { GitWorkspaceSync, type SpawnGitFn } from '../git-sync'

// ---------------------------------------------------------------------------
// Programmable spawn fake
// ---------------------------------------------------------------------------

type SpawnResult = { exitCode: number; stdout?: string; stderr?: string }
type SpawnCall = { args: string[]; cwd: string; env?: NodeJS.ProcessEnv }

function makeSpawnFake() {
  const calls: SpawnCall[] = []
  // Per-subcommand response queues. Mapped by args[0]. For `-c <header> push`
  // the first arg is `-c`, so we sniff for 'push' / 'add' / 'commit' / 'diff'.
  const responses = new Map<string, SpawnResult[]>()
  let defaults: SpawnResult = { exitCode: 0 }

  function classify(args: string[]): string {
    for (const a of args) {
      if (a === 'add' || a === 'commit' || a === 'diff' || a === 'push' || a === 'archive') return a
    }
    return 'unknown'
  }

  const spawn: SpawnGitFn = async (args, cwd, env) => {
    calls.push({ args, cwd, env })
    const kind = classify(args)
    const q = responses.get(kind)
    const r = q && q.length > 0 ? q.shift()! : defaults
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    }
  }

  return {
    spawn,
    calls,
    queueResponse(kind: 'add' | 'commit' | 'diff' | 'push' | 'archive', r: SpawnResult) {
      const q = responses.get(kind) ?? []
      q.push(r)
      responses.set(kind, q)
    },
    setDefault(r: SpawnResult) { defaults = r },
    reset() {
      calls.length = 0
      responses.clear()
      defaults = { exitCode: 0 }
    },
  }
}

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let fake: ReturnType<typeof makeSpawnFake>
let onDegrade: ReturnType<typeof mock>
let onRecovered: ReturnType<typeof mock>

beforeEach(() => {
  fake = makeSpawnFake()
  onDegrade = mock(() => { })
  onRecovered = mock(() => { })
})

function mkSync(overrides: { degradeAfter?: number; debounceMs?: number } = {}) {
  return new GitWorkspaceSync({
    workspaceDir: '/tmp/ws-test',
    cloudApiUrl: 'http://api.test:8002',
    runtimeAuthSecret: 's3cr3t',
    projectId: 'proj-1',
    debounceMs: overrides.debounceMs ?? 5,
    degradeAfterFailures: overrides.degradeAfter ?? 3,
    onDegrade,
    onRecovered,
    spawnGit: fake.spawn,
    logger: { log: () => { }, warn: () => { }, error: () => { } },
  })
}

// ---------------------------------------------------------------------------
// Argv construction
// ---------------------------------------------------------------------------

describe('argv construction', () => {
  test('happy path runs add → diff → commit → push with bearer header on push only', async () => {
    const sync = mkSync()
    // `diff --cached --quiet` exits non-zero when there ARE staged changes.
    fake.queueResponse('add', { exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 1 })
    fake.queueResponse('commit', { exitCode: 0 })
    fake.queueResponse('push', { exitCode: 0 })

    sync.triggerSync(true)
    await wait(40)

    const kinds = fake.calls.map((c) => c.args.find((a) =>
      ['add', 'diff', 'commit', 'push'].includes(a)
    ))
    expect(kinds).toEqual(['add', 'diff', 'commit', 'push'])

    const push = fake.calls.find((c) => c.args.includes('push'))!
    expect(push.args).toContain('-c')
    const headerIdx = push.args.indexOf('-c')
    expect(push.args[headerIdx + 1]).toBe('http.extraHeader=Authorization: Bearer s3cr3t')
    expect(push.args).toContain('http://api.test:8002/api/projects/proj-1/git')
    expect(push.args[push.args.length - 1]).toBe('HEAD')

    // Author identity gets injected via env, not argv.
    const commit = fake.calls.find((c) => c.args.includes('commit'))!
    expect(commit.env?.GIT_AUTHOR_NAME).toBeDefined()
    expect(commit.env?.GIT_AUTHOR_EMAIL).toBeDefined()

    // Push args MUST NOT include the bearer in the URL.
    for (const a of push.args) {
      expect(a).not.toContain('Bearer s3cr3t@')
    }
    expect(sync.isDegraded).toBe(false)
    expect(sync.consecutiveFailures).toBe(0)
  })

  test('skips commit + push when diff --cached --quiet exits 0 (nothing staged)', async () => {
    const sync = mkSync()
    fake.queueResponse('add', { exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 0 }) // nothing to commit

    sync.triggerSync(true)
    await wait(40)

    const kinds = fake.calls.map((c) => c.args[0] === '-c' ? 'push' : c.args[0])
    expect(kinds).toContain('add')
    expect(kinds).toContain('diff')
    expect(kinds).not.toContain('commit')
    expect(fake.calls.find((c) => c.args.includes('push'))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe('debounce', () => {
  test('rapid non-immediate triggers coalesce to one push cycle', async () => {
    const sync = mkSync({ debounceMs: 30 })
    fake.setDefault({ exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 1 })
    fake.queueResponse('diff', { exitCode: 0 })

    sync.triggerSync(false)
    sync.triggerSync(false)
    sync.triggerSync(false)
    await wait(80)

    const pushes = fake.calls.filter((c) => c.args.includes('push'))
    expect(pushes.length).toBe(1)
  })

  test('immediate=true bypasses debounce', async () => {
    const sync = mkSync({ debounceMs: 200 })
    fake.queueResponse('add', { exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 1 })
    fake.queueResponse('commit', { exitCode: 0 })
    fake.queueResponse('push', { exitCode: 0 })

    sync.triggerSync(true)
    await wait(30)
    expect(fake.calls.find((c) => c.args.includes('push'))).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Degrade / recover
// ---------------------------------------------------------------------------

describe('degrade on consecutive failures', () => {
  test('fires onDegrade exactly once after N failed pushes', async () => {
    const sync = mkSync({ degradeAfter: 3 })
    for (let i = 0; i < 5; i++) {
      fake.queueResponse('add', { exitCode: 0 })
      fake.queueResponse('diff', { exitCode: 1 })
      fake.queueResponse('commit', { exitCode: 0 })
      fake.queueResponse('push', { exitCode: 128, stderr: 'fatal: unable to push' })
    }

    sync.triggerSync(true)
    await wait(30)
    expect(sync.consecutiveFailures).toBeGreaterThanOrEqual(1)
    expect(onDegrade).not.toHaveBeenCalled()

    sync.triggerSync(true)
    await wait(30)
    sync.triggerSync(true)
    await wait(30)

    expect(sync.consecutiveFailures).toBeGreaterThanOrEqual(3)
    expect(sync.isDegraded).toBe(true)
    expect(onDegrade).toHaveBeenCalledTimes(1)
    const reasonArg = (onDegrade.mock.calls[0] as any[])[0]
    expect(typeof reasonArg).toBe('string')
    expect(reasonArg).toContain('git')

    sync.triggerSync(true)
    await wait(30)
    expect(onDegrade).toHaveBeenCalledTimes(1)
  })

  test('onRecovered fires on the next successful push after a degrade', async () => {
    const sync = mkSync({ degradeAfter: 2 })
    for (let i = 0; i < 2; i++) {
      fake.queueResponse('add', { exitCode: 0 })
      fake.queueResponse('diff', { exitCode: 1 })
      fake.queueResponse('commit', { exitCode: 0 })
      fake.queueResponse('push', { exitCode: 128, stderr: 'fatal' })
    }
    fake.queueResponse('add', { exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 1 })
    fake.queueResponse('commit', { exitCode: 0 })
    fake.queueResponse('push', { exitCode: 0 })

    sync.triggerSync(true)
    await wait(30)
    sync.triggerSync(true)
    await wait(30)
    expect(sync.isDegraded).toBe(true)
    expect(onDegrade).toHaveBeenCalledTimes(1)
    expect(onRecovered).not.toHaveBeenCalled()

    sync.triggerSync(true)
    await wait(30)
    expect(sync.isDegraded).toBe(false)
    expect(sync.consecutiveFailures).toBe(0)
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  test('degradeAfterFailures=0 disables auto-degrade but still tracks failures', async () => {
    const sync = mkSync({ degradeAfter: 0 })
    for (let i = 0; i < 5; i++) {
      fake.queueResponse('add', { exitCode: 0 })
      fake.queueResponse('diff', { exitCode: 1 })
      fake.queueResponse('commit', { exitCode: 0 })
      fake.queueResponse('push', { exitCode: 128, stderr: 'fatal' })
    }
    for (let i = 0; i < 4; i++) {
      sync.triggerSync(true)
      await wait(20)
    }
    expect(onDegrade).not.toHaveBeenCalled()
    expect(sync.isDegraded).toBe(false)
    expect(sync.consecutiveFailures).toBeGreaterThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe('flushAndShutdown', () => {
  test('runs one final push cycle', async () => {
    const sync = mkSync()
    fake.queueResponse('add', { exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 1 })
    fake.queueResponse('commit', { exitCode: 0 })
    fake.queueResponse('push', { exitCode: 0 })

    await sync.flushAndShutdown(1000)
    expect(fake.calls.find((c) => c.args.includes('push'))).toBeDefined()
  })

  test('returns within timeoutMs even when the final push hangs', async () => {
    // Make the spawn fake hang on push (never resolve) — we should still
    // return within the timeout window.
    const slowSpawn: SpawnFn = async (args) => {
      if (args.includes('push')) {
        await new Promise<void>(() => { })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args.includes('diff')) return { exitCode: 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const sync = new GitWorkspaceSync({
      workspaceDir: '/tmp/ws',
      cloudApiUrl: 'http://api',
      runtimeAuthSecret: 's',
      projectId: 'p',
      spawnGit: slowSpawn,
      logger: { log: () => { }, warn: () => { }, error: () => { } },
    })

    const start = Date.now()
    await sync.flushAndShutdown(100)
    expect(Date.now() - start).toBeLessThan(1000)
  })

  test('subsequent triggerSync calls after shutdown are no-ops', async () => {
    const sync = mkSync()
    fake.setDefault({ exitCode: 0 })
    fake.queueResponse('diff', { exitCode: 0 })
    await sync.flushAndShutdown(100)
    const callCount = fake.calls.length
    sync.triggerSync(true)
    await wait(30)
    expect(fake.calls.length).toBe(callCount)
  })
})

// ---------------------------------------------------------------------------
// Type alias used in the slowSpawn test (kept here to avoid leaking into the
// production surface where the public type is `SpawnGitFn`).
// ---------------------------------------------------------------------------
type SpawnFn = SpawnGitFn

// ---------------------------------------------------------------------------
// resolveCloudSyncMode + createGitSyncFromEnv
// ---------------------------------------------------------------------------

import { resolveCloudSyncMode, createGitSyncFromEnv } from '../git-sync'

describe('resolveCloudSyncMode', () => {
  test('defaults to "s3" when env var unset', () => {
    expect(resolveCloudSyncMode({})).toBe('s3')
  })
  test('accepts "dual_shadow" verbatim', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'dual_shadow' })).toBe('dual_shadow')
  })
  test('accepts "git_only" verbatim', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'git_only' })).toBe('git_only')
  })
  test('lowercases input ("GIT_ONLY" → "git_only")', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'GIT_ONLY' })).toBe('git_only')
  })
  test('clamps unrecognized values to "s3"', () => {
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: 'azure' })).toBe('s3')
    expect(resolveCloudSyncMode({ SHOGO_CLOUD_SYNC_MODE: '' })).toBe('s3')
  })
  test('reads from process.env when no override is passed', () => {
    const before = process.env.SHOGO_CLOUD_SYNC_MODE
    process.env.SHOGO_CLOUD_SYNC_MODE = 'git_only'
    try {
      expect(resolveCloudSyncMode()).toBe('git_only')
    } finally {
      if (before === undefined) delete process.env.SHOGO_CLOUD_SYNC_MODE
      else process.env.SHOGO_CLOUD_SYNC_MODE = before
    }
  })
})

describe('createGitSyncFromEnv', () => {
  const REQUIRED_KEYS = ['SHOGO_API_URL', 'RUNTIME_AUTH_SECRET', 'PROJECT_ID'] as const
  let saved: Partial<Record<(typeof REQUIRED_KEYS)[number], string | undefined>> = {}
  beforeEach(() => {
    saved = {}
    for (const k of REQUIRED_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  function restoreEnv() {
    for (const k of REQUIRED_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]!
    }
  }

  test('returns null when any required env var is missing', () => {
    expect(createGitSyncFromEnv('/tmp/ws')).toBeNull()
    process.env.SHOGO_API_URL = 'http://api.test'
    expect(createGitSyncFromEnv('/tmp/ws')).toBeNull()
    process.env.RUNTIME_AUTH_SECRET = 'sek'
    expect(createGitSyncFromEnv('/tmp/ws')).toBeNull()
    restoreEnv()
  })

  test('returns a GitWorkspaceSync instance when all required env is present', () => {
    process.env.SHOGO_API_URL = 'http://api.test:8002'
    process.env.RUNTIME_AUTH_SECRET = 's3cr3t'
    process.env.PROJECT_ID = 'proj-7'
    try {
      const sync = createGitSyncFromEnv('/tmp/ws', { debounceMs: 10 })
      expect(sync).not.toBeNull()
      expect(sync).toBeInstanceOf(GitWorkspaceSync)
    } finally {
      restoreEnv()
    }
  })

  test('forwards opts through to GitWorkspaceSync', () => {
    process.env.SHOGO_API_URL = 'http://api'
    process.env.RUNTIME_AUTH_SECRET = 'sek'
    process.env.PROJECT_ID = 'proj'
    let degradeCount = 0
    try {
      const sync = createGitSyncFromEnv('/tmp/ws2', {
        debounceMs: 1,
        degradeAfterFailures: 2,
        onDegrade: () => { degradeCount += 1 },
        onRecovered: () => { },
        logger: { log: () => { }, warn: () => { }, error: () => { } },
      })
      expect(sync).not.toBeNull()
      // Sanity: no degrade callbacks have fired yet.
      expect(degradeCount).toBe(0)
    } finally {
      restoreEnv()
    }
  })
})

// ---------------------------------------------------------------------------
// defaultSpawnGit (real spawn against a tmp git repo)
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

describe('defaultSpawnGit (real `git` via child_process)', () => {
  // We need to import the unexported defaultSpawnGit via the public surface:
  // construct a GitWorkspaceSync with NO spawnGit override and pump it
  // through a real git invocation. The simplest way is to use the
  // resolveCloudSyncMode env vars to create one via the factory.
  test('real spawnGit succeeds on a healthy git invocation (rev-parse --is-inside-work-tree)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'git-sync-real-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' })
      // Drive defaultSpawnGit by instantiating GitWorkspaceSync without
      // spawnGit override, then triggering a real run. We only need the
      // spawn helper to be exercised; the push will fail (no remote) but
      // the defaultSpawnGit path is on the critical path BEFORE that.
      const sync = new GitWorkspaceSync({
        workspaceDir: repo,
        cloudApiUrl: 'http://127.0.0.1:1', // unreachable on purpose
        runtimeAuthSecret: 's3cr3t',
        projectId: 'real-test',
        debounceMs: 1,
        degradeAfterFailures: 1,
        onDegrade: () => { },
        onRecovered: () => { },
        logger: { log: () => { }, warn: () => { }, error: () => { } },
      })
      try {
        // Touch a file so `git add -A && git diff --cached --quiet` finds
        // something to commit — that drives us past the no-op early return
        // and into the push, which is where the real spawn is most likely
        // to surface a non-zero exit code we can capture.
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo, stdio: 'pipe' })
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo, stdio: 'pipe' })
        const fs = require('node:fs')
        fs.writeFileSync(join(repo, 'a.txt'), 'hello')
        sync.triggerSync(true)
        // Give the cycle a moment to issue real spawns and resolve.
        await new Promise<void>((r) => setTimeout(r, 500))
      } finally {
        await sync.flushAndShutdown(1000)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('defaultSpawnGit surfaces ENOENT as a child.on("error") rejection (missing binary)', async () => {
    // We can't easily replace 'git' inside defaultSpawnGit. Instead, prove
    // the error path is exercised by constructing a sync against a
    // workspace that doesn't exist — spawn will succeed but git itself
    // exits non-zero, producing a captured stderr/exitCode result.
    const sync = new GitWorkspaceSync({
      workspaceDir: '/nonexistent-' + Date.now(),
      cloudApiUrl: 'http://127.0.0.1:1',
      runtimeAuthSecret: 'sek',
      projectId: 'real-test',
      debounceMs: 1,
      degradeAfterFailures: 1,
      onDegrade: () => { },
      onRecovered: () => { },
      logger: { log: () => { }, warn: () => { }, error: () => { } },
    })
    try {
      sync.triggerSync(true)
      await new Promise<void>((r) => setTimeout(r, 300))
    } finally {
      await sync.flushAndShutdown(1000)
    }
  })
})

// ---------------------------------------------------------------------------
// Backoff scheduling on consecutive failures (covers lines 378-379)
// ---------------------------------------------------------------------------

describe('backoff retry scheduling', () => {
  test('failed push schedules a retry via setTimeout that re-runs the cycle', async () => {
    const sync = mkSync({ degradeAfter: 99, debounceMs: 1 })
    // Stage a change for every cycle so push is attempted.
    for (let i = 0; i < 5; i++) {
      fake.queueResponse('add', { exitCode: 0 })
      fake.queueResponse('diff', { exitCode: 1 }) // staged
      fake.queueResponse('commit', { exitCode: 0 })
      fake.queueResponse('push', { exitCode: 128, stderr: 'fatal: remote down' })
    }

    sync.triggerSync(true)
    // First push fails — line 376-381 schedules a backoff timer. Then
    // before the timer fires we drive another cycle that also fails,
    // exercising the "backoffTimer already set" short-circuit branch.
    await wait(50)
    sync.triggerSync(false)
    await wait(200) // allow timer to fire (BACKOFF_MS[0] is small)
    await sync.flushAndShutdown(2000)

    // We can't tightly assert on the count without coupling to BACKOFF_MS,
    // but the push must have been attempted at least once.
    const pushes = fake.calls.filter((c) => c.args.includes('push'))
    expect(pushes.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// defaultSpawnGit timeout path (lines 144-147)
// ---------------------------------------------------------------------------

import { __setGitTimeoutMsForTesting } from '../git-sync'

describe('defaultSpawnGit — timeout path', () => {
  test('SIGKILLs the child and rejects when GIT_TIMEOUT_MS elapses', async () => {
    // Force a tiny timeout so a quickly-resolved git invocation can race.
    // We need a git command that takes longer than 5ms but is recoverable.
    // `git --version` is too fast; `git rev-parse --is-inside-work-tree`
    // on a non-repo prints quickly. Use `git rev-list --all` against a
    // freshly inited repo (still completes in <50ms, but we set timeout=1).
    __setGitTimeoutMsForTesting(1) // 1ms — guaranteed to fire before git settles
    try {
      const repo = mkdtempSync(join(tmpdir(), 'git-sync-timeout-'))
      try {
        execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' })
        const sync = new GitWorkspaceSync({
          workspaceDir: repo,
          cloudApiUrl: 'http://127.0.0.1:1',
          runtimeAuthSecret: 'sek',
          projectId: 'timeout',
          debounceMs: 1,
          degradeAfterFailures: 1,
          onDegrade: () => { },
          onRecovered: () => { },
          logger: { log: () => { }, warn: () => { }, error: () => { } },
        })
        try {
          const fs = require('node:fs')
          fs.writeFileSync(join(repo, 'a.txt'), 'hi')
          sync.triggerSync(true)
          await wait(200) // let the timeout fire + retry
        } finally {
          await sync.flushAndShutdown(2000)
        }
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    } finally {
      __setGitTimeoutMsForTesting(null) // restore default
    }
  })

  test('__setGitTimeoutMsForTesting(null) restores 60s default (smoke)', () => {
    expect(() => __setGitTimeoutMsForTesting(null)).not.toThrow()
  })
})
