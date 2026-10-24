// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance (SHO-180 / #1686): the two halves of "tell the user" that the
 * unit tests leave between them.
 *
 *   1. the request the runtime actually sends when the sync parks — the API
 *      route reads `workspaceId` / `title` / `body` and resolves the recipient
 *      itself, so a wrong key or a stray `userId` silently loses the notice;
 *   2. a real repository: the reserved names stay out of the commit while the
 *      rest of the work lands, and the same failure twenty times in a row parks
 *      the sync and reports once.
 *
 * The dev's tests drive the fake `spawnGit`; these drive real `git`, which is
 * where the `:(exclude,literal)` pathspec has to behave. They also run in the
 * Windows CI job: on Windows a reserved name cannot exist as a regular file, so
 * the reserved-path assertions are scoped to the names this host could actually
 * create (`present`) and the park/report half runs everywhere.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { GitWorkspaceSync, type SyncParkInfo } from '@shogo/shared-runtime'
import { postWorkspaceNotification } from '../internal-api'

const ENV_KEYS = ['SHOGO_API_URL', 'API_URL', 'AI_PROXY_URL', 'RUNTIME_AUTH_SECRET', 'PROJECT_ID']

describe('postWorkspaceNotification', () => {
  const saved: Record<string, string | undefined> = {}
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.SHOGO_API_URL = 'http://api.test.invalid'
    process.env.RUNTIME_AUTH_SECRET = 'runtime-secret'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  type Call = { url: string; init: RequestInit }

  function stubFetch(status: number): Call[] {
    const calls: Call[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init: init ?? {} })
      return new Response(JSON.stringify({ ok: status < 400 }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return calls
  }

  test('sends exactly the body the notify route reads, and names no user', async () => {
    const calls = stubFetch(200)

    const sent = await postWorkspaceNotification({
      workspaceId: 'ws-1',
      title: 'Workspace backup has failed',
      body: "Workspace backup has failed 20 times: error: unable to index file 'nul'",
    })

    expect(sent).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://api.test.invalid/api/internal/reminders/notify')
    expect(calls[0].init.method).toBe('POST')

    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(payload.workspaceId).toBe('ws-1')
    expect(payload.title).toBe('Workspace backup has failed')
    expect(String(payload.body)).toContain("unable to index file 'nul'")
    // The route resolves the workspace owner itself; a userId here would pin
    // the notice to whichever user the runtime happened to know about.
    expect('userId' in payload).toBe(false)

    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['x-runtime-token']).toBe('runtime-secret')
  })

  test('reports a rejected POST instead of throwing into the durability path', async () => {
    stubFetch(500)
    const sent = await postWorkspaceNotification({ workspaceId: 'ws-1', title: 't', body: 'b' })
    expect(sent).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A real repository, real git
// ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

/**
 * Write `rel` into `dir` and report whether it became a real file. On Windows a
 * reserved device name cannot: the write goes to the device and nothing lands.
 */
function tryWrite(dir: string, rel: string): boolean {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  try {
    writeFileSync(abs, 'junk\n')
  } catch {
    return false
  }
  try {
    return existsSync(abs) && statSync(abs).isFile()
  } catch {
    return false
  }
}

describe('a real repository that cannot be made durable', () => {
  let dir: string
  let logs: string[]
  let parks: SyncParkInfo[]
  let present: string[]

  function logger() {
    return {
      log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
      warn: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    } as unknown as Console
  }

  beforeEach(() => {
    logs = []
    parks = []
    dir = mkdtempSync(join(tmpdir(), 'qa-sho180-real-'))
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'keep.txt'), 'work the user cares about\n')
    present = ['nul', 'aux.txt', 'sub/CON'].filter((rel) => tryWrite(dir, rel))
  })

  afterEach(async () => {
    // A git child that has just exited keeps its handles on the repo for a
    // moment on Windows, so EBUSY on the first pass is not a test failure.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        if (!locked || attempt >= 20) throw err
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  })

  test('commits the real work, skips the reserved names, parks after 20 identical failures and reports once', async () => {
    const sync = new GitWorkspaceSync({
      workspaceDir: dir,
      cloudApiUrl: 'http://api.test.invalid',
      runtimeAuthSecret: 'runtime-secret',
      projectId: 'proj-qa',
      localOnly: true,
      afterCommit: () => {
        // Pod-owned durability (persist `.git` + checkpoint row) is dead: the
        // same failure on every cycle, which is what parks the sync.
        throw new Error('object store unreachable')
      },
      onPark: (info) => parks.push(info),
      logger: logger(),
    })

    for (let i = 0; i < 20; i++) await sync.flush()

    expect(sync.isParked).toBe(true)
    expect(parks).toHaveLength(1)
    expect(parks[0].reason).toContain('object store unreachable')
    expect(parks[0].consecutiveFailures).toBeGreaterThanOrEqual(20)

    // The workspace still backed up: the user's file is committed, and every
    // reserved name this host could create stayed out of the index (and is
    // still on disk, untouched).
    const tracked = git(dir, 'ls-files').split('\n').filter(Boolean)
    expect(tracked).toContain('keep.txt')
    for (const rel of present) {
      expect(tracked).not.toContain(rel)
      expect(existsSync(join(dir, rel))).toBe(true)
    }

    // Each reserved name is reported once, with the way to get rid of it.
    const reserved = logs.filter((l) => l.includes('not staging'))
    expect(reserved).toHaveLength(present.length)
    for (const rel of present) {
      expect(reserved.some((l) => l.includes(`"${rel}"`) && l.includes('rm -f'))).toBe(true)
    }

    // No "push" wording in local-only mode.
    expect(logs.some((l) => /S3 Layer 2|\bpush(es|ed)?\b/i.test(l))).toBe(false)

    // The lifetime counter is on disk, so a restart continues the same streak.
    const state = JSON.parse(readFileSync(join(dir, '.git', 'shogo-sync-state.json'), 'utf8'))
    expect(state.lifetimeFailures).toBeGreaterThanOrEqual(20)
    expect(typeof state.firstFailureAt).toBe('string')

    await sync.flushAndShutdown(200)
  })

  test('while parked, finished turns do not restart the retry loop', async () => {
    const sync = new GitWorkspaceSync({
      workspaceDir: dir,
      cloudApiUrl: 'http://api.test.invalid',
      runtimeAuthSecret: 'runtime-secret',
      projectId: 'proj-qa',
      localOnly: true,
      afterCommit: () => { throw new Error('object store unreachable') },
      onPark: (info) => parks.push(info),
      logger: logger(),
    })

    for (let i = 0; i < 20; i++) await sync.flush()
    expect(sync.isParked).toBe(true)

    // Backoff timers scheduled before the park can still fire while the loop
    // runs, so snapshot the counter once the sync is parked rather than
    // assuming it landed on exactly 20.
    const failuresAtPark = sync.lifetimeFailures
    expect(failuresAtPark).toBeGreaterThanOrEqual(20)

    writeFileSync(join(dir, 'later.txt'), 'a change made after the park\n')
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim()
    for (let i = 0; i < 5; i++) sync.triggerSync(true)
    await new Promise((r) => setTimeout(r, 100))
    // Trigger after trigger inside the 10-minute window is skipped, so neither
    // the attempt counter nor HEAD moves.
    expect(sync.lifetimeFailures).toBe(failuresAtPark)
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore)

    await sync.flushAndShutdown(200)
  })
})
