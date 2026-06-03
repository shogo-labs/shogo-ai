// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/services/workspace-models.service.ts — the
 * per-workspace model allowlist (inherit vs. restrict) + the proxy visibility
 * gate.
 *
 *   bun test apps/api/src/services/__tests__/workspace-models.service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ─── Mutable mock data + call counters ──────────────────────────────────────
let ROWS: Array<{ modelId: string }> = []
let findManyCalls = 0
const deleteManyArgs: any[] = []
const createManyArgs: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspaceModelVisibility: {
      findMany: async (_args?: any) => {
        findManyCalls++
        return ROWS.map((r) => ({ modelId: r.modelId }))
      },
      deleteMany: async (args: any) => {
        deleteManyArgs.push(args)
        ROWS = []
        return { count: 0 }
      },
      createMany: async (args: any) => {
        createManyArgs.push(args)
        ROWS = args.data.map((d: any) => ({ modelId: d.modelId }))
        return { count: args.data.length }
      },
    },
    // The service calls $transaction([...]) where each element is the (already
    // executing, in our mock) promise returned by deleteMany/createMany.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}))

// Mock the model registry so alias resolution is deterministic and doesn't pull
// in the real DB-backed catalog.
mock.module('../model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) =>
    id === 'opus-alias' ? { id: 'claude-opus-4-7' } : undefined,
}))

const {
  getAllowedModelIds,
  setAllowedModelIds,
  isModelVisibleForWorkspace,
  invalidateWorkspaceModels,
  filterToAllowlist,
  modelsOutsidePlatform,
  __clearWorkspaceModelsCache,
} = await import('../workspace-models.service')

const PLATFORM = {
  catalogModels: [{ id: 'claude-opus-4-7' }, { id: 'gpt-5.4' }, { id: 'claude-haiku-4-5' }],
  openrouterModels: [{ id: 'openrouter:meta/llama-3' }],
}

const WS = 'ws-1'

beforeEach(() => {
  ROWS = []
  findManyCalls = 0
  deleteManyArgs.length = 0
  createManyArgs.length = 0
  __clearWorkspaceModelsCache()
})

describe('getAllowedModelIds', () => {
  test('returns null (inherit) when the workspace has no rows', async () => {
    expect(await getAllowedModelIds(WS)).toBeNull()
  })

  test('returns the explicit allowlist as a Set when rows exist', async () => {
    ROWS = [{ modelId: 'a' }, { modelId: 'b' }]
    const allowed = await getAllowedModelIds(WS)
    expect(allowed).not.toBeNull()
    expect(Array.from(allowed!).sort()).toEqual(['a', 'b'])
  })

  test('caches: a second read within TTL does not re-query', async () => {
    ROWS = [{ modelId: 'a' }]
    await getAllowedModelIds(WS)
    await getAllowedModelIds(WS)
    expect(findManyCalls).toBe(1)
  })

  test('invalidation forces a fresh read', async () => {
    ROWS = [{ modelId: 'a' }]
    await getAllowedModelIds(WS)
    invalidateWorkspaceModels(WS)
    await getAllowedModelIds(WS)
    expect(findManyCalls).toBe(2)
  })
})

describe('setAllowedModelIds', () => {
  test('writes deleteMany + createMany and the next read reflects it', async () => {
    await setAllowedModelIds(WS, ['a', 'b', 'a'], 'user-1') // dedupes 'a'
    expect(deleteManyArgs.length).toBe(1)
    expect(createManyArgs.length).toBe(1)
    expect(createManyArgs[0].data.map((d: any) => d.modelId).sort()).toEqual(['a', 'b'])
    expect(createManyArgs[0].data.every((d: any) => d.createdBy === 'user-1')).toBe(true)

    const allowed = await getAllowedModelIds(WS)
    expect(Array.from(allowed!).sort()).toEqual(['a', 'b'])
  })

  test('empty list clears all rows (reverts to inherit) without createMany', async () => {
    ROWS = [{ modelId: 'a' }]
    await setAllowedModelIds(WS, [], 'user-1')
    expect(deleteManyArgs.length).toBe(1)
    expect(createManyArgs.length).toBe(0)
    expect(await getAllowedModelIds(WS)).toBeNull()
  })
})

describe('isModelVisibleForWorkspace', () => {
  test('inherit (no rows) allows any model', async () => {
    expect(await isModelVisibleForWorkspace(WS, 'anything')).toBe(true)
  })

  test('restricted: allows listed ids, blocks unlisted ids', async () => {
    ROWS = [{ modelId: 'claude-opus-4-7' }]
    expect(await isModelVisibleForWorkspace(WS, 'claude-opus-4-7')).toBe(true)
    expect(await isModelVisibleForWorkspace(WS, 'gpt-5.4')).toBe(false)
  })

  test('the auto meta-model is always allowed even when restricted', async () => {
    ROWS = [{ modelId: 'claude-opus-4-7' }]
    expect(await isModelVisibleForWorkspace(WS, 'auto')).toBe(true)
  })

  test('resolves an alias to its canonical id before checking', async () => {
    ROWS = [{ modelId: 'claude-opus-4-7' }]
    // 'opus-alias' resolves to 'claude-opus-4-7' via the mocked registry.
    expect(await isModelVisibleForWorkspace(WS, 'opus-alias')).toBe(true)
  })
})

describe('filterToAllowlist', () => {
  test('inherit (null) returns the full platform set unchanged', () => {
    expect(filterToAllowlist(PLATFORM, null)).toBe(PLATFORM)
  })

  test('narrows catalog + openrouter models to the allowlist', () => {
    const allowed = new Set(['claude-opus-4-7', 'openrouter:meta/llama-3'])
    const out = filterToAllowlist(PLATFORM, allowed)
    expect(out.catalogModels.map((m) => m.id)).toEqual(['claude-opus-4-7'])
    expect(out.openrouterModels.map((m) => m.id)).toEqual(['openrouter:meta/llama-3'])
  })

  test('an empty allowlist hides everything', () => {
    const out = filterToAllowlist(PLATFORM, new Set())
    expect(out.catalogModels).toEqual([])
    expect(out.openrouterModels).toEqual([])
  })
})

describe('modelsOutsidePlatform (subset rule)', () => {
  test('returns ids that are not platform-visible', () => {
    const invalid = modelsOutsidePlatform(['claude-opus-4-7', 'made-up-model'], PLATFORM)
    expect(invalid).toEqual(['made-up-model'])
  })

  test('returns empty when every id is platform-visible (catalog + openrouter)', () => {
    expect(modelsOutsidePlatform(['gpt-5.4', 'openrouter:meta/llama-3'], PLATFORM)).toEqual([])
  })
})
