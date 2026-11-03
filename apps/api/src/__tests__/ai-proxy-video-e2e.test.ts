// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * Video Input — End-to-End Integration Tests (real OpenRouter)
 *
 * Proves the whole "an agent can watch a video and comment on it" path against
 * the REAL OpenRouter API with real clips, no fetch mocking:
 *
 *   1. Two `video_url` blocks → GLM 5.3 Flash describes each clip and states
 *      the difference (red square moving left→right vs blue square moving
 *      bottom→top).
 *   2. The same request in pi-ai's shape (`image_url` + `data:video/mp4`),
 *      which proves the proxy's `image_url` → `video_url` bridge.
 *   3. A blank clip → the model says there is no shape or motion. This is the
 *      anti-hallucination check: a model that invents a shape here would make
 *      every other assertion meaningless.
 *   4. A non-video model rejects the same request with 400
 *      `video_input_not_supported` and never reaches the network.
 *
 * The model is addressed by its BYOK OpenRouter id
 * (`openrouter:z-ai/glm-5.3-flash`) so the test needs no seeded
 * `ModelDefinition` row; the DB-defined row the picker shows routes through
 * exactly the same `provider: 'openrouter'` path.
 *
 * Skipped entirely when OPENROUTER_API_KEY is not set (same convention as
 * `ai-proxy-audio-e2e.test.ts`). Each call costs about $0.0006.
 *
 * Run: OPENROUTER_API_KEY=sk-or-... bun test apps/api/src/__tests__/ai-proxy-video-e2e.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import { join } from 'path'
import { generateProxyToken } from '../lib/ai-proxy-token'

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'video-e2e-project', name: 'Video E2E' }),
      findUnique: async () => ({ id: 'video-e2e-project', workspaceId: 'video-e2e-workspace' }),
    },
    usageEvent: { create: async (args: any) => args.data },
  },
}))

mock.module('../services/billing.service', () => ({
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 99 }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  accumulateUsage: () => {},
  accumulateImageUsage: () => false,
  hasSession: () => false,
  hasActiveSession: () => false,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'video-e2e-user',
}))

import { aiProxyRoutes } from '../routes/ai-proxy'

const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY
const MODEL = 'openrouter:z-ai/glm-5.3-flash'

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'video')
function fixture(name: string): string | null {
  try {
    return readFileSync(join(FIXTURE_DIR, name)).toString('base64')
  } catch {
    return null
  }
}

const RED_RIGHT = fixture('red-right.mp4')
const BLUE_UP = fixture('blue-up.mp4')
const BLANK = fixture('blank.mp4')

const PROMPT =
  'You are given two short videos, A and B. Describe what shape each one shows and how it moves. ' +
  'Reply with JSON only: {"a": "<shape and direction in A>", "b": "<shape and direction in B>"}.'

describe('Video input — end-to-end (real OpenRouter)', () => {
  let app: Hono
  let proxyToken: string
  let upstreamCalls = 0
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    app = new Hono()
    app.route('/api', aiProxyRoutes())
    proxyToken = await generateProxyToken('video-e2e-project', 'video-e2e-workspace', 'video-e2e-user')
    // Count real upstream calls so the rejection case can prove it never left
    // the process, while every other case still hits the network for real.
    globalThis.fetch = ((input: any, init?: RequestInit) => {
      upstreamCalls++
      return realFetch(input, init)
    }) as any
  })

  function post(body: unknown) {
    return app.fetch(
      new Request('http://localhost/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxyToken}` },
        body: JSON.stringify(body),
      }),
    )
  }

  test(
    'GLM 5.3 Flash watches two clips and states the difference (native video_url)',
    async () => {
      if (!hasOpenRouterKey || !RED_RIGHT || !BLUE_UP) {
        console.log('[Video E2E] Skipping — OPENROUTER_API_KEY not set or fixtures missing')
        return
      }

      const res = await post({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `Video A:\n${PROMPT}` },
              { type: 'video_url', video_url: { url: `data:video/mp4;base64,${RED_RIGHT}` } },
              { type: 'text', text: 'Video B:' },
              { type: 'video_url', video_url: { url: `data:video/mp4;base64,${BLUE_UP}` } },
            ],
          },
        ],
      })

      console.log(`[Video E2E] native video_url status: ${res.status}`)
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      const content: string = data.choices?.[0]?.message?.content ?? ''
      console.log(`[Video E2E] answer: ${content}`)
      console.log(`[Video E2E] usage: ${JSON.stringify(data.usage ?? {})}`)

      const lower = content.toLowerCase()
      expect(lower).toContain('red')
      expect(lower).toMatch(/right|left to right|left-to-right/)
      expect(lower).toContain('blue')
      expect(lower).toMatch(/up|bottom to top|bottom-to-top|upward/)
    },
    120_000,
  )

  test(
    'the pi-ai shape (image_url + data:video/mp4) is bridged to video_url',
    async () => {
      if (!hasOpenRouterKey || !RED_RIGHT || !BLUE_UP) {
        console.log('[Video E2E] Skipping — OPENROUTER_API_KEY not set or fixtures missing')
        return
      }

      const res = await post({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `Video A:\n${PROMPT}` },
              { type: 'image_url', image_url: { url: `data:video/mp4;base64,${RED_RIGHT}` } },
              { type: 'text', text: 'Video B:' },
              { type: 'image_url', image_url: { url: `data:video/mp4;base64,${BLUE_UP}` } },
            ],
          },
        ],
      })

      console.log(`[Video E2E] pi-ai bridge status: ${res.status}`)
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      const content: string = data.choices?.[0]?.message?.content ?? ''
      console.log(`[Video E2E] bridge answer: ${content}`)

      const lower = content.toLowerCase()
      expect(lower).toContain('red')
      expect(lower).toContain('blue')
    },
    120_000,
  )

  test(
    'a blank clip is reported as blank (no hallucinated shape)',
    async () => {
      if (!hasOpenRouterKey || !BLANK) {
        console.log('[Video E2E] Skipping — OPENROUTER_API_KEY not set or fixtures missing')
        return
      }

      const res = await post({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Describe this video in one sentence. If it shows no shape and no movement, say exactly that.',
              },
              { type: 'video_url', video_url: { url: `data:video/mp4;base64,${BLANK}` } },
            ],
          },
        ],
      })

      console.log(`[Video E2E] blank status: ${res.status}`)
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      const content: string = data.choices?.[0]?.message?.content ?? ''
      console.log(`[Video E2E] blank answer: ${content}`)

      const lower = content.toLowerCase()
      expect(lower).toMatch(/blank|empty|no (visible )?(shape|movement|motion)|nothing|white/)
      expect(lower).not.toMatch(/\bred\b|\bblue\b|\bgreen\b/)
    },
    120_000,
  )

  test('a non-video model rejects video with 400 and never calls upstream', async () => {
    const before = upstreamCalls
    const res = await post({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What happens in this video?' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
          ],
        },
      ],
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('video_input_not_supported')
    expect(data.error.message).toContain('glm-5-3-flash')
    expect(upstreamCalls).toBe(before)
  })

  test('a non-video model rejects the pi-ai video shape too', async () => {
    const before = upstreamCalls
    const res = await post({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:video/mp4;base64,AAAA' } },
          ],
        },
      ],
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('video_input_not_supported')
    expect(upstreamCalls).toBe(before)
  })
})
