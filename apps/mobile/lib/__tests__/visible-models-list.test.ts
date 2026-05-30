// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for buildModelList — the flat, admin-ordered picker list used by the
 * redesigned chat model picker. The serving API sorts catalogModels by each
 * model's admin sortOrder; buildModelList must preserve that order verbatim
 * (no provider regrouping) and append OpenRouter extras last, carrying the
 * picker metadata through.
 *
 * Run: bun test apps/mobile/lib/__tests__/visible-models-list.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'

mock.module('../api', () => ({ createHttpClient: () => ({}) }))

const { buildModelList } = await import('../visible-models')

describe('buildModelList (flat, admin-ordered)', () => {
  test('preserves server catalogModels order and appends OpenRouter last', () => {
    const list = buildModelList({
      catalogIds: null,
      // Intentionally NOT in provider-grouped order — server already sorted
      // by sortOrder, so the flat list must mirror this exactly.
      catalogModels: [
        { id: 'claude-opus-4-8', provider: 'anthropic', displayName: 'Claude Opus 4.8', shortDisplayName: 'Opus 4.8', tier: 'premium' },
        { id: 'gpt-5.5', provider: 'openai', displayName: 'GPT-5.5', shortDisplayName: 'GPT-5.5', tier: 'standard' },
        { id: 'claude-sonnet-4-6', provider: 'anthropic', displayName: 'Claude Sonnet 4.6', shortDisplayName: 'Sonnet 4.6', tier: 'standard', description: 'Smart', contextWindow: 200000, reasoningEffort: 'medium' },
      ],
      openrouterModels: [
        { id: 'openrouter:meta/llama', displayName: 'Llama', tier: 'standard' },
      ],
    } as any)

    expect(list.map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'gpt-5.5',
      'claude-sonnet-4-6',
      'openrouter:meta/llama',
    ])
  })

  test('carries picker metadata through', () => {
    const list = buildModelList({
      catalogIds: null,
      catalogModels: [
        { id: 'claude-sonnet-4-6', provider: 'anthropic', displayName: 'Claude Sonnet 4.6', tier: 'standard', description: 'Smart', contextWindow: 200000, reasoningEffort: 'medium' },
      ],
      openrouterModels: [],
    } as any)

    const sonnet = list.find((m) => m.id === 'claude-sonnet-4-6')!
    expect(sonnet.description).toBe('Smart')
    expect(sonnet.contextWindow).toBe(200000)
    expect(sonnet.reasoningEffort).toBe('medium')
  })

  test('no catalogModels → empty list (no bundled-catalog fallback)', () => {
    // The picker is purely server-driven: when the snapshot carries no
    // catalogModels (loading / error / unseeded server) the list is empty
    // rather than flickering in the code-shipped catalog.
    const list = buildModelList({ catalogIds: null, openrouterModels: [] } as any)
    expect(list).toEqual([])
  })

  test('null snapshot → empty list', () => {
    expect(buildModelList(null)).toEqual([])
  })
})
