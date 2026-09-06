// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * AI Proxy — `input_audio` content-block handling on
 * `POST /ai/v1/chat/completions`.
 *
 * Covers:
 *   - A model without `capabilities.supportsAudioInput` (e.g. gpt-5.5)
 *     rejects `input_audio` blocks with a clear 400 up front, instead of
 *     bouncing off OpenAI/Anthropic with a generic "text or image_url" error.
 *   - `gpt-audio` (the one catalog entry with `supportsAudioInput: true`)
 *     accepts `input_audio` blocks and forwards them upstream unmodified
 *     (the OpenAI-compatible path is a pure pass-through — no local
 *     transformation of content blocks).
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-audio-input.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.OPENAI_API_KEY = 'sk-openai-test'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-audio', workspaceId: 'ws-audio', name: 'Audio Input Test' }),
      findUnique: async () => ({ id: 'proj-audio', workspaceId: 'ws-audio' }),
    },
    usageEvent: { create: async () => ({}) },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => false,
  accumulateImageUsage: () => false,
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'user-audio',
}))

const originalFetch = globalThis.fetch
let lastFetchUrl: string | null = null
let lastFetchBody: any = null
let nextResponse: Response | null = null

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    lastFetchUrl = typeof input === 'string' ? input : input.url
    lastFetchBody = init?.body ? JSON.parse(init.body as string) : null
    return (
      nextResponse ??
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as any
})

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

function buildApp() {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app
}

let TOKEN: string

beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-audio', 'ws-audio', 'user-audio')
})

beforeEach(() => {
  lastFetchUrl = null
  lastFetchBody = null
  nextResponse = null
})

function postChatCompletions(body: any) {
  const app = buildApp()
  return app.fetch(
    new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    })
  )
}

describe('input_audio validation on non-audio models', () => {
  test('rejects an input_audio block sent to a text-only model (gpt-5.5) with a clear 400', async () => {
    const res = await postChatCompletions({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: 'ZmFrZS1hdWRpby1kYXRh', format: 'wav' } },
            { type: 'text', text: 'What is said here?' },
          ],
        },
      ],
    })
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('audio_input_not_supported')
    expect(data.error.message).toContain('gpt-audio')
    // Rejected locally — never reaches the upstream provider.
    expect(lastFetchUrl).toBeNull()
  })

  test('rejects input_audio sent to an Anthropic model too', async () => {
    const res = await postChatCompletions({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'ZmFrZQ==', format: 'wav' } }],
        },
      ],
    })
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('audio_input_not_supported')
  })

  test('plain text-only messages to gpt-5.5 are unaffected (no false positive)', async () => {
    const res = await postChatCompletions({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(res.status).toBe(200)
  })
})

describe('input_audio pass-through for gpt-audio', () => {
  test('accepts an input_audio block and forwards it upstream unmodified', async () => {
    const res = await postChatCompletions({
      model: 'gpt-audio',
      modalities: ['text', 'audio'],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: 'ZmFrZS1hdWRpby1kYXRh', format: 'wav' } },
            { type: 'text', text: 'Transcribe this.' },
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://api.openai.com/v1/chat/completions')
    expect(lastFetchBody.model).toBe('gpt-audio')
    // Pass-through: the input_audio block reaches upstream byte-for-byte.
    const forwardedBlock = lastFetchBody.messages[0].content[0]
    expect(forwardedBlock.type).toBe('input_audio')
    expect(forwardedBlock.input_audio.data).toBe('ZmFrZS1hdWRpby1kYXRh')
    expect(forwardedBlock.input_audio.format).toBe('wav')
  })
})
