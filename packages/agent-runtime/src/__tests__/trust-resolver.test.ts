// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the live trust resolver — the module that replaced
 * the broken spawn-time `TRUST_LEVEL` env snapshot.
 *
 * Coverage targets the contract the rest of the runtime depends on:
 *   - init seeds the immutable triplet (workspaceDir / workingMode /
 *     linkedFolders) AND picks a fail-closed initial trust for
 *     external projects (the security default)
 *   - refresh() fetches the authoritative trust from the API and
 *     overwrites the cell
 *   - concurrent refresh() calls share a single in-flight fetch
 *   - HTTP failures keep the last-known value (no flapping into
 *     'restricted' on a transient blip)
 *   - resolver with no projectId is a safe no-op (test / one-shot
 *     script path)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetTrustForTests,
  __setTrustForTests,
  getResolvedTrust,
  initTrustResolver,
  isTrustResolverInitialized,
  refreshTrust,
} from '../trust-resolver'

type FetchFn = typeof fetch
const originalFetch = globalThis.fetch

function installFetchMock(impl: (url: string) => Promise<Response>): void {
  // Cast through unknown so we don't have to fully reimplement the
  // `typeof fetch` interface (preconnect, etc.) — none of the tests
  // touch those properties.
  globalThis.fetch = ((input: any) =>
    impl(typeof input === 'string' ? input : String(input))) as unknown as FetchFn
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('trust-resolver', () => {
  beforeEach(() => {
    __resetTrustForTests()
    process.env.SHOGO_API_URL = 'http://api.test'
    process.env.RUNTIME_AUTH_SECRET = 'test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    __resetTrustForTests()
    delete process.env.SHOGO_API_URL
    delete process.env.RUNTIME_AUTH_SECRET
  })

  test('init seeds immutable triplet and fail-closed trust for external', () => {
    initTrustResolver({
      projectId: 'p1',
      workspaceDir: '/work/p1',
      workingMode: 'external',
      linkedFolders: ['/work/p1', '/extra/lib'],
    })
    const t = getResolvedTrust()
    expect(t.workingMode).toBe('external')
    expect(t.workspaceDir).toBe('/work/p1')
    expect(t.linkedFolders).toEqual(['/work/p1', '/extra/lib'])
    expect(t.trustLevel).toBe('restricted') // fail-closed default
    expect(isTrustResolverInitialized()).toBe(false) // no refresh yet
  })

  test('init seeds fail-open trust for managed', () => {
    initTrustResolver({
      projectId: 'p1',
      workspaceDir: '/sandbox/p1',
      workingMode: 'managed',
      linkedFolders: [],
    })
    expect(getResolvedTrust().trustLevel).toBe('trusted')
  })

  test('refresh() pulls authoritative trust from API and flips the cell', async () => {
    initTrustResolver({
      projectId: 'p-ext',
      workspaceDir: '/work/p-ext',
      workingMode: 'external',
      linkedFolders: ['/work/p-ext'],
    })
    expect(getResolvedTrust().trustLevel).toBe('restricted')

    let calls = 0
    installFetchMock(async (url) => {
      calls++
      expect(url).toBe('http://api.test/api/internal/projects/p-ext/trust')
      return jsonRes({
        trustLevel: 'trusted',
        workingMode: 'external',
        linkedFolders: ['/work/p-ext', '/added/by/user'],
      })
    })

    await refreshTrust()

    const t = getResolvedTrust()
    expect(t.trustLevel).toBe('trusted')
    expect(t.linkedFolders).toEqual(['/work/p-ext', '/added/by/user'])
    expect(isTrustResolverInitialized()).toBe(true)
    expect(calls).toBe(1)
  })

  test('concurrent refresh() calls dedupe into one HTTP fetch', async () => {
    initTrustResolver({
      projectId: 'p2',
      workspaceDir: '/work/p2',
      workingMode: 'external',
      linkedFolders: [],
    })

    let calls = 0
    installFetchMock(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return jsonRes({ trustLevel: 'trusted', workingMode: 'external', linkedFolders: [] })
    })

    await Promise.all([refreshTrust(), refreshTrust(), refreshTrust()])
    expect(calls).toBe(1)
  })

  test('refresh() failure keeps last-known value (no flap)', async () => {
    initTrustResolver({
      projectId: 'p3',
      workspaceDir: '/work/p3',
      workingMode: 'external',
      linkedFolders: [],
    })
    // Pin the cell to trusted as the "last known" value.
    __setTrustForTests({ trustLevel: 'trusted', initialized: true })

    installFetchMock(async () => jsonRes({ error: 'boom' }, 500))

    await refreshTrust()

    // HTTP 500 → resolver logs and keeps the previous value.
    expect(getResolvedTrust().trustLevel).toBe('trusted')
  })

  test('refresh() with no projectId is a safe no-op', async () => {
    initTrustResolver({
      projectId: null,
      workspaceDir: '/work/anon',
      workingMode: 'managed',
      linkedFolders: [],
    })

    let calls = 0
    installFetchMock(async () => {
      calls++
      return jsonRes({})
    })

    await refreshTrust()
    expect(calls).toBe(0)
    // Cell stays at the init-time fail-open default.
    expect(getResolvedTrust().trustLevel).toBe('trusted')
  })

  test('refresh() swallows network errors and keeps last-known value', async () => {
    initTrustResolver({
      projectId: 'p-net',
      workspaceDir: '/work/p-net',
      workingMode: 'external',
      linkedFolders: [],
    })
    __setTrustForTests({ trustLevel: 'trusted', initialized: true })

    installFetchMock(async () => {
      throw new Error('ECONNREFUSED')
    })

    // Must not reject — a transient network blip can't break the
    // chat turn. The resolver should log and move on.
    await expect(refreshTrust()).resolves.toBeUndefined()
    expect(getResolvedTrust().trustLevel).toBe('trusted')
  })

  test('refresh() URL-encodes the projectId (defense against malformed ids)', async () => {
    initTrustResolver({
      projectId: 'p/with spaces & slashes',
      workspaceDir: '/work/weird',
      workingMode: 'external',
      linkedFolders: [],
    })

    const observed: { url: string | null } = { url: null }
    installFetchMock(async (url) => {
      observed.url = url
      return jsonRes({ trustLevel: 'trusted', workingMode: 'external', linkedFolders: [] })
    })

    await refreshTrust()
    expect(observed.url).toBe(
      'http://api.test/api/internal/projects/p%2Fwith%20spaces%20%26%20slashes/trust',
    )
  })

  test('init reset between two different projects clears initialized flag', async () => {
    initTrustResolver({
      projectId: 'first',
      workspaceDir: '/a',
      workingMode: 'managed',
      linkedFolders: [],
    })
    installFetchMock(async () =>
      jsonRes({ trustLevel: 'trusted', workingMode: 'managed', linkedFolders: [] }),
    )
    await refreshTrust()
    expect(isTrustResolverInitialized()).toBe(true)

    // Re-init with a different project — initialized flag must reset
    // so callers can tell the new project hasn't been resolved yet.
    initTrustResolver({
      projectId: 'second',
      workspaceDir: '/b',
      workingMode: 'external',
      linkedFolders: [],
    })
    expect(isTrustResolverInitialized()).toBe(false)
    expect(getResolvedTrust().workspaceDir).toBe('/b')
    expect(getResolvedTrust().trustLevel).toBe('restricted') // fail-closed for external
  })

  test('__setTrustForTests applies partial updates without wiping other fields', () => {
    initTrustResolver({
      projectId: 'p-partial',
      workspaceDir: '/work/partial',
      workingMode: 'external',
      linkedFolders: ['/work/partial', '/work/extra'],
    })

    __setTrustForTests({ trustLevel: 'trusted' })
    const t = getResolvedTrust()
    expect(t.trustLevel).toBe('trusted')
    expect(t.workspaceDir).toBe('/work/partial') // untouched
    expect(t.linkedFolders).toEqual(['/work/partial', '/work/extra']) // untouched
    expect(t.workingMode).toBe('external') // untouched
  })

  test('getResolvedTrust returns a defensive copy of linkedFolders', () => {
    initTrustResolver({
      projectId: 'p-defensive',
      workspaceDir: '/x',
      workingMode: 'external',
      linkedFolders: ['/x', '/y'],
    })
    const first = getResolvedTrust()
    first.linkedFolders.push('/z')
    // Mutating the returned array must not leak back into the cell.
    expect(getResolvedTrust().linkedFolders).toEqual(['/x', '/y'])
  })

  test('refresh() in-flight is discarded if projectId changes mid-fetch', async () => {
    // Defends against initTrustResolver() running for a new project
    // while a refresh from the previous project is still in flight.
    // Without the race guard, the in-flight response would write the
    // old project's trust into the new project's slot.
    initTrustResolver({
      projectId: 'old',
      workspaceDir: '/old',
      workingMode: 'external',
      linkedFolders: [],
    })

    let resolveFetch: (r: Response) => void = () => {}
    installFetchMock(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r
        }),
    )

    const inFlight = refreshTrust()

    // While the fetch is still pending, switch to a new project.
    initTrustResolver({
      projectId: 'new',
      workspaceDir: '/new',
      workingMode: 'managed',
      linkedFolders: [],
    })

    // Now resolve the old fetch with a value that, if mis-applied,
    // would corrupt the new project's slot.
    resolveFetch(
      jsonRes({ trustLevel: 'restricted', workingMode: 'external', linkedFolders: ['/old'] }),
    )
    await inFlight

    const t = getResolvedTrust()
    expect(t.workspaceDir).toBe('/new')
    expect(t.trustLevel).toBe('trusted') // new project's init default, untouched
    expect(t.linkedFolders).toEqual([]) // not corrupted by old project's response
    expect(isTrustResolverInitialized()).toBe(false) // race-discarded fetch must not flip the flag
  })

  test('refresh() ignores malformed body fields (keeps structural defaults)', async () => {
    initTrustResolver({
      projectId: 'p4',
      workspaceDir: '/work/p4',
      workingMode: 'external',
      linkedFolders: ['/work/p4'],
    })

    installFetchMock(async () =>
      jsonRes({
        // wrong types — resolver must normalize / fall back
        trustLevel: 42,
        workingMode: null,
        linkedFolders: 'not an array',
      }),
    )

    await refreshTrust()

    const t = getResolvedTrust()
    // wrong trust => not 'restricted' literal so resolver maps to 'trusted'
    // (the explicit "trusted unless explicitly restricted" rule).
    expect(t.trustLevel).toBe('trusted')
    // wrong workingMode => not 'external' literal so resolver maps to 'managed'.
    expect(t.workingMode).toBe('managed')
    // non-array linkedFolders => keep the previous value rather than wipe it.
    expect(t.linkedFolders).toEqual(['/work/p4'])
  })
})
