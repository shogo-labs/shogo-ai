// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `SHOGO_STANDALONE=1` — the partner contract (SHO-418).
 *
 * The whole mode hangs off one thing: `resolveApiUrl()` returns `null`, and
 * every API-bound caller already treats `null` as "this feature is off". These
 * tests pin that, plus the boot-time validation that turns a misconfigured pod
 * into one clear error instead of a stream of ENOTFOUND.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetStandaloneForTests,
  assertStandaloneEnv,
  isStandalone,
  isTruthyEnv,
  parseAgentModelPin,
  pinnedAgentModel,
  resolveApiUrl,
  StandaloneConfigError,
} from '../standalone'

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env = { ...originalEnv }
  delete process.env.SHOGO_STANDALONE
  delete process.env.SHOGO_API_URL
  delete process.env.API_URL
  delete process.env.AI_PROXY_URL
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.SYSTEM_NAMESPACE
  delete process.env.WARM_POOL_MODE
  delete process.env.AGENT_MODEL
  delete process.env.RUNTIME_AUTH_SECRET
  delete process.env.OPENAI_BASE_URL
  delete process.env.LOCAL_LLM_BASE_URL
  delete process.env.OPENAI_API_KEY
  __resetStandaloneForTests()
})

afterEach(() => {
  process.env = { ...originalEnv }
  __resetStandaloneForTests()
})

describe('isStandalone', () => {
  test.each(['1', 'true', 'TRUE', 'yes', 'on', ' 1 '])('%p turns the mode on', (value) => {
    process.env.SHOGO_STANDALONE = value
    __resetStandaloneForTests()
    expect(isStandalone()).toBe(true)
  })

  test.each(['', '0', 'false', 'no', 'off', 'maybe'])('%p leaves it off', (value) => {
    process.env.SHOGO_STANDALONE = value
    __resetStandaloneForTests()
    expect(isStandalone()).toBe(false)
  })

  test('is read once, so a mid-flight change cannot half-apply', () => {
    process.env.SHOGO_STANDALONE = '1'
    __resetStandaloneForTests()
    expect(isStandalone()).toBe(true)
    process.env.SHOGO_STANDALONE = '0'
    expect(isStandalone()).toBe(true)
  })

  test('isTruthyEnv treats a missing value as false', () => {
    expect(isTruthyEnv(undefined)).toBe(false)
    expect(isTruthyEnv(null)).toBe(false)
    expect(isTruthyEnv('on')).toBe(true)
  })
})

describe('resolveApiUrl — the one resolver', () => {
  test('returns null in standalone mode even when an API URL is configured', () => {
    process.env.SHOGO_STANDALONE = '1'
    process.env.SHOGO_API_URL = 'https://api.shogo.example'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    __resetStandaloneForTests()
    expect(resolveApiUrl()).toBeNull()
  })

  test('off the flag, SHOGO_API_URL wins', () => {
    process.env.SHOGO_API_URL = 'https://api.shogo.example'
    process.env.API_URL = 'https://ignored.example'
    expect(resolveApiUrl()).toBe('https://api.shogo.example')
  })

  test('off the flag, API_URL is the second rung', () => {
    process.env.API_URL = 'https://api-url.example'
    expect(resolveApiUrl()).toBe('https://api-url.example')
  })

  test('off the flag, the AI_PROXY_URL host is the third rung', () => {
    process.env.AI_PROXY_URL = 'http://proxy.internal:8080/api/ai/v1'
    expect(resolveApiUrl()).toBe('http://proxy.internal:8080')
  })

  test('off the flag, an unparseable AI_PROXY_URL falls through', () => {
    process.env.AI_PROXY_URL = 'not a valid url'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.SYSTEM_NAMESPACE = 'test-system'
    expect(resolveApiUrl()).toBe('http://api.test-system.svc.cluster.local')
  })

  test('the ClusterIP fallback needs Kubernetes: outside a cluster it is null', () => {
    // The name cannot resolve off-cluster, so handing it to callers only bought
    // an ENOTFOUND. This is the behaviour the internal-api copy already had.
    expect(resolveApiUrl()).toBeNull()
  })

  test('inside Kubernetes the ClusterIP fallback still works', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(resolveApiUrl()).toBe('http://api.shogo-system.svc.cluster.local')
    process.env.SYSTEM_NAMESPACE = 'shogo-prod'
    expect(resolveApiUrl()).toBe('http://api.shogo-prod.svc.cluster.local')
  })
})

describe('parseAgentModelPin', () => {
  test('splits on the first colon only, so a colon in the id survives', () => {
    expect(parseAgentModelPin('local:qwen2.5:3b')).toEqual({ provider: 'local', id: 'qwen2.5:3b' })
  })

  test('handles an OpenRouter id', () => {
    expect(parseAgentModelPin('openrouter:meta-llama/llama-3.1-405b-instruct')).toEqual({
      provider: 'openrouter',
      id: 'meta-llama/llama-3.1-405b-instruct',
    })
  })

  test('a bare model id is taken as the local provider', () => {
    expect(parseAgentModelPin('qwen3-coder')).toEqual({ provider: 'local', id: 'qwen3-coder' })
  })

  test.each([undefined, null, '', '   ', ':model', 'provider:'])('%p is not a pin', (raw) => {
    expect(parseAgentModelPin(raw as string | undefined)).toBeNull()
  })

  test('pinnedAgentModel reads AGENT_MODEL', () => {
    process.env.AGENT_MODEL = 'anthropic:claude-sonnet-4-6'
    expect(pinnedAgentModel()).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' })
  })
})

describe('assertStandaloneEnv', () => {
  test('is a no-op off the flag', () => {
    expect(() => assertStandaloneEnv()).not.toThrow()
  })

  test('names every missing variable in one message', () => {
    process.env.SHOGO_STANDALONE = '1'
    __resetStandaloneForTests()
    let error: unknown
    try {
      assertStandaloneEnv()
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(StandaloneConfigError)
    const missing = (error as StandaloneConfigError).missing
    expect(missing).toContain('RUNTIME_AUTH_SECRET')
    expect(missing).toContain('AGENT_MODEL')
    expect((error as Error).message).toContain('RUNTIME_AUTH_SECRET')
    expect((error as Error).message).toContain('AGENT_MODEL')
  })

  test('a local pin needs a base URL, and either name satisfies it', () => {
    process.env.SHOGO_STANDALONE = '1'
    process.env.RUNTIME_AUTH_SECRET = 'secret'
    process.env.AGENT_MODEL = 'local:qwen3-coder'
    __resetStandaloneForTests()
    expect(() => assertStandaloneEnv()).toThrow(/OPENAI_BASE_URL or LOCAL_LLM_BASE_URL/)

    process.env.LOCAL_LLM_BASE_URL = 'http://ollama:11434/v1'
    expect(() => assertStandaloneEnv()).not.toThrow()
  })

  test('an openai pin needs both the base URL and the key', () => {
    process.env.SHOGO_STANDALONE = '1'
    process.env.RUNTIME_AUTH_SECRET = 'secret'
    process.env.AGENT_MODEL = 'openai:gpt-5.4-mini'
    __resetStandaloneForTests()
    expect(() => assertStandaloneEnv()).toThrow(/OPENAI_BASE_URL/)
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    expect(() => assertStandaloneEnv()).toThrow(/OPENAI_API_KEY/)
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(() => assertStandaloneEnv()).not.toThrow()
  })

  test('WARM_POOL_MODE=true is refused', () => {
    process.env.SHOGO_STANDALONE = '1'
    process.env.RUNTIME_AUTH_SECRET = 'secret'
    process.env.AGENT_MODEL = 'local:qwen3-coder'
    process.env.OPENAI_BASE_URL = 'http://ollama:11434/v1'
    process.env.WARM_POOL_MODE = 'true'
    __resetStandaloneForTests()
    expect(() => assertStandaloneEnv()).toThrow(/WARM_POOL_MODE/)
  })
})
