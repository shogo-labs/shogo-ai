// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lineage rules for the incremental repo manifest, the bundle upload, and the
 * GC sweep. These run against an in-memory {@link RepoObjectStore} that is
 * passed in directly. No module is mocked, so nothing leaks into other tests.
 */

import { describe, expect, test } from 'bun:test'
import type { MetalConfig } from './config'
import {
  planManifestWrite,
  repoArchiveKey,
  repoManifestKey,
  selectUnreferencedBundles,
  sweepRepoBundles,
  uploadRepoBundle,
  uploadRepoManifestGuarded,
  type RepoObjectStore,
} from './repo-archive'
import type { RepoManifest } from './vendor/repo-bundles'
import type { ConditionalPutResult } from './s3-conditional'

const cfg = {} as MetalConfig
const P = 'proj-1'
const mkey = repoManifestKey(P)
const tkey = repoArchiveKey(P)

type Obj = { body: string; etag: string; modified: number }

/** In-memory store with the same conditional semantics the real one enforces. */
function fakeStore(initial: Record<string, Obj> = {}) {
  const objects = new Map<string, Obj>(Object.entries(initial))
  const puts: Array<{ key: string; precondition: unknown }> = []
  let nextPut: ConditionalPutResult['status'] = 'ok'
  const store: RepoObjectStore & { objects: typeof objects; puts: typeof puts; failNextPut(): void } = {
    objects,
    puts,
    failNextPut() {
      nextPut = 'precondition-failed'
    },
    async head(key) {
      const o = objects.get(key)
      return o ? { etag: o.etag, lastModified: o.modified } : null
    },
    async readText(key) {
      const o = objects.get(key)
      if (!o) throw new Error(`no such key ${key}`)
      return o.body
    },
    async write(key, body) {
      objects.set(key, { body: typeof body === 'string' ? body : '<binary>', etag: `"w-${key}"`, modified: Date.now() })
    },
    async conditionalPut(key, body, precondition) {
      puts.push({ key, precondition })
      if (nextPut !== 'ok') {
        nextPut = 'ok'
        return { status: 'precondition-failed' }
      }
      objects.set(key, { body, etag: '"new"', modified: Date.now() })
      return { status: 'ok', etag: '"new"' }
    },
    async list(prefix) {
      return {
        keys: [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, o]) => ({ key, lastModified: o.modified })),
      }
    },
    async remove(key) {
      objects.delete(key)
    },
  }
  return store
}

const manifest: RepoManifest = {
  v: 1,
  head: { ref: 'refs/heads/main' },
  refs: { 'refs/heads/main': 'a'.repeat(40) },
  config: '',
  rootCommitAt: null,
  bundles: [{ sha256: 'b'.repeat(64), bytes: 1, kind: 'base' }],
}

const now = Date.now()
const DAY = 24 * 60 * 60 * 1000

describe('planManifestWrite: lineage table', () => {
  const base = { exists: false, tarballEtag: null, tarballExists: false }

  test('a brand-new project may create its manifest', () => {
    expect(planManifestWrite({ ...base, lineage: { kind: 'create-only' } })).toEqual({
      action: 'put',
      precondition: { ifNoneMatch: '*' },
    })
  })

  test('descending from a manifest that does not exist is a conflict', () => {
    expect(planManifestWrite({ ...base, lineage: { kind: 'descends', etag: '"m0"' } })).toEqual({
      action: 'conflict',
      reason: 'lineage',
    })
  })

  test('replaces the manifest it descends from, by ETag', () => {
    expect(planManifestWrite({ ...base, exists: true, lineage: { kind: 'descends', etag: '"m1"' } })).toEqual({
      action: 'put',
      precondition: { ifMatch: '"m1"' },
    })
  })

  test('create-only never overwrites an existing manifest', () => {
    expect(planManifestWrite({ ...base, exists: true, lineage: { kind: 'create-only' } })).toEqual({
      action: 'conflict',
      reason: 'raced-create',
    })
  })

  test('untrusted lineage refuses', () => {
    expect(planManifestWrite({ ...base, lineage: { kind: 'untrusted', reason: 'hydrate failed' } })).toEqual({
      action: 'refuse',
      reason: 'hydrate failed',
    })
  })

  test('migration: a lineage descending from the exact tarball may create the manifest', () => {
    expect(
      planManifestWrite({ exists: false, tarballExists: true, tarballEtag: '"t1"', lineage: { kind: 'descends', etag: '"t1"' } }),
    ).toEqual({ action: 'put', precondition: { ifNoneMatch: '*' } })
  })

  test('migration: a tarball rewritten since hydrate blocks it', () => {
    expect(
      planManifestWrite({ exists: false, tarballExists: true, tarballEtag: '"t2"', lineage: { kind: 'descends', etag: '"t1"' } }),
    ).toEqual({ action: 'conflict', reason: 'lineage' })
  })

  test('migration: create-only cannot take over a project that already has a tarball', () => {
    expect(
      planManifestWrite({ exists: false, tarballExists: true, tarballEtag: '"t1"', lineage: { kind: 'create-only' } }),
    ).toEqual({ action: 'conflict', reason: 'lineage' })
  })
})

describe('uploadRepoManifestGuarded', () => {
  test('creates the manifest for a new project', async () => {
    const store = fakeStore()
    const out = await uploadRepoManifestGuarded(P, manifest, { lineage: { kind: 'create-only' } }, cfg, store)
    expect(out).toEqual({ status: 'created', etag: '"new"' })
    expect(store.puts).toEqual([{ key: mkey, precondition: { ifNoneMatch: '*' } }])
  })

  test('replaces its manifest by ETag and reports written', async () => {
    const store = fakeStore({ [mkey]: { body: '{}', etag: '"m1"', modified: now } })
    const out = await uploadRepoManifestGuarded(P, manifest, { lineage: { kind: 'descends', etag: '"m1"' } }, cfg, store)
    expect(out).toEqual({ status: 'written', etag: '"new"' })
    expect(store.puts[0].precondition).toEqual({ ifMatch: '"m1"' })
  })

  test('a stale ETag that loses the race quarantines the manifest', async () => {
    const store = fakeStore({ [mkey]: { body: '{}', etag: '"m2"', modified: now } })
    store.failNextPut()
    const out = await uploadRepoManifestGuarded(
      P,
      manifest,
      { lineage: { kind: 'descends', etag: '"m1"' }, preserveOnRefusal: true },
      cfg,
      store,
    )
    expect(out.status).toBe('conflict')
    expect(out.status === 'conflict' && out.quarantineKey?.startsWith(`conflict/${P}/`)).toBe(true)
  })

  test('a refused write is quarantined only when asked to preserve it', async () => {
    const store = fakeStore({ [mkey]: { body: '{}', etag: '"m1"', modified: now } })
    const out = await uploadRepoManifestGuarded(P, manifest, { lineage: { kind: 'create-only' } }, cfg, store)
    expect(out).toMatchObject({ status: 'conflict', reason: 'raced-create', quarantineKey: null })
    expect(store.puts).toHaveLength(0)
  })

  test('no store configured means nothing is written', async () => {
    const out = await uploadRepoManifestGuarded(P, manifest, { lineage: { kind: 'create-only' } }, cfg, null)
    expect(out).toEqual({ status: 'skipped' })
  })

  test('migrates a tarball-only project when the lineage matches it', async () => {
    const store = fakeStore({ [tkey]: { body: 'tar', etag: '"t1"', modified: now } })
    const out = await uploadRepoManifestGuarded(P, manifest, { lineage: { kind: 'descends', etag: '"t1"' } }, cfg, store)
    expect(out.status).toBe('created')
    expect(store.puts[0].precondition).toEqual({ ifNoneMatch: '*' })
  })
})

describe('uploadRepoBundle', () => {
  const entry = { sha256: 'c'.repeat(64), bytes: 3, kind: 'base' as const }
  const body = {} as any

  test('uploads a bundle that is not stored yet', async () => {
    const store = fakeStore()
    expect(await uploadRepoBundle(P, entry, body, cfg, store)).toBe('uploaded')
    expect(store.objects.has(`${P}/repo/bundles/${entry.sha256}.bundle`)).toBe(true)
  })

  test('an existing digest is not written again', async () => {
    const store = fakeStore({ [`${P}/repo/bundles/${entry.sha256}.bundle`]: { body: '', etag: '"x"', modified: now } })
    expect(await uploadRepoBundle(P, entry, body, cfg, store)).toBe('present')
  })
})

describe('sweepRepoBundles', () => {
  const sha = (c: string) => c.repeat(64)
  const bkey = (c: string) => `${P}/repo/bundles/${sha(c)}.bundle`
  const old = now - 3 * DAY
  const young = now - 60_000

  test('deletes an old unreferenced bundle; keeps the referenced and the young', async () => {
    const store = fakeStore({
      [bkey('1')]: { body: '', etag: '"1"', modified: old }, // in the manifest
      [bkey('2')]: { body: '', etag: '"2"', modified: old }, // retired
      [bkey('3')]: { body: '', etag: '"3"', modified: young }, // in flight
      [mkey]: {
        body: JSON.stringify({ ...manifest, bundles: [{ sha256: sha('1'), bytes: 1, kind: 'base' }] }),
        etag: '"m"',
        modified: now,
      },
    })
    expect(await sweepRepoBundles(P, cfg, now, DAY, store)).toEqual({ deleted: 1, kept: 2 })
    expect(store.objects.has(bkey('1'))).toBe(true)
    expect(store.objects.has(bkey('2'))).toBe(false)
    expect(store.objects.has(bkey('3'))).toBe(true)
  })

  test('a bundle a quarantined manifest still references is kept', async () => {
    const store = fakeStore({
      [bkey('4')]: { body: '', etag: '"4"', modified: old },
      [`conflict/${P}/123-abc-manifest.json`]: {
        body: JSON.stringify({ ...manifest, bundles: [{ sha256: sha('4'), bytes: 1, kind: 'base' }] }),
        etag: '"q"',
        modified: now,
      },
    })
    await sweepRepoBundles(P, cfg, now, DAY, store)
    expect(store.objects.has(bkey('4'))).toBe(true)
  })

  test('an unreadable quarantined manifest aborts the sweep, deleting nothing', async () => {
    const store = fakeStore({
      [bkey('5')]: { body: '', etag: '"5"', modified: old },
      [`conflict/${P}/456-def-manifest.json`]: { body: 'not json', etag: '"x"', modified: now },
    })
    await expect(sweepRepoBundles(P, cfg, now, DAY, store)).rejects.toThrow()
    expect(store.objects.has(bkey('5'))).toBe(true)
  })

  test('without a store there is nothing to sweep', async () => {
    expect(await sweepRepoBundles(P, cfg, now, DAY, null)).toBeNull()
  })

  test('the pure rule keeps anything of unknown age', () => {
    const k = (c: string) => `${P}/repo/bundles/${sha(c)}.bundle`
    expect(selectUnreferencedBundles([{ key: k('6'), lastModified: null }], new Set(), now, DAY)).toEqual({
      delete: [],
      kept: 1,
    })
  })
})
