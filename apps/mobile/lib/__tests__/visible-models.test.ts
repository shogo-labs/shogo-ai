// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-497 — the stale-selection reconcile must not reset a pick it cannot judge.
 *
 * The picker's reconcile hook used to decide against whatever snapshot was
 * painted, including one loaded from storage for another workspace (or from
 * before the catalog changed). A model id missing from that stale list was
 * treated as "gone", reset to the fallback and saved — one of the ways a picked
 * Opus turned back into Auto. The fixed rule, pinned here:
 *
 *   - nothing is decided while the snapshot for the *current* key is still
 *     loading, or when only a cached paint exists (AC5a);
 *   - a selection that is an alias / old slug of a visible model is remapped to
 *     that model's id, not reset (AC5b);
 *   - a selection that really is gone resets to the fallback, or to Auto when
 *     the fallback is not visible either (AC5c).
 *
 *   bun test apps/mobile/lib/__tests__/visible-models.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const OPUS = 'a1b2c3d4-0000-4000-8000-0000000000a1'
const SONNET = 'a1b2c3d4-0000-4000-8000-0000000000a2'
const RETIRED = 'a1b2c3d4-0000-4000-8000-0000000000ff'
const OLD_SLUG = 'claude-opus-4-5'

const STORAGE_KEY = 'shogo.visibleModels.v1:__platform__'

/** A snapshot from an earlier session: it does not know the retired model. */
const cachedPaint = {
  catalogIds: null,
  catalogModels: [
    { id: OPUS, provider: 'anthropic', displayName: 'Claude Opus 4.5', shortDisplayName: 'Opus 4.5', tier: 'premium' },
    { id: SONNET, provider: 'anthropic', displayName: 'Claude Sonnet 4.6', shortDisplayName: 'Sonnet 4.6', tier: 'standard' },
  ],
  openrouterModels: [],
}

/** What the current server actually serves: the slug the selection was saved as. */
const liveCatalog = {
  catalogIds: null,
  catalogModels: [
    { id: OPUS, provider: 'anthropic', displayName: 'Claude Opus 4.5', shortDisplayName: 'Opus 4.5', tier: 'premium', aliases: [OLD_SLUG] },
    { id: SONNET, provider: 'anthropic', displayName: 'Claude Sonnet 4.6', shortDisplayName: 'Sonnet 4.6', tier: 'standard' },
  ],
  openrouterModels: [],
}

/** Storage as the module sees it: a cached paint for the active (platform) key. */
const local = new Map<string, string>([[STORAGE_KEY, JSON.stringify(cachedPaint)]])

const fetchState: {
  resolve: ((value: unknown) => void) | null
  reject: ((err: unknown) => void) | null
  calls: number
} = { resolve: null, reject: null, calls: 0 }

mock.module('../../lib/api', () => ({ createHttpClient: () => ({}) }))
mock.module('@shogo-ai/sdk', () => ({
  PlatformApi: class {
    getVisibleModels() {
      fetchState.calls++
      return new Promise((resolve, reject) => {
        fetchState.resolve = resolve
        fetchState.reject = reject
      })
    }
    getWorkspaceVisibleModels() {
      return this.getVisibleModels()
    }
  },
}))

type Mod = typeof import('../visible-models')
let mod: Mod

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => {
        local.set(key, value)
      },
      removeItem: (key: string) => {
        local.delete(key)
      },
    },
  })
  mod = await import('../visible-models')
})

afterEach(cleanup)

beforeEach(() => {
  fetchState.resolve = null
  fetchState.reject = null
  fetchState.calls = 0
  // Each test starts from the same "one cached paint, nothing confirmed" state.
  mod.__resetVisibleModelsCacheForTests()
})

/** Render the hook the picker mounts and return the ids it reset to. */
function renderReconcile(selected: string, fallback: string) {
  const resets: string[] = []
  const hook = renderHook(() => {
    mod.useReconcileStaleModelSelection(selected, fallback, (id) => resets.push(id))
    return null
  })
  return { resets, hook }
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

describe('reconcileModelSelection (pure)', () => {
  test('a loading or absent snapshot decides nothing', () => {
    expect(mod.reconcileModelSelection(RETIRED, SONNET, null)).toBeNull()
    expect(
      mod.reconcileModelSelection(RETIRED, SONNET, { catalogIds: null, catalogModels: [], openrouterModels: [] } as any),
    ).toBeNull()
  })

  test('AC5b: an alias / old slug is remapped to the catalog id, not reset', () => {
    expect(mod.reconcileModelSelection(OLD_SLUG, SONNET, liveCatalog as any)).toBe(OPUS)
  })

  test('AC5c: a selection that really is gone resets to the fallback', () => {
    expect(mod.reconcileModelSelection(RETIRED, SONNET, liveCatalog as any)).toBe(SONNET)
  })

  test('AC5c: … or to Auto when the fallback is not visible either', () => {
    expect(mod.reconcileModelSelection(RETIRED, RETIRED, liveCatalog as any)).toBe('auto')
  })

  test('a visible id and Auto are left alone', () => {
    expect(mod.reconcileModelSelection(OPUS, SONNET, liveCatalog as any)).toBeNull()
    expect(mod.reconcileModelSelection(SONNET, SONNET, liveCatalog as any)).toBeNull()
    expect(mod.reconcileModelSelection('auto', SONNET, liveCatalog as any)).toBeNull()
  })
})

describe('useReconcileStaleModelSelection (SHO-497 AC5a)', () => {
  test('body still in flight: the cached paint does not get to reset the pick', async () => {
    const { resets } = renderReconcile(RETIRED, SONNET)
    await settle()

    // The cached paint does not know RETIRED, but it is also not authority for
    // this key — nothing may be reset on its word.
    expect(fetchState.calls).toBeGreaterThan(0)
    expect(resets).toEqual([])
  })

  test('the revalidated snapshot is what decides — a live pick is not touched', async () => {
    const { resets } = renderReconcile(OLD_SLUG, SONNET)
    await settle()

    act(() => fetchState.resolve(liveCatalog))
    await settle()

    // Remapped to the model's id (persisted by the owner), never to Auto.
    await waitFor(() => expect(resets).toEqual([OPUS]))
  })

  test('a selection the live catalog really dropped is reset once', async () => {
    const { resets } = renderReconcile(RETIRED, SONNET)
    await settle()

    act(() => fetchState.resolve(liveCatalog))
    await settle()

    await waitFor(() => expect(resets).toEqual([SONNET]))
  })

  test('a failed fetch keeps the pick (a network error is not a deletion)', async () => {
    const { resets } = renderReconcile(RETIRED, SONNET)
    await settle()

    act(() => fetchState.reject(new Error('offline')))
    await settle()

    expect(resets).toEqual([])
  })
})
