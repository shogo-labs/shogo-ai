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
