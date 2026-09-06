// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * AI Proxy Audio Transcription Tests
 *
 * Tests `POST /ai/v1/audio/transcriptions` — the internal Whisper proxy
 * route that lets `transcribe_audio` (packages/agent-runtime/src/gateway-tools.ts)
 * and `transcription.service.ts`'s cloud fallback go through the same
 * auth/billing path as every other `/ai/v1/*` route instead of requiring a
 * raw OpenAI key.
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-audio-transcriptions.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { generateProxyToken } from '../lib/ai-proxy-token'

let hasBalanceResult = true
let consumeUsageCalls: any[] = []

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'audio-project', name: 'Audio Test' }),
      findUnique: async () => ({ id: 'audio-project', workspaceId: 'audio-workspace' }),
    },
    usageEvent: {
      create: async (args: any) => args.data,
    },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => hasBalanceResult,
  checkUsageBalance: async () => ({ ok: hasBalanceResult }),
  usageLimitErrorPayload: () => ({ message: 'Usage limit reached.', code: 'usage_limit_reached' }),
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    return { success: true, remainingIncludedUsd: 99 }
  },
}))

mock.module('../lib/proxy-billing-session', () => ({
  accumulateUsage: () => {},
  accumulateImageUsage: () => false,
  hasSession: () => false,
  hasActiveSession: () => false,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'test-user',
}))

import { aiProxyRoutes } from '../routes/ai-proxy'

describe('AI Proxy Audio Transcription Endpoint', () => {
  let app: Hono
  let proxyToken: string
  const originalFetch = global.fetch
  const originalOpenAIKey = process.env.OPENAI_API_KEY

  beforeAll(async () => {
    app = new Hono()
    const router = aiProxyRoutes()
    app.route('/api', router)

    proxyToken = await generateProxyToken('audio-project', 'audio-workspace', 'audio-user')
  })

  beforeEach(() => {
    hasBalanceResult = true
    consumeUsageCalls = []
    global.fetch = originalFetch
    if (originalOpenAIKey) process.env.OPENAI_API_KEY = originalOpenAIKey
  })

  function audioForm(fileBytes: Uint8Array = new Uint8Array([1, 2, 3, 4]), name = 'clip.wav') {
    const form = new FormData()
    form.append('file', new Blob([fileBytes], { type: 'audio/wav' }), name)
    return form
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  test('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        body: audioForm(),
      })
    )
    expect(res.status).toBe(401)
    const data = (await res.json()) as any
    expect(data.error.type).toBe('authentication_error')
  })

  // ===========================================================================
  // Validation
  // ===========================================================================

  test('returns 400 without a file', async () => {
    const form = new FormData()
    form.append('model', 'whisper-1')

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: form,
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('missing_file')
  })

  test('returns 400 when the file exceeds the 25MB Whisper cap', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const oversized = Buffer.alloc(26 * 1024 * 1024)

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: audioForm(oversized),
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('file_too_large')
  })

  test('returns 503 when OpenAI is not configured', async () => {
    delete process.env.OPENAI_API_KEY

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: audioForm(),
      })
    )
    expect(res.status).toBe(503)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('provider_not_configured')
  })

  // ===========================================================================
  // Billing gate
  // ===========================================================================

  test('returns 402 when the workspace has no balance', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    hasBalanceResult = false

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: audioForm(),
      })
    )
    expect(res.status).toBe(402)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('usage_limit_reached')
  })

  // ===========================================================================
  // Happy path (mocked upstream)
  // ===========================================================================

  test('forwards to OpenAI Whisper, always requesting verbose_json, and bills by duration', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    let capturedUrl = ''
    let capturedAuth = ''
    let capturedForm: FormData | null = null

    global.fetch = (async (url: string, init: any) => {
      capturedUrl = url
      capturedAuth = init.headers.Authorization
      capturedForm = init.body as FormData
      return new Response(
        JSON.stringify({ text: 'hello world', language: 'en', duration: 12.5, segments: [] }),
        { status: 200 }
      )
    }) as any

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: audioForm(new Uint8Array([1, 2, 3]), 'note.wav'),
      })
    )

    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.text).toBe('hello world')
    expect(data.duration).toBe(12.5)

    expect(capturedUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(capturedAuth).toBe('Bearer sk-test')
    expect(capturedForm!.get('response_format')).toBe('verbose_json')

    // Billed by duration (12.5s * $0.006/60s * 1.2 markup), not a flat fee.
    expect(consumeUsageCalls.length).toBe(1)
    expect(consumeUsageCalls[0].actionType).toBe('ai_audio_transcription')
    expect(consumeUsageCalls[0].actionMetadata.durationSeconds).toBe(12.5)
    expect(consumeUsageCalls[0].billedUsd).toBeGreaterThan(0)
  })

  test('forwards the language field when provided', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    let capturedForm: FormData | null = null

    global.fetch = (async (_url: string, init: any) => {
      capturedForm = init.body as FormData
      return new Response(JSON.stringify({ text: 'bonjour', language: 'fr', duration: 2 }), { status: 200 })
    }) as any

    const form = audioForm()
    form.append('language', 'fr')

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: form,
      })
    )
    expect(res.status).toBe(200)
    expect(capturedForm!.get('language')).toBe('fr')
  })

  test('maps a non-2xx upstream response to a 500 with the error body surfaced', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    global.fetch = (async () => new Response('bad request from openai', { status: 400 })) as any

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: audioForm(),
      })
    )
    expect(res.status).toBe(500)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('transcription_error')
    expect(data.error.message).toContain('bad request from openai')
  })
})
