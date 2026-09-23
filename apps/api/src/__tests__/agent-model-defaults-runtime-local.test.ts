// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression guard for the local-mode agent model resolver.
 *
 * `agent-model-defaults-runtime.ts` is the slim shim the DESKTOP bundle uses
 * (the full `agent-model-defaults.ts` is dead-code-eliminated by the
 * `SHOGO_LOCAL_MODE="true"` define so Stripe/billing stays out of the bundle).
 *
 * The shim used to load its cloud resolver only when
 * `SHOGO_LOCAL_MODE !== 'true'`, while the thing that actually reads
 * cloud-configured models — `fetchCloudAgentModelDefaults()` — bails out with
 * `if (!isLocalMode()) return null`. The two conditions were mutually
 * exclusive, so desktop pinned every Auto tier to the hardcoded
 * `claude-haiku-4-5-20251001` and silently dropped the user's configured
 * provider. See issue #970.
 *
 * Deliberately NO `mock.module()` here: mocking `../lib/federated-upstream`
 * leaks into sibling suites in the same bun process and breaks
 * `federated-agent-model-defaults.test.ts` / `agent-model-env-cloud.test.ts`.
 * We stub `globalThis.fetch` and exercise the real module instead.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
const previousApiKey = process.env.SHOGO_API_KEY
const previousAiMode = process.env.AI_MODE
const previousBasic = process.env.AGENT_BASIC_MODEL
const previousLocalBase = process.env.LOCAL_LLM_BASE_URL
const previousLocalBasic = process.env.LOCAL_LLM_BASIC_MODEL

// Must be set before importing the shim: its cloud-resolver branch is
// evaluated at module top level.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.SHOGO_API_KEY = 'shogo_sk_test'
delete process.env.AI_MODE
delete process.env.AGENT_BASIC_MODEL
delete process.env.LOCAL_LLM_BASE_URL
delete process.env.LOCAL_LLM_BASIC_MODEL

const CUSTOM_TIER = { id: '38e6339d-9135-4aff-8641-eba3ae7bebe5', provider: 'custom' }
const CLOUD_BODY = {
  basic: 'mimo-v2.5',
  advanced: 'mimo-v2.5',
  defaultMode: 'auto',
  autoTiers: { economy: CUSTOM_TIER, standard: CUSTOM_TIER, premium: CUSTOM_TIER },
  hasAdvancedModelAccess: true,
}

const HARDCODED_FALLBACK = 'claude-haiku-4-5-20251001'

type FetchMode = 'ok' | 'throw' | 'http500' | 'malformed'
let fetchMode: FetchMode = 'ok'

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => {
  if (fetchMode === 'throw') throw new Error('cloud unreachable')
  if (fetchMode === 'http500') return new Response('nope', { status: 500 })
  const body = fetchMode === 'malformed'
    ? { ...CLOUD_BODY, autoTiers: { economy: {}, standard: {}, premium: {} } }
    : CLOUD_BODY
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as any

const { resolveAgentModelEnv } = await import('../lib/runtime/agent-model-defaults-runtime')
const { _resetAgentModelDefaultsCache } = await import('../lib/federated-upstream')

describe('local-mode agent model env (desktop shim)', () => {
  beforeEach(() => {
    fetchMode = 'ok'
    _resetAgentModelDefaultsCache()
    delete process.env.LOCAL_LLM_BASE_URL
    delete process.env.LOCAL_LLM_BASIC_MODEL
  })

  test('honours cloud-configured Auto tiers instead of the hardcoded fallback', async () => {
    const env = await resolveAgentModelEnv('local-workspace')

    expect(env.AGENT_BASIC_MODEL).toBe('mimo-v2.5')
    expect(env.AGENT_ADVANCED_MODEL).toBe('mimo-v2.5')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP)).toEqual(CLOUD_BODY.autoTiers)
  })

  test('preserves the provider field on every tier', async () => {
    const env = await resolveAgentModelEnv('local-workspace')
    const tiers = JSON.parse(env.AGENT_AUTO_TIER_MAP)

    for (const tier of ['economy', 'standard', 'premium'] as const) {
      expect(tiers[tier].provider).toBe('custom')
      expect(tiers[tier].id).not.toBe(HARDCODED_FALLBACK)
    }
  })

  test('does not collapse all three tiers onto one hardcoded id', async () => {
    const env = await resolveAgentModelEnv('local-workspace')
    expect(env.AGENT_AUTO_TIER_MAP).not.toContain(HARDCODED_FALLBACK)
  })

  test('an explicit local LLM still wins over cloud defaults', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434'
    process.env.LOCAL_LLM_BASIC_MODEL = 'qwen3:8b'

    const env = await resolveAgentModelEnv('local-workspace')
    const tiers = JSON.parse(env.AGENT_AUTO_TIER_MAP)

    expect(env.AGENT_BASIC_MODEL).toBe('qwen3:8b')
    expect(tiers.economy).toEqual({ id: 'qwen3:8b', provider: 'local' })
  })

  test('falls back to the static env when the cloud rejects the read', async () => {
    fetchMode = 'http500'
    const env = await resolveAgentModelEnv('local-workspace')
    expect(env.AGENT_BASIC_MODEL).toBe(HARDCODED_FALLBACK)
  })

  test('falls back instead of throwing when the cloud is unreachable', async () => {
    fetchMode = 'throw'
    const env = await resolveAgentModelEnv('local-workspace')
    expect(env.AGENT_BASIC_MODEL).toBe(HARDCODED_FALLBACK)
  })

  test('ignores a malformed cloud payload with missing tier ids', async () => {
    fetchMode = 'malformed'
    const env = await resolveAgentModelEnv('local-workspace')
    expect(env.AGENT_BASIC_MODEL).toBe(HARDCODED_FALLBACK)
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  _resetAgentModelDefaultsCache()
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('SHOGO_LOCAL_MODE', previousLocalMode)
  restore('SHOGO_API_KEY', previousApiKey)
  restore('AI_MODE', previousAiMode)
  restore('AGENT_BASIC_MODEL', previousBasic)
  restore('LOCAL_LLM_BASE_URL', previousLocalBase)
  restore('LOCAL_LLM_BASIC_MODEL', previousLocalBasic)
})
