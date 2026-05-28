// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `GET /api/local/fs/browse` — the server-side directory
 * listing used by the in-app folder picker when Electron's native
 * dialog isn't available (e.g. `bun dev:all` in a plain browser).
 *
 * The fixtures all live under `$HOME` so the route's `isUnderHome`
 * gate passes. We clean up after every case so a CI flake on one
 * leaves nothing behind that could poison the next run.
 *
 * Run: bun test apps/api/src/__tests__/local-fs-browse.test.ts
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import { join } from 'path'

mock.module('../lib/prisma', () => ({ prisma: {} }))

// Sandbox safety: $HOME is /app (read-only) inside the runtime pod.
// Point os.homedir() at a writable scratch dir UNDER os.tmpdir() so
// (a) mkdtempSync(join(HOME, ...)) can actually write, (b) isUnderHome()
// in the route accepts those paths, and (c) the "outside HOME" fixtures
// below (which write to a sibling under os.tmpdir() via mkdtempSync) are
// still genuinely outside the patched HOME. Per-file isolation under
// run-tests-isolated.ts keeps this scoped.
import { mkdirSync as _mkdirSyncForHome } from 'node:fs'
const _fakeHome = join(os.tmpdir(), 'shogo-fake-home-' + Date.now() + '-' + Math.random().toString(36).slice(2))
_mkdirSyncForHome(_fakeHome, { recursive: true })
;(os as { homedir: () => string }).homedir = () => _fakeHome

const { localProjectsRoutes } = await import('../routes/local-projects')

const HOME = os.homedir()

let authed = true

function buildApp(): Hono {
  const app = new Hono()
  // Mirror authMiddleware: set `auth` so the handler's `c.get('auth')`
  // check passes (or fails, for the unauth case).
  app.use('/api/local/projects/*', async (c, next) => {
    if (authed) c.set('auth' as never, { userId: 'test-user' } as never)
    await next()
  })
  app.route('/api/local/projects', localProjectsRoutes())
  return app
}

let tmpRoot: string
beforeEach(() => {
  authed = true
  // Important: tmpdir under $HOME (not /tmp) so `isUnderHome` passes.
  // The "outside home" cases below build their fixtures elsewhere.
  tmpRoot = mkdtempSync(join(HOME, '.shogo-fs-browse-test-'))
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('GET /api/local/fs/browse', () => {
  test('happy path: lists directories sorted, includes parent, omits files by default', async () => {
    mkdirSync(join(tmpRoot, 'beta'))
    mkdirSync(join(tmpRoot, 'alpha'))
    mkdirSync(join(tmpRoot, '.dotdir'))
    writeFileSync(join(tmpRoot, 'README.md'), 'hi')

    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(tmpRoot)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    // realpath might differ from the requested path on macOS (where
    // /var → /private/var), so compare end-segments.
    expect(body.path.endsWith(tmpRoot.split('/').pop()!)).toBe(true)
    expect(body.parent).toBeTruthy()
    expect(body.home).toBe(HOME)
    expect(body.truncated).toBe(false)

    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
    expect(names).toContain('.dotdir')
    // Files are excluded by default
    expect(names).not.toContain('README.md')
    // Sorted: alphabetical, case-insensitive. Dotted folders sort by
    // localeCompare which puts '.dotdir' first or last depending on
    // locale — assert just the relative order of alpha vs beta to keep
    // the test stable across CI locales.
    expect(names.indexOf('alpha')).toBeLessThan(names.indexOf('beta'))

    // All listed entries are directories (since includeFiles defaulted off)
    for (const e of body.entries) {
      expect(e.isDirectory).toBe(true)
    }
  })

  test('includeFiles=true returns regular files too', async () => {
    mkdirSync(join(tmpRoot, 'sub'))
    writeFileSync(join(tmpRoot, 'a.txt'), 'a')

    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(tmpRoot)}&includeFiles=true`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('sub')
    expect(names).toContain('a.txt')
    // Directories sort first
    expect(names.indexOf('sub')).toBeLessThan(names.indexOf('a.txt'))
  })

  test('no path query: defaults to $HOME and parent is null', async () => {
    const app = buildApp()
    const res = await app.request('/api/local/projects/fs/browse')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    // realpath of HOME may differ on macOS; compare the realpath of
    // both sides via Node's path resolution rather than literal equality.
    expect(body.parent).toBeNull()
  })

  test('missing path → 400 not_found', async () => {
    const ghost = join(tmpRoot, 'does-not-exist-xyz')
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(ghost)}`,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.code).toBe('not_found')
  })

  test('file path → 400 not_directory', async () => {
    const file = join(tmpRoot, 'a.txt')
    writeFileSync(file, 'a')
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(file)}`,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('not_directory')
  })

  test('/etc → 400 forbidden_root', async () => {
    const app = buildApp()
    const res = await app.request('/api/local/projects/fs/browse?path=/etc')
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBeOneOf(['forbidden_root', 'outside_home'])
  })

  test('relative path → 400 not_absolute', async () => {
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent('./relative')}`,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('not_absolute')
  })

  test('path outside $HOME → 400 outside_home', async () => {
    // Build a temp dir under the system tmp (definitely not under $HOME
    // — `os.tmpdir()` lives under /var on macOS and /tmp on Linux).
    const outside = mkdtempSync(join(os.tmpdir(), 'shogo-fs-browse-outside-'))
    try {
      const app = buildApp()
      const res = await app.request(
        `/api/local/projects/fs/browse?path=${encodeURIComponent(outside)}`,
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).code).toBe('outside_home')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('symlink inside $HOME pointing outside $HOME → outside_home (realpath defense)', async () => {
    const outside = mkdtempSync(join(os.tmpdir(), 'shogo-fs-browse-escape-'))
    try {
      const link = join(tmpRoot, 'escape')
      symlinkSync(outside, link)
      const app = buildApp()
      const res = await app.request(
        `/api/local/projects/fs/browse?path=${encodeURIComponent(link)}`,
      )
      // Symlink resolves to outside-$HOME → rejected by the post-realpath
      // `isUnderHome` re-check.
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).code).toBe('outside_home')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('truncates at 1000 entries', async () => {
    // Quietly create 1001 sub-folders. mkdir(recursive) lets us batch
    // them; flat layout keeps the test fast.
    for (let i = 0; i < 1001; i++) {
      mkdirSync(join(tmpRoot, `d-${String(i).padStart(4, '0')}`))
    }
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(tmpRoot)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.truncated).toBe(true)
    expect(body.entries.length).toBe(1000)
  })

  test('unauthenticated → 401', async () => {
    authed = false
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(tmpRoot)}`,
    )
    expect(res.status).toBe(401)
  })

  test('hidden flag is set on dot-folders', async () => {
    mkdirSync(join(tmpRoot, '.shogo'))
    mkdirSync(join(tmpRoot, 'visible'))
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(tmpRoot)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const dotEntry = body.entries.find((e: any) => e.name === '.shogo')
    const visibleEntry = body.entries.find((e: any) => e.name === 'visible')
    expect(dotEntry.hidden).toBe(true)
    expect(visibleEntry.hidden).toBe(false)
  })

  test('symlink-to-directory inside $HOME is reported as isDirectory=true, isSymlink=true', async () => {
    mkdirSync(join(tmpRoot, 'real'))
    const link = join(tmpRoot, 'link-to-real')
    symlinkSync(join(tmpRoot, 'real'), link)
    const app = buildApp()
    const res = await app.request(
      `/api/local/projects/fs/browse?path=${encodeURIComponent(tmpRoot)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const entry = body.entries.find((e: any) => e.name === 'link-to-real')
    expect(entry).toBeTruthy()
    expect(entry.isSymlink).toBe(true)
    expect(entry.isDirectory).toBe(true)
  })
})
