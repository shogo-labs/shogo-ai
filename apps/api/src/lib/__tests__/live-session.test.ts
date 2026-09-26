// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `validateLiveSessionStart` — in particular the
 * cloud-forwarding scenario where a device (desktop) has no locally-seeded
 * `ModelDefinition` rows and resolves `gpt-live-1` via the static catalog
 * (id === the code-shipped slug `'gpt-live-1'`), while the workspace's
 * visible-models list is mirrored from a connected Shogo Cloud whose
 * `/api/platform/visible-models` payload keys the very same model under an
 * opaque DB id (a UUID). Prior to the `visibleEntry` kind+provider fallback,
 * this id mismatch made every Live session request 403 with
 * `model_not_visible` even though the workspace was fully entitled.
 *
 *   bun test apps/api/src/lib/__tests__/live-session.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { ProxyTokenPayload } from '../ai-proxy-token'

// ─── Mutable mock data ──────────────────────────────────────────────────────

const STATIC_LIVE_ENTRY = {
  id: 'gpt-live-1',
  provider: 'openai',
  apiModel: 'gpt-live-1',
  displayName: 'GPT-Live 1',
  shortDisplayName: 'GPT-Live 1',
  tier: 'standard',
  family: 'gpt',
  generation: 'current',
  kind: 'live',
  billingModel: 'gpt-live-1',
  maxOutputTokens: 0,
}

const STATIC_CHAT_ENTRY = {
  id: 'gpt-6-astra',
  provider: 'openai',
  apiModel: 'gpt-6-astra',
  displayName: 'GPT-6 Astra',
  shortDisplayName: 'GPT-6 Astra',
  tier: 'premium',
  family: 'gpt',
  generation: 'current',
  billingModel: 'opus',
  maxOutputTokens: 128_000,
}

let MERGED_ENTRIES: Record<string, any> = {}
let VISIBLE_CATALOG_MODELS: Array<{ id: string; provider?: string; kind?: string }> = []
let PROVIDER_CONFIGURED = true
let WORKSPACE_ALLOWED_IDS: Set<string> | null = null

mock.module('../../services/model-registry.service', () => ({
  getMergedModelEntrySync: (id: string) => MERGED_ENTRIES[id],
}))

mock.module('../../services/visible-models.service', () => ({
  isModelProviderConfigured: () => PROVIDER_CONFIGURED,
  resolveVisibleModelsForWorkspace: async () => ({
    catalogModels: VISIBLE_CATALOG_MODELS,
    openrouterModels: [],
  }),
}))

mock.module('../../services/workspace-models.service', () => ({
  isModelVisibleForWorkspace: async (_workspaceId: string, modelId: string) =>
    WORKSPACE_ALLOWED_IDS === null || WORKSPACE_ALLOWED_IDS.has(modelId),
}))

let AUTO_BACKEND: { id: string; fromCloud: boolean } | null = null

mock.module('../runtime/agent-model-defaults', () => ({
  resolveAutoLiveBackendModel: async () => AUTO_BACKEND,
}))

const { validateLiveSessionStart } = await import('../live-session')

const TOKEN: ProxyTokenPayload = {
  projectId: 'proj_1',
  workspaceId: 'ws_1',
  type: 'ai-proxy',
  iat: 0,
  exp: 0,
}

describe('validateLiveSessionStart', () => {
  beforeEach(() => {
    MERGED_ENTRIES = { 'gpt-live-1': STATIC_LIVE_ENTRY, 'gpt-6-astra': STATIC_CHAT_ENTRY }
    VISIBLE_CATALOG_MODELS = []
    PROVIDER_CONFIGURED = true
    WORKSPACE_ALLOWED_IDS = null
    AUTO_BACKEND = null
    delete process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_API_KEY
  })

  test('auto backend resolves to the Auto tier OpenAI model', async () => {
    VISIBLE_CATALOG_MODELS = [
      { id: 'gpt-live-1', provider: 'openai', kind: 'live' },
      { id: 'gpt-6-astra', provider: 'openai' },
    ]
    AUTO_BACKEND = { id: 'gpt-6-astra', fromCloud: false }
    const result = await validateLiveSessionStart(TOKEN, {
      model: 'gpt-live-1',
      delegation: { type: 'responses', responses: { model: 'auto' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.backendModel).toBe('gpt-6-astra')
      expect(result.upstreamBackendModel).toBe('gpt-6-astra')
    }
  })

  test('auto backend fails when no Auto tier is an OpenAI model', async () => {
    VISIBLE_CATALOG_MODELS = [{ id: 'gpt-live-1', provider: 'openai', kind: 'live' }]
    const result = await validateLiveSessionStart(TOKEN, {
      model: 'gpt-live-1',
      delegation: { type: 'responses', responses: { model: 'auto' } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('backend_model_not_supported')
  })

  test('cloud-sourced auto backend skips the local id-match visibility check when forwarding', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_API_KEY = 'shogo_sk_test'
    // Cloud-mirrored visible entries are keyed by opaque DB ids.
    VISIBLE_CATALOG_MODELS = [
      { id: 'b1918b49-c3c6-49c8-8e33-aa7defc8b5f9', provider: 'openai', kind: 'live' },
      { id: '5a0f7c1e-0000-4000-8000-000000000000', provider: 'openai' },
    ]
    AUTO_BACKEND = { id: 'gpt-6-astra', fromCloud: true }
    const result = await validateLiveSessionStart(
      TOKEN,
      {
        model: 'gpt-live-1',
        delegation: { type: 'responses', responses: { model: 'auto' } },
      },
      { allowCloudForwarding: true },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.backendModel).toBe('gpt-6-astra')
  })

  test('passes when the cloud-mirrored visible entry shares the id (normal case)', async () => {
    VISIBLE_CATALOG_MODELS = [{ id: 'gpt-live-1', provider: 'openai', kind: 'live' }]
    const result = await validateLiveSessionStart(TOKEN, { model: 'gpt-live-1' })
    expect(result.ok).toBe(true)
  })

  test('passes via kind+provider fallback when the visible entry is keyed by a cloud UUID (desktop, no local DB rows, cloud-forwarding)', async () => {
    // Mirrors a cloud-connected desktop with an empty local `model_definitions`
    // table: the static catalog resolves `gpt-live-1` under its slug id, but
    // the cloud's `/api/platform/visible-models` payload — which doesn't carry
    // `apiModel`/aliases — reports the same model under its opaque DB id.
    VISIBLE_CATALOG_MODELS = [
      { id: 'b1918b49-c3c6-49c8-8e33-aa7defc8b5f9', provider: 'openai', kind: 'live' },
    ]
    const result = await validateLiveSessionStart(TOKEN, { model: 'gpt-live-1' })
    expect(result.ok).toBe(true)
  })

  test('fails with model_not_visible when no live model is in the visible set at all', async () => {
    VISIBLE_CATALOG_MODELS = [{ id: 'gpt-6-astra', provider: 'openai' }]
    const result = await validateLiveSessionStart(TOKEN, { model: 'gpt-live-1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.code).toBe('model_not_visible')
    }
  })

  test('kind+provider fallback does not leak visibility across providers', async () => {
    VISIBLE_CATALOG_MODELS = [{ id: 'some-other-id', provider: 'anthropic', kind: 'live' }]
    const result = await validateLiveSessionStart(TOKEN, { model: 'gpt-live-1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('model_not_visible')
  })

  test('chat (non-live) models still require an exact id match — no kind+provider fallback', async () => {
    // A chat model round-trips its id unchanged from the picker, so a
    // mismatched id must still fail closed, even though the live model
    // itself is visible.
    VISIBLE_CATALOG_MODELS = [
      { id: 'gpt-live-1', provider: 'openai', kind: 'live' },
      { id: 'different-chat-model-id', provider: 'openai', kind: undefined },
    ]
    const result = await validateLiveSessionStart(TOKEN, {
      model: 'gpt-live-1',
      delegation: { type: 'responses', responses: { model: 'gpt-6-astra' } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('backend_model_not_visible')
  })

  test('workspace-level allowlist can still hide the live model even when platform-visible', async () => {
    VISIBLE_CATALOG_MODELS = [{ id: 'gpt-live-1', provider: 'openai', kind: 'live' }]
    WORKSPACE_ALLOWED_IDS = new Set(['gpt-6-astra']) // explicit allowlist that excludes the live model
    const result = await validateLiveSessionStart(TOKEN, { model: 'gpt-live-1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('model_not_visible')
  })

  test('returns model_not_found for an unknown model id', async () => {
    const result = await validateLiveSessionStart(TOKEN, { model: 'not-a-real-model' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.code).toBe('model_not_found')
    }
  })
})
