// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/stamp-model-provider.ts — the helper that
 * resolves a (possibly UUID-addressed) model's native provider from the DB
 * registry and stamps it onto the chat body. This is the logic shared by the
 * /chat routes and the agent-proxy chat path so UUID models route natively
 * instead of being misclassified as `custom` by the runtime.
 *
 *   bun test apps/api/src/lib/__tests__/stamp-model-provider.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

// Mutable mock registry, keyed by canonical id (UUIDs pass through resolveModelId).
let ENTRIES: Record<string, { provider?: string }> = {}

mock.module('../../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) => ENTRIES[id],
}))

const { stampModelProvider } = await import('../stamp-model-provider')

const OPUS_UUID = '11111111-2222-3333-4444-555555555555'
const GPT_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

beforeEach(() => {
  ENTRIES = {
    [OPUS_UUID]: { provider: 'anthropic' },
    [GPT_UUID]: { provider: 'openai' },
  }
})

describe('stampModelProvider', () => {
  test('stamps the native provider for a UUID-addressed Anthropic model', () => {
    const body: any = { agentMode: OPUS_UUID }
    stampModelProvider(body)
    expect(body.modelProvider).toBe('anthropic')
  })

  test('stamps the native provider for a UUID-addressed OpenAI model', () => {
    const body: any = { agentMode: GPT_UUID }
    stampModelProvider(body)
    expect(body.modelProvider).toBe('openai')
  })

  test('clears a stale modelProvider when the id is unknown to the registry', () => {
    const body: any = { agentMode: 'unknown-uuid', modelProvider: 'anthropic' }
    stampModelProvider(body)
    expect('modelProvider' in body).toBe(false)
  })

  test('no-op when agentMode is absent', () => {
    const body: any = { modelProvider: 'anthropic' }
    stampModelProvider(body)
    expect(body.modelProvider).toBe('anthropic')
  })

  test('no-op when agentMode is not a string', () => {
    const body: any = { agentMode: 123 }
    stampModelProvider(body)
    expect('modelProvider' in body).toBe(false)
  })
})
