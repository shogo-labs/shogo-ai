// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for apps/api/src/lib/internal-proxy-config.ts — the boot helper
 * that self-provisions in-process AI proxy credentials so the API server can
 * reach its own AI proxy for server-initiated LLM surfaces (title generation,
 * in-app assistant, voice translator).
 *
 *   bun test apps/api/src/lib/__tests__/internal-proxy-config.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  ensureInternalProxyConfig,
  __stopInternalProxyRefreshForTests,
} from '../internal-proxy-config'
import { verifyProxyToken } from '../ai-proxy-token'

const SAVED = {
  AI_PROXY_URL: process.env.AI_PROXY_URL,
  AI_PROXY_TOKEN: process.env.AI_PROXY_TOKEN,
  AI_PROXY_SECRET: process.env.AI_PROXY_SECRET,
  SYSTEM_NAMESPACE: process.env.SYSTEM_NAMESPACE,
  API_HOST: process.env.API_HOST,
  API_PORT: process.env.API_PORT,
  NODE_ENV: process.env.NODE_ENV,
}

beforeEach(() => {
  delete process.env.AI_PROXY_URL
  delete process.env.AI_PROXY_TOKEN
  delete process.env.SYSTEM_NAMESPACE
  delete process.env.API_HOST
  delete process.env.API_PORT
  // A signing secret so generateProxyToken can mint without the prod FATAL.
  process.env.AI_PROXY_SECRET = 'test-internal-proxy-secret'
  process.env.NODE_ENV = 'test'
})

afterEach(() => {
  __stopInternalProxyRefreshForTests()
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete (process.env as any)[k]
    else (process.env as any)[k] = v
  }
})

describe('ensureInternalProxyConfig — sets vars when unset', () => {
  test('sets AI_PROXY_URL to the localhost loopback by default and mints a proxy-jwt token', async () => {
    await ensureInternalProxyConfig()

    expect(process.env.AI_PROXY_URL).toBe('http://localhost:8002/api/ai/v1')
    expect(process.env.AI_PROXY_TOKEN).toBeDefined()
    // A 3-part JWT — proxy auth resolves these as `authKind: 'proxy-jwt'`,
    // the only kind trusted to mark title usage non-billable.
    expect(process.env.AI_PROXY_TOKEN!.split('.')).toHaveLength(3)

    const payload = await verifyProxyToken(process.env.AI_PROXY_TOKEN!)
    expect(payload).not.toBeNull()
    expect(payload!.type).toBe('ai-proxy')
  })

  test('honors API_HOST + API_PORT for the loopback base URL', async () => {
    process.env.API_HOST = '10.0.2.2'
    process.env.API_PORT = '9100'

    await ensureInternalProxyConfig()

    expect(process.env.AI_PROXY_URL).toBe('http://10.0.2.2:9100/api/ai/v1')
  })

  test('uses the in-cluster Knative DNS when SYSTEM_NAMESPACE is set', async () => {
    process.env.SYSTEM_NAMESPACE = 'shogo-prod'

    await ensureInternalProxyConfig()

    expect(process.env.AI_PROXY_URL).toBe(
      'http://api.shogo-prod.svc.cluster.local/api/ai/v1',
    )
  })
})

describe('ensureInternalProxyConfig — preserves pre-set values', () => {
  test('leaves an externally-configured AI_PROXY_URL / AI_PROXY_TOKEN untouched', async () => {
    process.env.AI_PROXY_URL = 'https://external-proxy.example/ai/v1'
    process.env.AI_PROXY_TOKEN = 'externally-managed-token'

    await ensureInternalProxyConfig()

    expect(process.env.AI_PROXY_URL).toBe('https://external-proxy.example/ai/v1')
    expect(process.env.AI_PROXY_TOKEN).toBe('externally-managed-token')
  })

  test('fills only the missing var (URL set, token unset)', async () => {
    process.env.AI_PROXY_URL = 'https://external-proxy.example/ai/v1'

    await ensureInternalProxyConfig()

    expect(process.env.AI_PROXY_URL).toBe('https://external-proxy.example/ai/v1')
    expect(process.env.AI_PROXY_TOKEN).toBeDefined()
    expect(process.env.AI_PROXY_TOKEN!.split('.')).toHaveLength(3)
  })
})
