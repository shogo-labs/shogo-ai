// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * Audio Input — End-to-End Integration Tests
 *
 * Exercises the full audio pipeline against the REAL OpenAI API (no fetch
 * mocking) with a real spoken WAV clip:
 *
 *   1. Tier 1 — `POST /ai/v1/chat/completions` with `model: 'gpt-audio'` and
 *      a real `input_audio` content block: proves the proxy's pure
 *      pass-through actually gets OpenAI to understand spoken audio.
 *   2. Tier 2 — `POST /ai/v1/audio/transcriptions`: proves the new Whisper
 *      proxy route returns a real, accurate transcript.
 *   3. Tier 2, full chain — starts a REAL HTTP server wrapping the proxy
 *      routes and calls `transcribeAudioParts` (the exact function
 *      `gateway.ts` calls for chat attachments) against it over a real
 *      socket, proving the AI_PROXY_URL `/v1` stripping + auth header +
 *      network round trip all work together, not just against mocks.
 *
 * Skipped entirely when OPENAI_API_KEY is not set (same convention as
 * `ai-proxy-images-e2e.test.ts`).
 *
 * Run: OPENAI_API_KEY=sk-... bun test apps/api/src/__tests__/ai-proxy-audio-e2e.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import { generateProxyToken } from '../lib/ai-proxy-token'

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'audio-e2e-project', name: 'Audio E2E' }),
      findUnique: async () => ({ id: 'audio-e2e-project', workspaceId: 'audio-e2e-workspace' }),
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
  getProjectUser: () => 'audio-e2e-user',
}))

import { aiProxyRoutes } from '../routes/ai-proxy'
import { transcribeAudioParts } from '@shogo/agent-runtime/src/file-attachment-utils'

const hasOpenAIKey = !!process.env.OPENAI_API_KEY

// A short, real spoken clip: `say -o test-clip.wav --data-format=LEI16@16000
// "The quick brown fox jumps over the lazy dog."` (macOS `say`, Samantha voice).
const CLIP_PATH = '/tmp/audio-e2e/test-clip.wav'
const CLIP_BASE64 = (() => {
  try {
    return readFileSync(CLIP_PATH).toString('base64')
  } catch {
    return null
  }
})()

describe('Audio input — end-to-end (real OpenAI)', () => {
  let app: Hono
  let proxyToken: string

  beforeAll(async () => {
    app = new Hono()
    app.route('/api', aiProxyRoutes())
    proxyToken = await generateProxyToken('audio-e2e-project', 'audio-e2e-workspace', 'audio-e2e-user')
  })

  test(
    'Tier 1: gpt-audio understands a real spoken clip via input_audio pass-through',
    async () => {
      if (!hasOpenAIKey || !CLIP_BASE64) {
        console.log('[Audio E2E] Skipping — OPENAI_API_KEY not set or test clip missing')
        return
      }

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxyToken}` },
          body: JSON.stringify({
            model: 'gpt-audio',
            modalities: ['text'],
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'input_audio', input_audio: { data: CLIP_BASE64, format: 'wav' } },
                  { type: 'text', text: 'Reply with exactly the words you heard, nothing else.' },
                ],
              },
            ],
          }),
        })
      )

      console.log(`[Audio E2E] gpt-audio status: ${res.status}`)
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      const content = data.choices?.[0]?.message?.content
      console.log(`[Audio E2E] gpt-audio heard: "${content}"`)
      expect(typeof content).toBe('string')
      expect(content.toLowerCase()).toContain('fox')
    },
    60_000
  )

  test(
    'Tier 2: POST /ai/v1/audio/transcriptions returns an accurate Whisper transcript',
    async () => {
      if (!hasOpenAIKey || !CLIP_BASE64) {
        console.log('[Audio E2E] Skipping — OPENAI_API_KEY not set or test clip missing')
        return
      }

      const form = new FormData()
      const bytes = Buffer.from(CLIP_BASE64, 'base64')
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'test-clip.wav')

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${proxyToken}` },
          body: form,
        })
      )

      console.log(`[Audio E2E] /audio/transcriptions status: ${res.status}`)
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      console.log(`[Audio E2E] Whisper transcript: "${data.text}"`)
      expect(data.text.toLowerCase()).toContain('fox')
      expect(data.duration).toBeGreaterThan(0)
    },
    60_000
  )

  test(
    'Tier 2, full chain: transcribeAudioParts -> real HTTP proxy server -> real Whisper',
    async () => {
      if (!hasOpenAIKey || !CLIP_BASE64) {
        console.log('[Audio E2E] Skipping — OPENAI_API_KEY not set or test clip missing')
        return
      }

      // Stand up a real listening HTTP server wrapping the exact same route
      // registration used in production (server.ts mounts aiProxyRoutes()
      // under /api), so this test exercises a real socket + real
      // request/response cycle, not an in-process app.fetch() call.
      const server = Bun.serve({ port: 0, fetch: app.fetch })
      const proxyUrl = `http://localhost:${server.port}/api/ai/v1`

      try {
        const result = await transcribeAudioParts(
          [
            {
              type: 'file',
              mediaType: 'audio/wav',
              url: `data:audio/wav;base64,${CLIP_BASE64}`,
              name: 'test-clip.wav',
            },
          ],
          { aiProxyUrl: proxyUrl, aiProxyToken: proxyToken }
        )

        console.log(`[Audio E2E] transcribeAudioParts result: "${result}"`)
        expect(result).toContain('auto-transcribed')
        expect(result.toLowerCase()).toContain('fox')
      } finally {
        server.stop(true)
      }
    },
    60_000
  )
})
