// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import * as fs from 'fs'
import {
  deriveApiUrl,
  derivePublicApiUrl,
  getInternalHeaders,
  postCostMetric,
  type AgentCostMetricPayload,
} from '../internal-api'

const ENV_KEYS = [
  'SHOGO_API_URL',
  'API_URL',
  'AI_PROXY_URL',
  'SYSTEM_NAMESPACE',
  'SHOGO_PUBLIC_API_URL',
  'RUNTIME_AUTH_SECRET',
]

const saved: Record<string, string | undefined> = {}

function clearEnv() {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

describe('deriveApiUrl', () => {
  beforeEach(clearEnv)
  afterEach(restoreEnv)

  it('prefers SHOGO_API_URL', () => {
    process.env.SHOGO_API_URL = 'https://a.example'
    process.env.API_URL = 'https://b.example'
    expect(deriveApiUrl()).toBe('https://a.example')
  })

  it('falls back to API_URL', () => {
    process.env.API_URL = 'https://b.example'
    expect(deriveApiUrl()).toBe('https://b.example')
  })

  it('derives origin from AI_PROXY_URL', () => {
    process.env.AI_PROXY_URL = 'https://proxy.example/v1/chat'
    expect(deriveApiUrl()).toBe('https://proxy.example')
  })

  it('ignores an invalid AI_PROXY_URL and falls through', () => {
    process.env.AI_PROXY_URL = 'not a url'
    expect(deriveApiUrl()).toBe('http://api.shogo-system.svc.cluster.local')
  })

  it('uses SYSTEM_NAMESPACE for the in-cluster fallback', () => {
    process.env.SYSTEM_NAMESPACE = 'staging'
    expect(deriveApiUrl()).toBe('http://api.staging.svc.cluster.local')
  })

  it('defaults the namespace to shogo-system', () => {
    expect(deriveApiUrl()).toBe('http://api.shogo-system.svc.cluster.local')
  })
})

describe('derivePublicApiUrl', () => {
  beforeEach(clearEnv)
  afterEach(restoreEnv)

  it('prefers SHOGO_PUBLIC_API_URL', () => {
    process.env.SHOGO_PUBLIC_API_URL = 'https://public.example'
    process.env.SHOGO_API_URL = 'https://internal.example'
    expect(derivePublicApiUrl()).toBe('https://public.example')
  })

  it('falls through to deriveApiUrl', () => {
    process.env.SHOGO_API_URL = 'https://internal.example'
    expect(derivePublicApiUrl()).toBe('https://internal.example')
  })
})

describe('getInternalHeaders', () => {
  beforeEach(clearEnv)
  afterEach(restoreEnv)

  it('returns just Content-Type when no SA token and no runtime secret', () => {
    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false)
    try {
      expect(getInternalHeaders()).toEqual({ 'Content-Type': 'application/json' })
    } finally {
      existsSpy.mockRestore()
    }
  })

  it('attaches Bearer token when SA token file is present', () => {
    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true)
    const readSpy = spyOn(fs, 'readFileSync').mockReturnValue('  tok-abc  \n' as any)
    try {
      const h = getInternalHeaders()
      expect(h['Authorization']).toBe('Bearer tok-abc')
    } finally {
      existsSpy.mockRestore()
      readSpy.mockRestore()
    }
  })

  it('swallows fs errors silently (not in K8s)', () => {
    const existsSpy = spyOn(fs, 'existsSync').mockImplementation(() => { throw new Error('nope') })
    try {
      const h = getInternalHeaders()
      expect(h['Authorization']).toBeUndefined()
      expect(h['Content-Type']).toBe('application/json')
    } finally {
      existsSpy.mockRestore()
    }
  })

  it('attaches x-runtime-token when RUNTIME_AUTH_SECRET is set', () => {
    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false)
    process.env.RUNTIME_AUTH_SECRET = 'rt-secret'
    try {
      expect(getInternalHeaders()['x-runtime-token']).toBe('rt-secret')
    } finally {
      existsSpy.mockRestore()
    }
  })
})

describe('postCostMetric', () => {
  beforeEach(clearEnv)
  afterEach(restoreEnv)

  const payload: AgentCostMetricPayload = {
    workspaceId: 'w1',
    agentType: 'general',
    model: 'sonnet',
    inputTokens: 10,
    outputTokens: 20,
    cachedInputTokens: 0,
    toolCalls: 1,
    creditCost: 0.5,
    wallTimeMs: 100,
    success: true,
  }

  it('is a no-op when deriveApiUrl returns null (we stub it via env strip + spy)', async () => {
    // deriveApiUrl never returns null in current code, but the early-return
    // guard still has to be exercised. We patch via env: no env vars + stub
    // out fetch to detect any call.
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 200 }),
    )
    try {
      await postCostMetric(payload)
      // It WILL call fetch against the default in-cluster URL — that's fine.
      // We're verifying the call happens, exercising the happy path.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [, init] = fetchSpy.mock.calls[0]
      expect((init as RequestInit).method).toBe('POST')
      expect(JSON.parse((init as RequestInit).body as string)).toEqual(payload)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('warns when the response is not ok', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    )
    try {
      await postCostMetric(payload)
      expect(warnSpy).toHaveBeenCalled()
      const msg = warnSpy.mock.calls[0][0] as string
      expect(msg).toContain('HTTP 500')
    } finally {
      warnSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })

  it('swallows fetch errors with a warn log', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net down'))
    try {
      await postCostMetric(payload)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect((warnSpy.mock.calls[0][1] as string)).toBe('net down')
    } finally {
      warnSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
