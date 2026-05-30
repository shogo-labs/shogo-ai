// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the client-side model metadata resolver chain in
 * apps/mobile/lib/visible-models.ts. The resolvers are server-driven: with no
 * server metadata fetched (the default in a unit test) they fall back to
 * id-based heuristics for tier/family and to the raw id for display names.
 * There is intentionally NO bundled-MODEL_CATALOG fallback — the server is the
 * single source of truth.
 *
 * Run: bun test apps/mobile/lib/__tests__/visible-models-resolver.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'

// Avoid pulling the RN/HTTP client transitively via './api'.
mock.module('../api', () => ({ createHttpClient: () => ({}) }))

const { resolveTier, resolveFamily, resolveShortName, resolveDisplayName, resolveProvider } =
  await import('../visible-models')

describe('visible-models resolver chain (no server metadata)', () => {
  test('resolveTier: AUTO is economy', () => {
    expect(resolveTier('auto')).toBe('economy')
  })

  test('resolveTier: falls back to id heuristics', () => {
    expect(resolveTier('claude-opus-4-7')).toBe('premium')
    expect(resolveTier('claude-sonnet-4-6')).toBe('standard')
    expect(resolveTier('some-new-opus-model')).toBe('premium')
    expect(resolveTier('whizbang-nano-1')).toBe('economy')
    expect(resolveTier('mimo-v2.5')).toBe('standard')
  })

  test('resolveFamily: id heuristics', () => {
    expect(resolveFamily('claude-opus-4-7')).toBe('opus')
    expect(resolveFamily('claude-sonnet-4-6')).toBe('sonnet')
    expect(resolveFamily('mystery-gpt-9')).toBe('gpt')
    expect(resolveFamily('mimo-v2.5')).toBe('other')
  })

  test('resolveShortName: AUTO, else the raw id (no bundled catalog)', () => {
    expect(resolveShortName('auto')).toBe('Auto')
    expect(resolveShortName('claude-opus-4-7')).toBe('claude-opus-4-7')
    expect(resolveShortName('mimo-v2.5')).toBe('mimo-v2.5')
  })

  test('resolveDisplayName: AUTO, else the raw id (no bundled catalog)', () => {
    expect(resolveDisplayName('auto')).toBe('Auto')
    expect(resolveDisplayName('claude-opus-4-7')).toBe('claude-opus-4-7')
    expect(resolveDisplayName('mimo-v2.5')).toBe('mimo-v2.5')
  })

  test('resolveProvider: undefined without server metadata', () => {
    expect(resolveProvider('claude-opus-4-7')).toBeUndefined()
  })
})
