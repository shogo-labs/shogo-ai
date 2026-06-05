// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-Anthropic routing via a provider hint.
 *
 * Opus 4.8 is a DB-defined model addressed by an opaque UUID. With only the
 * UUID, `inferProviderFromModel` can't recognize it and falls back to
 * `'custom'`, which routes the turn through the OpenAI-compat → Anthropic
 * *conversion* path (lossy: thinking can't be enabled there). The API server
 * now resolves the model's `provider` from its registry and stamps it on the
 * forwarded request alongside the override; the gateway honors it so the turn
 * routes through the *native* Anthropic API shape instead.
 *
 * The gateway's decision is a single inline expression in
 * `processChatMessageStream` (see `gateway.ts`, the non-auto branch):
 *
 *   provider = session.modelProvider ?? inferProviderFromModel(alias, configProvider)
 *
 * Running the full gateway turn requires a live LLM + stream, so this test
 * exercises the same decision with the *real* `inferProviderFromModel` and the
 * *real* pi-adapter `resolveModel`, then asserts the concrete routing
 * consequence (which API shape pi-ai will speak). The `resolveProvider` mirror
 * below must be kept in lockstep with the gateway expression.
 *
 *   bun test --conditions=development \
 *     packages/agent-runtime/src/__tests__/gateway-provider-hint.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { inferProviderFromModel } from '@shogo/model-catalog'
// Same module specifier the gateway imports its resolver from.
import { resolveModel } from '../pi-adapter'
import { SessionManager } from '../session-manager'

/** An opaque DB model id, as sent for Opus 4.8 (resolved to a provider by the
 *  API server before the runtime sees it). */
const OPUS_UUID = '11111111-1111-4111-8111-111111111111'

/**
 * Mirror of the gateway's non-auto provider decision. Keep in lockstep with
 * `processChatMessageStream` in `gateway.ts`.
 */
function resolveProvider(modelAlias: string, hint: string | undefined, configProvider = 'anthropic'): string {
  return hint ?? inferProviderFromModel(modelAlias, configProvider)
}

describe('gateway provider-hint routing', () => {
  test('a bare UUID infers as `custom` — the lossy conversion path (why the hint exists)', () => {
    expect(inferProviderFromModel(OPUS_UUID, 'anthropic')).toBe('custom')
  })

  test('hint routes a UUID model natively (anthropic-messages), no hint falls back to conversion', () => {
    // With the client's `anthropic` hint → native Anthropic Messages API.
    const withHint = resolveProvider(OPUS_UUID, 'anthropic')
    expect(withHint).toBe('anthropic')
    expect(resolveModel(withHint, OPUS_UUID).api).toBe('anthropic-messages')

    // Without the hint → inferred `custom` → OpenAI chat-completions shape
    // (the conversion path the proxy translates to Anthropic).
    const noHint = resolveProvider(OPUS_UUID, undefined)
    expect(noHint).toBe('custom')
    expect(resolveModel(noHint, OPUS_UUID).api).toBe('openai-completions')
  })

  test('the hint is a no-op for ids the catalog already classifies (no regression)', () => {
    // For every catalog-known id, the client hint equals inference, so honoring
    // it changes nothing. Native Anthropic models, OpenAI models, and unknown
    // OpenAI-compatible DB models all resolve identically with or without it.
    expect(resolveProvider('claude-sonnet-4-6', 'anthropic')).toBe(
      inferProviderFromModel('claude-sonnet-4-6', 'anthropic'),
    )
    expect(resolveProvider('gpt-5.1', 'openai')).toBe(
      inferProviderFromModel('gpt-5.1', 'anthropic'),
    )
    // A `custom` hint and the `custom` fallback agree for a bare UUID.
    expect(resolveProvider(OPUS_UUID, 'custom')).toBe(
      inferProviderFromModel(OPUS_UUID, 'anthropic'),
    )
  })

  test('the provider hint survives a session serialize → restore round-trip', async () => {
    const stored = new Map<string, any>()
    const persistence = {
      save: async (id: string, s: any) => { stored.set(id, structuredClone(s)) },
      load: async (id: string) => stored.get(id) ?? null,
      delete: async (id: string) => { stored.delete(id) },
      loadAll: async () => [...stored.values()],
    }

    const cfg = {
      sessionTtlSeconds: 3600,
      maxMessages: 100,
      estimatedTokensPerMessage: 150,
      maxEstimatedTokens: 200_000,
      keepRecentMessages: 10,
      pruneIntervalSeconds: 999,
    }

    const sm = new SessionManager(cfg)
    sm.setPersistence(persistence)
    const session = sm.getOrCreate('chat-1')
    session.modelOverride = OPUS_UUID
    session.modelProvider = 'anthropic'
    // Touch a message so the manager persists the session.
    sm.addMessages('chat-1', { role: 'user', content: 'hi', timestamp: Date.now() })

    // Fresh manager backed by the same store re-hydrates the persisted hint.
    const sm2 = new SessionManager(cfg)
    sm2.setPersistence(persistence)
    await sm2.restoreSessions()
    const restored = sm2.getOrCreate('chat-1')
    expect(restored.modelOverride).toBe(OPUS_UUID)
    expect(restored.modelProvider).toBe('anthropic')
  })
})
