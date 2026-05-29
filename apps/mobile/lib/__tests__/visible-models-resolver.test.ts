// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the client-side model metadata resolver chain in
 * apps/mobile/lib/visible-models.ts. With no server metadata fetched (the
 * default in a unit test), the resolvers fall back to the bundled
 * MODEL_CATALOG and then to id-based heuristics — proving DB-only models that
 * a build doesn't bundle still resolve to something sensible.
 *
 * Run: bun test apps/mobile/lib/__tests__/visible-models-resolver.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'

// Avoid pulling the RN/HTTP client transitively via './api'.
mock.module('../api', () => ({ createHttpClient: () => ({}) }))

const { resolveTier, resolveFamily, resolveShortName, resolveDisplayName } = await import('../visible-models')

describe('visible-models resolver chain (no server metadata)', () => {
  test('resolveTier: bundled catalog wins', () => {
    expect(resolveTier('claude-opus-4-7')).toBe('premium')
    expect(resolveTier('claude-sonnet-4-6')).toBe('standard')
  })

  test('resolveTier: AUTO is economy', () => {
    expect(resolveTier('auto')).toBe('economy')
  })

  test('resolveTier: unknown id falls back to heuristics', () => {
    expect(resolveTier('some-new-opus-model')).toBe('premium')
    expect(resolveTier('whizbang-nano-1')).toBe('economy')
    expect(resolveTier('mimo-v2.5')).toBe('standard')
  })

  test('resolveFamily: bundled then heuristic', () => {
    expect(resolveFamily('claude-opus-4-7')).toBe('opus')
    expect(resolveFamily('mystery-gpt-9')).toBe('gpt')
    expect(resolveFamily('mimo-v2.5')).toBe('other')
  })

  test('resolveShortName: AUTO + bundled + unknown', () => {
    expect(resolveShortName('auto')).toBe('Auto')
    expect(resolveShortName('claude-opus-4-7')).toBe('Opus 4.7')
    expect(resolveShortName('mimo-v2.5')).toBe('mimo-v2.5')
  })

  test('resolveDisplayName: bundled then id', () => {
    expect(resolveDisplayName('claude-opus-4-7')).toBe('Claude Opus 4.7')
    expect(resolveDisplayName('mimo-v2.5')).toBe('mimo-v2.5')
  })
})
