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
 *   - A Google-direct Gemini model keeps pi-ai's `image_url` shape — Google's
 *     OpenAI-compatible endpoint decodes video from it (SHO-495 probe) — and
 *     text-only Google turns are unchanged.
 *   - A model without video support rejects both shapes with a clear 400 and
 *     never reaches upstream.
 *   - `resolveModelSupportsVideoInput` honors DB capabilities, the static
 *     catalog (including a seeded DB row that carries no capabilities), and
 *     BYOK `openrouter:` ids.
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-video-input.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENROUTER_API_KEY = 'sk-or-test'

/**
 * The rows `scripts/seed-db-models.ts seedGemini` writes, as the picker and the
 * runtime actually see them: a UUID primary key with the provider slug in
 * `apiModel` and the slug in `aliases`. The client saves that UUID, so it is
 * the id the proxy guard and `AGENT_MODEL_REGISTRY` get — the slug path alone
 * (which the static catalog covers) hides this whole class of bug.
 *
 * Four rows carry no `capabilities`, which is what the seeder wrote before
 * SHO-495, and one carries the flag the seeder now copies from the catalog, so
 * both halves of the fix are exercised.
 */
const CARBON_UUID = '6f1c5a2e-8f43-4b1c-9d3a-0c1b2a3d4e5f'

const geminiRow = (id: string, apiModel: string, capabilities: Record<string, unknown> | null) => ({
  id,
  provider: 'google',
  providerId: null,
  apiModel,
  displayName: apiModel,
  shortDisplayName: apiModel,
  tier: 'premium',
  family: 'gemini',
  generation: 'current',
  kind: 'chat',
  maxOutputTokens: 65536,
  enabled: true,
  sortOrder: 10,
  aliases: [apiModel],
  capabilities,
  inputPerMillion: 1,
  cachedInputPerMillion: 0.1,
  cacheWritePerMillion: 1.25,
  outputPerMillion: 10,
  contextWindow: 1048576,
  reasoningEffort: 'medium',
})

const SEEDED_GEMINI_ROWS = [
  geminiRow(CARBON_UUID, 'gemini-4-carbon', null),
  geminiRow('a1b2c3d4-1111-4e2f-8a9b-0c1d2e3f4a5b', 'gemini-4-argon', null),
  geminiRow('b2c3d4e5-2222-4f3a-9b0c-1d2e3f4a5b6c', 'gemini-4-neon', null),
  geminiRow('c3d4e5f6-3333-4a4b-8c1d-2e3f4a5b6c7d', 'gemini-4-hydrogen', null),
  geminiRow('d4e5f6a7-4444-4b5c-9d2e-3f4a5b6c7d8e', 'gemini-3.8-flash', { supportsVideoInput: true }),
]

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    modelDefinition: { findMany: async () => SEEDED_GEMINI_ROWS },
    modelProvider: { findMany: async () => [] },
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
  process.env.GOOGLE_API_KEY = 'AIza-test-google-video-key'
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

// The stub above is process-global: without this, any other test file that runs
// in the same process (e.g. video-pipeline.test.ts, which drives an agent loop
// through real fetch) gets its calls swallowed.
afterAll(() => {
  globalThis.fetch = originalFetch
  delete process.env.GOOGLE_API_KEY
})

const { Hono } = await import('hono')
const { aiProxyRoutes, resolveModelSupportsVideoInput, bridgeVideoContentBlocks } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { invalidateModelRegistry } = await import('../services/model-registry.service')

const GOOGLE_COMPAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

/** The Google models the probe showed are video-native (SHO-495 step 0). */
const VIDEO_GOOGLE_MODELS = ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash']
/** A Google model the probe never ran, so it keeps the pre-SHO-495 behaviour. */
const NON_VIDEO_GOOGLE_MODEL = 'gemini-3.5-flash-lite'

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

  test('a seeded DB row with no capabilities does not hide the catalog flag', async () => {
    await invalidateModelRegistry()
    // The picker saves the row's UUID, not the slug: this is the id the proxy
    // guard and the runtime registry actually see on a seeded instance.
    for (const row of SEEDED_GEMINI_ROWS) {
      expect(resolveModelSupportsVideoInput(row.id)).toBe(true)
    }
    // …and the slug still resolves through the static catalog, which is what a
    // fresh, unseeded instance and every e2e ordering use.
    for (const model of VIDEO_GOOGLE_MODELS) {
      expect(resolveModelSupportsVideoInput(model)).toBe(true)
    }
  })

  test('a Google model the catalog does not flag stays unsupported', async () => {
    await invalidateModelRegistry()
    expect(resolveModelSupportsVideoInput(NON_VIDEO_GOOGLE_MODEL)).toBe(false)
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

/** Google's native endpoint, which is where a video turn now goes. */
const googleNativeUrl = (apiModel: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent`

/** A native `generateContent` answer, so the round-trip is real, not a stub. */
const nativeAnswer = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

describe('video turns for a Google-direct model go native', () => {
  // SHO-591 §A. SHO-495 step 0 established that Google's *compat* endpoint does
  // decode pi-ai's `image_url` + `data:video/*` block — that is why we sent it
  // untouched — but it samples at 1 frame per second of duration and has no
  // setting for the rate. `videoMetadata.fps` exists only on the native API, so
  // a video turn is translated and sent there instead.
  for (const model of VIDEO_GOOGLE_MODELS) {
    test(`${model} sends its video turn to native generateContent`, async () => {
      nextResponse = nativeAnswer()
      const res = await postChatCompletions({
        model,
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
      expect(lastFetchUrl).toBe(googleNativeUrl(model))
      const parts = lastFetchBody.contents[0].parts
      expect(parts[0]).toEqual({ text: 'Describe this clip.' })
      expect(parts[1].inlineData.mimeType).toBe('video/mp4')
      expect(parts[1].inlineData.data).toBe(VIDEO_B64)
      // No rate was asked for, so no `videoMetadata`: Google's own 1 fps default
      // is what the caller gets, and the runtime reports that to the model.
      expect(parts[1].videoMetadata).toBeUndefined()
    })
  }

  test('carries the requested frame rate on the native video block', async () => {
    nextResponse = nativeAnswer()
    const res = await postChatCompletions({
      model: 'gemini-4-hydrogen',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this clip.' },
            { type: 'image_url', image_url: { url: `data:video/mp4;fps=10;start=5;base64,${VIDEO_B64}` } },
          ],
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(lastFetchBody.contents[0].parts[1].videoMetadata).toEqual({ fps: 10, startOffset: '5s' })
  })

  // The id the picker serves and the client saves on a seeded instance is the
  // row's UUID. This is the case that 400'd on staging before SHO-495 round 1.
  test('a seeded UUID id reaches Google for its apiModel, not as the UUID', async () => {
    await invalidateModelRegistry()
    nextResponse = nativeAnswer()
    const res = await postChatCompletions({
      model: CARBON_UUID,
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
    // The cloud/local proxy addresses the provider by the row's apiModel.
    expect(lastFetchUrl).toBe(googleNativeUrl('gemini-4-carbon'))
    expect(lastFetchBody.contents[0].parts[1].inlineData.data).toBe(VIDEO_B64)
  })

  test('a text-only turn is unchanged: same endpoint, same messages, catalog cap', async () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const res = await postChatCompletions({ model: 'gemini-4-carbon', messages, max_tokens: 128 })

    expect(res.status).toBe(200)
    expect(lastFetchUrl).toBe(GOOGLE_COMPAT_URL)
    expect(lastFetchBody.messages).toEqual(messages)
    expect(lastFetchBody.max_tokens).toBe(128)
    expect(lastFetchBody.store).toBeUndefined()
    expect(lastFetchBody.reasoning_content).toBeUndefined()
  })
})

describe('video rejection on a Google model without the flag', () => {
  test('rejects the pi-ai video shape with a clear 400 and no upstream call', async () => {
    const res = await postChatCompletions({
      model: NON_VIDEO_GOOGLE_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What happens in this video?' },
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
})
