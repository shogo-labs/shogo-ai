// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-180 / #1686 — one file named `nul` stopped workspace git sync forever.
 *
 * Two things went wrong together: `git add -A` could never succeed while a
 * reserved Windows device name sat untracked in the tree, and the catch block
 * retried it forever for the user to see none of it (3,493 attempts, no commit
 * for three days). These tests cover the three halves of the fix:
 *
 *   1. reserved names are never staged (and one bad path never costs the rest)
 *   2. the retry loop caps and parks, with the count surviving a restart
 *   3. the user is told once, and local-only mode says the right thing
 */

import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  GitWorkspaceSync,
  __resetReservedPathWarningsForTesting,
  unindexablePath,
  type SpawnGitFn,
  type SyncParkInfo,
} from '../git-sync'

// ---------------------------------------------------------------------------
// Programmable spawn fake
// ---------------------------------------------------------------------------

type SpawnResult = { exitCode: number; stdout?: string; stderr?: string }

const KNOWN = ['add', 'diff', 'commit', 'push', 'rev-parse', 'ls-files', 'check-ignore']

function makeSpawnFake() {
  const calls: { args: string[]; cwd: string }[] = []
  const queues = new Map<string, SpawnResult[]>()
  const defaults = new Map<string, SpawnResult>()

  function classify(args: string[]): string {
    const hit = args.find((a) => KNOWN.includes(a))
    return hit ?? 'unknown'
  }

  const spawn: SpawnGitFn = async (args, cwd) => {
    calls.push({ args, cwd })
    const kind = classify(args)
    const queued = queues.get(kind)
    const r = queued && queued.length > 0 ? queued.shift()! : (defaults.get(kind) ?? { exitCode: 0 })
    return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  return {
    spawn,
    calls,
    /** Response for every call of this kind (overridden by `queue`). */
    set(kind: string, r: SpawnResult) { defaults.set(kind, r) },
    /** One-shot response, consumed in order. */
    queue(kind: string, r: SpawnResult) {
      const q = queues.get(kind) ?? []
      q.push(r)
      queues.set(kind, q)
    },
    callsOf(kind: string) { return calls.filter((c) => classify(c.args) === kind) },
  }
}

function captureLogger() {
  const lines: { level: 'log' | 'warn' | 'error'; text: string }[] = []
  const push = (level: 'log' | 'warn' | 'error') => (...args: unknown[]) => {
    lines.push({ level, text: args.map((a) => String(a)).join(' ') })
  }
  return {
    lines,
    logger: { log: push('log'), warn: push('warn'), error: push('error') },
    of(level: 'log' | 'warn' | 'error') { return lines.filter((l) => l.level === level).map((l) => l.text) },
    all() { return lines.map((l) => l.text) },
  }
}

const silentLogger = { log: () => { }, warn: () => { }, error: () => { } }

function mkSync(
  fake: ReturnType<typeof makeSpawnFake>,
  opts: {
    logger?: Console | typeof silentLogger
    onPark?: (info: SyncParkInfo) => void
    onDegrade?: () => void
    workspaceDir?: string
  } = {},
) {
  return new GitWorkspaceSync({
    workspaceDir: opts.workspaceDir ?? '/tmp/ws-test',
    cloudApiUrl: 'http://api.test:8002',
    runtimeAuthSecret: 's3cr3t',
    projectId: 'proj-1',
    debounceMs: 1,
    degradeAfterFailures: 3,
    onPark: opts.onPark,
    onDegrade: opts.onDegrade ?? (() => { }),
    spawnGit: fake.spawn,
    logger: (opts.logger as Console) ?? silentLogger,
  })
}

/** Every git call fails the same way: the state that parked the real sync. */
const INDEX_FAILURE: SpawnResult = {
  exitCode: 128,
  stderr: "error: unable to index file 'nul'\nfatal: adding files failed\n",
}

function failingEverything(fake: ReturnType<typeof makeSpawnFake>) {
  for (const kind of ['ls-files', 'add', 'diff', 'commit', 'rev-parse', 'push']) {
    fake.set(kind, INDEX_FAILURE)
  }
}

let fake: ReturnType<typeof makeSpawnFake>

beforeEach(() => {
  fake = makeSpawnFake()
  __resetReservedPathWarningsForTesting()
})

afterEach(() => {
  setSystemTime()
})

// ---------------------------------------------------------------------------
// AC1 — reserved names never reach the index
// ---------------------------------------------------------------------------

describe('reserved Windows device names', () => {
  test('excludes every reserved untracked path from git add, literally', async () => {
    fake.set('ls-files', { exitCode: 0, stdout: 'nul\0aux.txt\0sub/CON\0keep.txt\0b.ts\0' })
    fake.set('diff', { exitCode: 1 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-1\n' })
    const sync = mkSync(fake)

    await sync.flush()

    const add = fake.callsOf('add')
    expect(add).toHaveLength(1)
    expect(add[0].args).toEqual([
      'add', '-A', '--', '.',
      ':(exclude,literal)nul',
      ':(exclude,literal)aux.txt',
      ':(exclude,literal)sub/CON',
    ])
    // The rest of the tree still commits and is made durable.
    expect(fake.callsOf('commit')).toHaveLength(1)
    expect(fake.callsOf('push')).toHaveLength(1)
  })

  test('leaves the plain add argv untouched when nothing is reserved', async () => {
    fake.set('ls-files', { exitCode: 0, stdout: 'keep.txt\0' })
    fake.set('diff', { exitCode: 1 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-1\n' })
    const sync = mkSync(fake)

    await sync.flush()

    expect(fake.callsOf('add')[0].args).toEqual(['add', '-A'])
  })

  test('warns about each reserved path once per process, naming it', async () => {
    fake.set('ls-files', { exitCode: 0, stdout: 'nul\0aux.txt\0keep.txt\0' })
    fake.set('diff', { exitCode: 1 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-1\n' })
    const logs = captureLogger()
    const sync = mkSync(fake, { logger: logs.logger as unknown as Console })

    await sync.flush()
    await sync.flush()

    const warnings = logs.of('warn').filter((l) => l.includes('not staging'))
    expect(warnings).toHaveLength(2) // one per path, once — despite two cycles
    expect(warnings[0]).toContain('"nul"')
    expect(warnings[0]).toContain('rm -f')
    expect(warnings[1]).toContain('"aux.txt"')
  })

  test('a reserved path git did not predict costs one path, not the whole backup', async () => {
    // `git add` refuses a path that is already tracked and unindexable.
    fake.set('ls-files', { exitCode: 0, stdout: 'keep.txt\0' })
    fake.queue('add', { exitCode: 128, stderr: "error: unable to index file 'weird'\nfatal: adding files failed\n" })
    fake.set('add', { exitCode: 0 })
    fake.set('diff', { exitCode: 1 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-1\n' })
    const logs = captureLogger()
    const sync = mkSync(fake, { logger: logs.logger as unknown as Console })

    await sync.flush()

    const adds = fake.callsOf('add')
    expect(adds).toHaveLength(2)
    expect(adds[1].args).toEqual(['add', '-A', '--', '.', ':(exclude,literal)weird'])
    expect(logs.of('warn').some((l) => l.includes('"weird"'))).toBe(true)
    // The cycle carries on: the rest of the workspace is committed and pushed.
    expect(fake.callsOf('commit')).toHaveLength(1)
    expect(fake.callsOf('push')).toHaveLength(1)
  })

  test('does not swallow an add failure that names no path', async () => {
    fake.set('add', { exitCode: 128, stderr: 'fatal: detected dubious ownership in repository\n' })
    fake.set('diff', { exitCode: 1 })
    const logs = captureLogger()
    const sync = mkSync(fake, { logger: logs.logger as unknown as Console })

    await sync.flush()

    expect(fake.callsOf('add')).toHaveLength(1) // no pointless retry
    expect(sync.consecutiveFailures).toBe(1)
    expect(logs.of('warn').some((l) => l.includes('dubious ownership'))).toBe(true)
  })

  test('unindexablePath reads only the path git named', () => {
    expect(unindexablePath("error: unable to index file 'nul'\nfatal: adding files failed")).toBe('nul')
    expect(unindexablePath("error: unable to index file 'sub/CON.log'")).toBe('sub/CON.log')
    expect(unindexablePath('fatal: not a git repository')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC3 — the loop caps and parks
// ---------------------------------------------------------------------------

const PARK_AFTER = 20

describe('parking the retry loop', () => {
  async function parkIt(logger?: Console) {
    failingEverything(fake)
    const onPark = mock((_info: SyncParkInfo) => { })
    const sync = mkSync(fake, { onPark, logger })
    for (let i = 0; i < PARK_AFTER - 1; i++) await sync.flush()
    return { sync, onPark }
  }

  test('parks on the 20th identical failure, not before, and notifies once', async () => {
    const { sync, onPark } = await parkIt()

    expect(sync.isParked).toBe(false)
    expect(onPark).toHaveBeenCalledTimes(0)

    await sync.flush()

    expect(sync.isParked).toBe(true)
    expect(onPark).toHaveBeenCalledTimes(1)
    const info = onPark.mock.calls[0][0]
    expect(info.consecutiveFailures).toBe(PARK_AFTER)
    expect(info.reason).toContain("unable to index file 'nul'")
    expect(info.lifetimeFailures).toBe(PARK_AFTER)

    // Further identical failures stay parked: no second notification.
    await sync.flush()
    expect(onPark).toHaveBeenCalledTimes(1)
    expect(sync.isParked).toBe(true)
  })

  test('a parked sync runs at most one attempt every 10 minutes', async () => {
    const { sync } = await parkIt()
    await sync.flush() // the 20th failure parks it
    const attemptsWhileParked = fake.callsOf('add').length

    // Every finished turn calls triggerSync — none of them may retry.
    for (let i = 0; i < 10; i++) sync.triggerSync(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.callsOf('add').length).toBe(attemptsWhileParked)

    // Ten minutes on, exactly one attempt is allowed.
    setSystemTime(new Date(Date.now() + 10 * 60_000))
    sync.triggerSync(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.callsOf('add').length).toBeGreaterThan(attemptsWhileParked)
    expect(sync.isParked).toBe(true)
  })

  test('a success clears the parked state and the lifetime count', async () => {
    const { sync } = await parkIt()
    await sync.flush()
    expect(sync.isParked).toBe(true)

    fake.set('add', { exitCode: 0 })
    fake.set('diff', { exitCode: 1 })
    fake.set('commit', { exitCode: 0 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-ok\n' })
    fake.set('push', { exitCode: 0 })
    await sync.flush()

    expect(sync.isParked).toBe(false)
    expect(sync.consecutiveFailures).toBe(0)
    expect(sync.lifetimeFailures).toBe(0)
  })

  test('a different failure reason leaves the parked state', async () => {
    const { sync } = await parkIt()
    await sync.flush()
    expect(sync.isParked).toBe(true)

    fake.set('add', { exitCode: 128, stderr: 'fatal: unable to write new index file\n' })
    await sync.flush()

    expect(sync.isParked).toBe(false)
  })

  test('the log names the lifetime count and the failure streak', async () => {
    const logs = captureLogger()
    const { sync } = await parkIt(logs.logger as unknown as Console)
    await sync.flush()

    const parkLine = logs.of('warn').find((l) => l.includes('parked:'))
    expect(parkLine).toBeDefined()
    expect(parkLine).toContain(`${PARK_AFTER} failed pushes for the same reason`)
    expect(parkLine).toContain('one attempt every 10 min')
  })
})

// ---------------------------------------------------------------------------
// AC4 — the lifetime counter survives a restart
// ---------------------------------------------------------------------------

describe('persisted failure counter', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sho180-state-'))
    mkdirSync(join(dir, '.git'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('counts across instances through .git/shogo-sync-state.json', async () => {
    failingEverything(fake)
    const stateFile = join(dir, '.git', 'shogo-sync-state.json')

    const first = mkSync(fake, { workspaceDir: dir })
    await first.flush()
    await first.flush()
    expect(first.lifetimeFailures).toBe(2)
    expect(existsSync(stateFile)).toBe(true)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(saved.lifetimeFailures).toBe(2)
    expect(typeof saved.firstFailureAt).toBe('string')

    // A fresh process (pod restart) continues the same streak.
    const logs = captureLogger()
    const second = mkSync(makeSpawnFakeWithDefaults(), { workspaceDir: dir, logger: logs.logger as unknown as Console })
    await second.flush()

    expect(second.lifetimeFailures).toBe(3)
    const failureLine = logs.of('warn').find((l) => l.includes('failed'))
    expect(failureLine).toContain('3 since')
    expect(failureLine).toContain(saved.firstFailureAt)
  })

  test('a success persists the reset', async () => {
    failingEverything(fake)
    const sync = mkSync(fake, { workspaceDir: dir })
    await sync.flush()
    expect(sync.lifetimeFailures).toBe(1)

    fake.set('add', { exitCode: 0 })
    fake.set('diff', { exitCode: 1 })
    fake.set('commit', { exitCode: 0 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-ok\n' })
    fake.set('push', { exitCode: 0 })
    await sync.flush()

    const saved = JSON.parse(readFileSync(join(dir, '.git', 'shogo-sync-state.json'), 'utf8'))
    expect(saved.lifetimeFailures).toBe(0)
    expect(saved.firstFailureAt).toBeNull()
  })

  function makeSpawnFakeWithDefaults() {
    const next = makeSpawnFake()
    for (const kind of ['ls-files', 'add', 'diff', 'commit', 'rev-parse', 'push']) {
      next.set(kind, INDEX_FAILURE)
    }
    return next
  }
})

// ---------------------------------------------------------------------------
// AC5 — local-only mode never talks about pushing
// ---------------------------------------------------------------------------

describe('localOnly wording', () => {
  test('says "checkpoint commit failed" and never mentions push or S3 Layer 2', async () => {
    const logs = captureLogger()
    const onPark = mock((_info: SyncParkInfo) => { })
    const sync = new GitWorkspaceSync({
      workspaceDir: '/tmp/ws-local',
      cloudApiUrl: 'http://api.test:8002',
      runtimeAuthSecret: 's3cr3t',
      projectId: 'proj-local',
      debounceMs: 1,
      degradeAfterFailures: 3,
      localOnly: true,
      afterCommit: () => { throw new Error('object store unreachable') },
      onPark,
      spawnGit: fake.spawn,
      logger: logs.logger as unknown as Console,
    })
    fake.set('diff', { exitCode: 1 })
    fake.set('commit', { exitCode: 0 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-local\n' })

    for (let i = 0; i < PARK_AFTER; i++) await sync.flush()

    const text = logs.all().join('\n')
    expect(text).toContain('checkpoint commit failed')
    expect(text).not.toMatch(/S3 Layer 2/i)
    expect(text).not.toMatch(/\bpush(es|ed|ing)?\b/i)
    expect(sync.isParked).toBe(true)
    expect(onPark).toHaveBeenCalledTimes(1)
  })

  test('the recovery line drops the push wording too', async () => {
    const logs = captureLogger()
    let fail = true
    const sync = new GitWorkspaceSync({
      workspaceDir: '/tmp/ws-local',
      cloudApiUrl: 'http://api.test:8002',
      runtimeAuthSecret: 's3cr3t',
      projectId: 'proj-local',
      debounceMs: 1,
      degradeAfterFailures: 1,
      localOnly: true,
      afterCommit: () => { if (fail) throw new Error('object store unreachable') },
      spawnGit: fake.spawn,
      logger: logs.logger as unknown as Console,
    })
    fake.set('diff', { exitCode: 1 })
    fake.set('commit', { exitCode: 0 })
    fake.set('rev-parse', { exitCode: 0, stdout: 'sha-local\n' })

    await sync.flush()
    fail = false
    await sync.flush()

    const text = logs.all().join('\n')
    expect(text).toContain('checkpoint commits are landing again')
    expect(text).not.toMatch(/S3 Layer 2/i)
    expect(text).not.toMatch(/\bpush(es|ed|ing)?\b/i)
  })
})

// ---------------------------------------------------------------------------
// AC1 — real git: the pathspec really keeps the reserved names out
// ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

describe('real git', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sho180-real-'))
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'keep.txt'), 'hello\n')
    writeFileSync(join(dir, 'nul'), 'junk\n')
    writeFileSync(join(dir, 'aux.txt'), 'junk\n')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'CON'), 'junk\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('commits everything except the reserved names', async () => {
    const sync = new GitWorkspaceSync({
      workspaceDir: dir,
      cloudApiUrl: 'http://api.test:8002',
      runtimeAuthSecret: 's3cr3t',
      projectId: 'proj-real',
      localOnly: true,
      afterCommit: () => { },
      logger: silentLogger,
    })

    await sync.flush()

    const tracked = git(dir, 'ls-files').split('\n').filter(Boolean)
    expect(tracked).toContain('keep.txt')
    expect(tracked).not.toContain('nul')
    expect(tracked).not.toContain('aux.txt')
    expect(tracked).not.toContain('sub/CON')
    // The reserved files are still on disk, untouched.
    expect(existsSync(join(dir, 'nul'))).toBe(true)
  })
})
