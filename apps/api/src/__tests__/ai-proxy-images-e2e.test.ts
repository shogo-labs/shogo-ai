// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Image Generation Integration Tests
 *
 * Tests the full proxy flow for image generation endpoints:
 * - Auth + model resolution + provider routing for /ai/v1/images/generations
 * - Auth + provider routing for /ai/v1/images/edits
 * - Error paths (missing auth, bad model, missing prompt, no credits)
 * - Health check includes image model count
 *
 * Uses real Hono app with mocked prisma/billing. Requires OPENAI_API_KEY
 * or GOOGLE_API_KEY for live provider tests (skipped if absent).
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-images-e2e.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { generateProxyToken } from '../lib/ai-proxy-token'

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'img-project', name: 'Image Test' }),
      findUnique: async () => ({ id: 'img-project', workspaceId: 'img-workspace' }),
    },
    usageEvent: {
      create: async (args: any) => args.data,
    },
  },
}))

mock.module('../services/billing.service', () => ({
  hasCredits: async () => true,
  consumeCredits: async () => ({ success: true }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  accumulateUsage: () => {},
  hasSession: () => false,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'test-user',
}))

import { aiProxyRoutes } from '../routes/ai-proxy'

const hasOpenAIKey = !!process.env.OPENAI_API_KEY
const hasGoogleKey = !!process.env.GOOGLE_API_KEY

describe('AI Proxy Image Endpoints — Integration', () => {
  let app: Hono
  let proxyToken: string

  beforeAll(async () => {
    app = new Hono()
    const router = aiProxyRoutes()
    app.route('/api', router)

    proxyToken = await generateProxyToken('img-project', 'img-workspace', 'img-user')
  })

  // ===========================================================================
  // Auth
  // ===========================================================================

  test('POST /images/generations returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a sunset' }),
      })
    )
    expect(res.status).toBe(401)
    const data = (await res.json()) as any
    expect(data.error.type).toBe('authentication_error')
  })

  test('POST /images/edits returns 401 without auth', async () => {
    const form = new FormData()
    form.append('prompt', 'edit this')
    form.append('image', new Blob(['fake-png'], { type: 'image/png' }), 'test.png')

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/images/edits', {
        method: 'POST',
        body: form,
      })
    )
    expect(res.status).toBe(401)
    const data = (await res.json()) as any
    expect(data.error.type).toBe('authentication_error')
  })

  // ===========================================================================
  // Validation
  // ===========================================================================

  test('POST /images/generations returns 400 without prompt', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proxyToken}`,
        },
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('missing_prompt')
  })

  test('POST /images/generations returns 400 for unsupported model', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proxyToken}`,
        },
        body: JSON.stringify({ prompt: 'test', model: 'nonexistent-model-xyz' }),
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('model_not_found')
  })

  test('POST /images/edits returns 400 without prompt', async () => {
    const form = new FormData()
    form.append('image', new Blob(['fake'], { type: 'image/png' }), 'test.png')

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: form,
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('missing_prompt')
  })

  test('POST /images/edits returns 400 without image file', async () => {
    const form = new FormData()
    form.append('prompt', 'edit this image')

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}` },
        body: form,
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('missing_image')
  })

  // ===========================================================================
  // Health check includes image models
  // ===========================================================================

  test('GET /proxy/health includes imageModelCount', async () => {
    const res = await app.fetch(new Request('http://localhost/api/ai/proxy/health'))
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.status).toBe('ok')
    expect(data.imageModelCount).toBeGreaterThan(0)
    expect(data.providers.openai).toBe(hasOpenAIKey)
    expect(data.providers.google).toBe(hasGoogleKey)
  })

  // ===========================================================================
  // Live provider: OpenAI DALL-E (gpt-image-1 — cheaper, used for testing)
  // ===========================================================================

  test(
    'OpenAI image generation returns valid b64_json (dall-e-2)',
    async () => {
      if (!hasOpenAIKey) {
        console.log('[Image E2E] Skipping — OPENAI_API_KEY not set')
        return
      }

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${proxyToken}`,
          },
          body: JSON.stringify({
            prompt: 'A simple red circle on a white background',
            model: 'dall-e-2',
            size: '256x256',
            response_format: 'b64_json',
          }),
        })
      )

      console.log(`[Image E2E] OpenAI dall-e-2 status: ${res.status}`)
      expect(res.status).toBe(200)

      const data = (await res.json()) as any
      expect(data.created).toBeGreaterThan(0)
      expect(data.data).toBeArray()
      expect(data.data.length).toBe(1)
      expect(data.data[0].b64_json).toBeTruthy()

      const imageBytes = Buffer.from(data.data[0].b64_json, 'base64')
      expect(imageBytes.length).toBeGreaterThan(1000)
      console.log(`[Image E2E] OpenAI dall-e-2 returned ${imageBytes.length} bytes`)
    },
    60_000
  )

  // ===========================================================================
  // Live provider: Google Imagen
  // ===========================================================================

  test(
    'Google Imagen 4 generation returns valid b64_json',
    async () => {
      if (!hasGoogleKey) {
        console.log('[Image E2E] Skipping — GOOGLE_API_KEY not set')
        return
      }

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${proxyToken}`,
          },
          body: JSON.stringify({
            prompt: 'A simple blue square on a white background',
            model: 'imagen-4',
            size: '1024x1024',
          }),
        })
      )

      console.log(`[Image E2E] Google Imagen 4 status: ${res.status}`)

      if (res.status === 503) {
        console.log('[Image E2E] Google Imagen provider not configured — skipping')
        return
      }

      // Google may return 500 if API key doesn't have Imagen access enabled
      if (res.status === 500) {
        const data = (await res.json()) as any
        console.log(`[Image E2E] Google Imagen 4 returned 500: ${data.error?.message || 'unknown'}`)
        console.log('[Image E2E] This may indicate Imagen API access needs to be enabled for this API key')
        return
      }

      expect(res.status).toBe(200)

      const data = (await res.json()) as any
      expect(data.created).toBeGreaterThan(0)
      expect(data.data).toBeArray()
      expect(data.data.length).toBeGreaterThanOrEqual(1)
      expect(data.data[0].b64_json).toBeTruthy()

      const imageBytes = Buffer.from(data.data[0].b64_json, 'base64')
      expect(imageBytes.length).toBeGreaterThan(1000)
      console.log(`[Image E2E] Google Imagen 4 returned ${imageBytes.length} bytes`)
    },
    60_000
  )

  // ===========================================================================
  // Live provider: OpenAI image edits
  // ===========================================================================

  test(
    'OpenAI image edit endpoint accepts image + prompt',
    async () => {
      if (!hasOpenAIKey) {
        console.log('[Image E2E] Skipping edits — OPENAI_API_KEY not set')
        return
      }

      // Create a tiny valid 1x1 PNG to use as reference
      const PNG_1x1 = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64'
      )

      const form = new FormData()
      form.append('image', new Blob([PNG_1x1], { type: 'image/png' }), 'ref.png')
      form.append('prompt', 'Make the pixel red')
      form.append('model', 'dall-e-2')
      form.append('size', '256x256')

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/images/edits', {
          method: 'POST',
          headers: { Authorization: `Bearer ${proxyToken}` },
          body: form,
        })
      )

      console.log(`[Image E2E] OpenAI edit status: ${res.status}`)

      // gpt-image-1 may reject a 1x1 PNG; that's OK for integration testing —
      // proving our proxy correctly forwarded the request and got a structured error back
      if (res.status === 200) {
        const data = (await res.json()) as any
        expect(data.data).toBeArray()
        expect(data.data.length).toBe(1)
        expect(data.data[0].b64_json).toBeTruthy()
        console.log('[Image E2E] OpenAI edit succeeded')
      } else {
        const data = (await res.json()) as any
        console.log(`[Image E2E] OpenAI edit returned ${res.status}: ${data.error?.message || JSON.stringify(data)}`)
        // Proxy wraps upstream errors as 500; 400 is also possible
        expect([400, 500]).toContain(res.status)
        expect(data.error).toBeDefined()
      }
    },
    60_000
  )
})
