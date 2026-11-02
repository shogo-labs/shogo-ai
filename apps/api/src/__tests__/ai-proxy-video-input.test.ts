// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * AI Proxy — video content-block handling on `POST /ai/v1/chat/completions`.
 *
 * Covers, with a mocked upstream fetch:
 *   - pi-ai's `image_url` + `data:video/*` block is rewritten to OpenRouter's
 *     `video_url` shape for a video-native model.
 *   - A `video_url` block that is already native passes through untouched.
 *   - Real images are never rewritten.
 *   - A model without video support rejects both shapes with a clear 400 and
 *     never reaches upstream.
 *   - `resolveModelSupportsVideoInput` honors DB capabilities, the static
 *     catalog, and BYOK `openrouter:` ids.
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-video-input.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENROUTER_API_KEY = 'sk-or-test'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-video', workspaceId: 'ws-video', name: 'Video Input Test' }),
      findUnique: async () => ({ id: 'proj-video', workspaceId: 'ws-video' }),
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
  getProjectUser: () => 'user-video',
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
const { aiProxyRoutes, resolveModelSupportsVideoInput, bridgeVideoContentBlocks } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

const VIDEO_B64 = 'AAAAIGZ0eXBtcDQy'
const IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let TOKEN: string

beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-video', 'ws-video', 'user-video')
})

beforeEach(() => {
  lastFetchUrl = null
  lastFetchBody = null
  nextResponse = null
})

function postChatCompletions(body: any) {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app.fetch(
    new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  )
}

describe('resolveModelSupportsVideoInput', () => {
  test('BYOK openrouter ids are allowed and let upstream decide', () => {
    expect(resolveModelSupportsVideoInput('openrouter:z-ai/glm-5.3-flash')).toBe(true)
  })

  test('a text-only catalog model is not video-native', () => {
    expect(resolveModelSupportsVideoInput('gpt-5.5')).toBe(false)
    expect(resolveModelSupportsVideoInput('claude-sonnet-5')).toBe(false)
  })
})

describe('bridgeVideoContentBlocks', () => {
  test('rewrites a data:video image_url into video_url and leaves the rest alone', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'watch this' },
          { type: 'image_url', image_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_B64}` } },
        ],
      },
    ]
    const bridged = bridgeVideoContentBlocks(messages) as any[]
    expect(bridged[0].content[0]).toEqual({ type: 'text', text: 'watch this' })
    expect(bridged[0].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${VIDEO_B64}` },
    })
    expect(bridged[0].content[2].type).toBe('image_url')
  })

  test('returns the same array when nothing needed rewriting', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text', text: 'hi' }] }]
    expect(bridgeVideoContentBlocks(messages)).toBe(messages)
  })
})

describe('video pass-through for a video-native model', () => {
  test('the pi-ai image_url video shape reaches OpenRouter as video_url', async () => {
    const res = await postChatCompletions({
      model: 'openrouter:z-ai/glm-5.3-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this clip.' },
            { type: 'image_url', image_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } },
          ],
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe('https://openrouter.ai/api/v1/chat/completions')
    const blocks = lastFetchBody.messages[0].content
    expect(blocks[1].type).toBe('video_url')
    expect(blocks[1].video_url.url).toBe(`data:video/mp4;base64,${VIDEO_B64}`)
    // The rewrite must not leave the image_url copy behind.
    expect(blocks.some((b: any) => b.type === 'image_url')).toBe(false)
  })

  test('a native video_url block is forwarded as-is', async () => {
    const res = await postChatCompletions({
      model: 'openrouter:z-ai/glm-5.3-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'video_url', video_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } }],
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(lastFetchBody.messages[0].content[0].type).toBe('video_url')
  })
})

describe('video rejection on a non-video model', () => {
  test('rejects a video_url block with a clear 400 and no upstream call', async () => {
    const res = await postChatCompletions({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'user',
          content: [{ type: 'video_url', video_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } }],
        },
      ],
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('video_input_not_supported')
    expect(data.error.message).toContain('glm-5-3-flash')
    expect(lastFetchUrl).toBeNull()
  })

  test('rejects the pi-ai image_url + data:video shape on an Anthropic model', async () => {
    const res = await postChatCompletions({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } },
          ],
        },
      ],
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('video_input_not_supported')
    expect(lastFetchUrl).toBeNull()
  })

  test('a real image on the same non-video model is unaffected (no false positive)', async () => {
    const res = await postChatCompletions({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_B64}` } },
          ],
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(lastFetchUrl).not.toBeNull()
  })
})
