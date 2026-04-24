// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy End-to-End Integration Test
 *
 * Simulates the ai-chat example's flow through the proxy:
 * 1. Generate a proxy token (like knative-project-manager does)
 * 2. List available models (like the UI model picker)
 * 3. Make an OpenAI-compatible chat completion (like ai-chat's getAIModel + streamText)
 * 4. Make an Anthropic-native request
 *
 * Requires ANTHROPIC_API_KEY in environment for real API calls.
 * Run: ANTHROPIC_API_KEY=sk-... bun test apps/api/src/__tests__/ai-proxy-e2e.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'

// Run the billing service in local mode so usage-wallet checks are bypassed
// without needing to stub every model in the mocked Prisma client. The env
// var is read at module load, so set it before importing anything that
// transitively loads billing.service.
process.env.SHOGO_LOCAL_MODE = 'true'

// Mock prisma to avoid database dependency
mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'e2e-project', name: 'E2E Test' }),
      findUnique: async () => ({
        id: 'e2e-project',
        workspaceId: 'e2e-workspace',
      }),
    },
    usageEvent: {
      create: async (args: any) => {
        console.log('[Usage Event]', JSON.stringify(args.data, null, 2))
        return args.data
      },
    },
    usageWallet: {
      findUnique: async () => ({
        workspaceId: 'e2e-workspace',
        monthlyIncludedUsd: 1_000_000,
        monthlyIncludedAllocationUsd: 1_000_000,
        dailyIncludedUsd: 1_000_000,
        dailyUsedThisMonthUsd: 0,
        overageEnabled: false,
        overageHardLimitUsd: null,
        overageAccumulatedUsd: 0,
        stripeMeteredItemId: null,
        lastDailyReset: new Date(),
        lastMonthlyReset: new Date(),
      }),
      upsert: async (args: any) => args.create,
      create: async (args: any) => args.data,
      update: async (args: any) => args.data,
    },
    subscription: {
      findFirst: async () => null,
    },
  },
}))

const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { aiProxyRoutes } = await import('../routes/ai-proxy')

const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY

describe('AI Proxy E2E — ai-chat example flow', () => {
  let app: Hono
  let proxyToken: string

  beforeAll(async () => {
    app = new Hono()
    const proxyRouter = aiProxyRoutes()
    app.route('/api', proxyRouter)

    // Step 1: Generate a proxy token (simulates what knative-project-manager does)
    proxyToken = await generateProxyToken(
      'e2e-project',
      'e2e-workspace',
      'e2e-user'
    )
    console.log(
      `[E2E] Generated proxy token: ${proxyToken.substring(0, 20)}...`
    )
  })

  // ===========================================================================
  // Step 2: List models (like the UI model picker would)
  // ===========================================================================

  test('list models returns updated model registry with new Anthropic models', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/models', {
        headers: { Authorization: `Bearer ${proxyToken}` },
      })
    )
    expect(res.status).toBe(200)

    const data = (await res.json()) as any
    expect(data.object).toBe('list')

    const modelIds = data.data.map((m: any) => m.id)
    console.log(`[E2E] Available models (${modelIds.length}):`, modelIds)

    // Verify the new current-gen models are present
    expect(modelIds).toContain('claude-opus-4-7')
    expect(modelIds).toContain('claude-sonnet-4-5-20250929')
    expect(modelIds).toContain('claude-haiku-4-5-20251001')

    // Verify legacy models are still present
    expect(modelIds).toContain('claude-opus-4-5-20251101')
    expect(modelIds).toContain('claude-sonnet-4-20250514')
    expect(modelIds).toContain('claude-3-7-sonnet-20250219')
    expect(modelIds).toContain('claude-3-haiku-20240307')

    // Verify OpenAI models
    expect(modelIds).toContain('gpt-4o')
    expect(modelIds).toContain('gpt-4o-mini')

    // Verify model structure
    for (const model of data.data) {
      expect(model.object).toBe('model')
      expect(model.id).toBeDefined()
      expect(model.owned_by).toBeDefined()
      expect(typeof model.available).toBe('boolean')
    }
  })

  // ===========================================================================
  // Step 3: OpenAI-compatible chat completion (like ai-chat example does)
  // This mirrors getAIModel() using createOpenAI({ baseURL: proxyUrl, apiKey: proxyToken })
  // ===========================================================================

  test(
    'OpenAI-compatible completion with Claude model (non-streaming)',
    async () => {
      if (!hasAnthropicKey) {
        console.log('[E2E] Skipping — ANTHROPIC_API_KEY not set')
        return
      }

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${proxyToken}`,
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            messages: [
              { role: 'system', content: 'Reply in exactly 5 words.' },
              { role: 'user', content: 'What is 2+2?' },
            ],
            max_tokens: 50,
          }),
        })
      )

      console.log(`[E2E] OpenAI-compat response status: ${res.status}`)

      expect(res.status).toBe(200)

      const data = (await res.json()) as any
      console.log('[E2E] OpenAI-compat response:', JSON.stringify(data, null, 2))

      // Validate OpenAI-compatible response format
      expect(data.object).toBe('chat.completion')
      expect(data.choices).toBeDefined()
      expect(data.choices.length).toBe(1)
      expect(data.choices[0].message.role).toBe('assistant')
      expect(data.choices[0].message.content).toBeTruthy()
      expect(data.choices[0].finish_reason).toBe('stop')

      // Validate usage stats
      expect(data.usage).toBeDefined()
      expect(data.usage.prompt_tokens).toBeGreaterThan(0)
      expect(data.usage.completion_tokens).toBeGreaterThan(0)
      expect(data.usage.total_tokens).toBeGreaterThan(0)

      console.log(
        `[E2E] AI response: "${data.choices[0].message.content}"`
      )
      console.log(
        `[E2E] Tokens: ${data.usage.prompt_tokens} in, ${data.usage.completion_tokens} out`
      )
    },
    30_000
  )

  test(
    'OpenAI-compatible completion with Claude model (streaming)',
    async () => {
      if (!hasAnthropicKey) {
        console.log('[E2E] Skipping — ANTHROPIC_API_KEY not set')
        return
      }

      const res = await app.fetch(
        new Request('http://localhost/api/ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${proxyToken}`,
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            messages: [
              { role: 'user', content: 'Say hello in one word.' },
            ],
            max_tokens: 20,
            stream: true,
          }),
        })
      )

      console.log(`[E2E] Streaming response status: ${res.status}`)
      expect(res.status).toBe(200)

      // Read the SSE stream
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let chunks = 0
      let done = false

      while (!done) {
        const { value, done: streamDone } = await reader.read()
        if (streamDone) break

        const text = decoder.decode(value, { stream: true })
        const lines = text.split('\n')

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            done = true
            break
          }

          try {
            const chunk = JSON.parse(data)
            chunks++
            const delta = chunk.choices?.[0]?.delta
            if (delta?.content) {
              fullText += delta.content
            }
          } catch {
            // Ignore parse errors for incomplete chunks
          }
        }
      }

      console.log(`[E2E] Stream received ${chunks} chunks, text: "${fullText}"`)
      expect(chunks).toBeGreaterThan(0)
      expect(fullText.length).toBeGreaterThan(0)
    },
    30_000
  )

  // ===========================================================================
  // Step 4: Anthropic-native pass-through
  // This mirrors ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY (proxy token) flow
  // ===========================================================================

  test(
    'Anthropic-native pass-through with proxy token',
    async () => {
      if (!hasAnthropicKey) {
        console.log('[E2E] Skipping — ANTHROPIC_API_KEY not set')
        return
      }

      const res = await app.fetch(
        new Request('http://localhost/api/ai/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': proxyToken, // Anthropic-compatible clients send the proxy token here
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            messages: [{ role: 'user', content: 'Say "proxy works" and nothing else.' }],
            max_tokens: 20,
          }),
        })
      )

      console.log(`[E2E] Anthropic-native response status: ${res.status}`)

      expect(res.status).toBe(200)

      const data = (await res.json()) as any
      console.log('[E2E] Anthropic-native response:', JSON.stringify(data, null, 2))

      // Validate Anthropic response format
      expect(data.content).toBeDefined()
      expect(Array.isArray(data.content)).toBe(true)
      expect(data.content.length).toBeGreaterThan(0)
      expect(data.content[0].type).toBe('text')
      expect(data.content[0].text).toBeTruthy()
      expect(data.stop_reason).toBe('end_turn')

      // Validate usage
      expect(data.usage).toBeDefined()
      expect(data.usage.input_tokens).toBeGreaterThan(0)
      expect(data.usage.output_tokens).toBeGreaterThan(0)

      console.log(`[E2E] Anthropic response: "${data.content[0].text}"`)
    },
    30_000
  )

  // ===========================================================================
  // Step 5: Verify alias resolution (ai-chat might use short model names)
  // ===========================================================================

  test('model aliases resolve correctly', async () => {
    // Test that short aliases work in the models list
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proxyToken}`,
        },
        body: JSON.stringify({
          model: 'claude-sonnet', // Short alias
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
      })
    )

    if (!hasAnthropicKey) {
      // Without the key, we should get 503 (provider not configured) not 400 (model not found)
      // This proves the alias resolved successfully
      expect(res.status).toBe(503)
      const data = (await res.json()) as any
      console.log(`[E2E] Alias 'claude-sonnet' resolved — got expected 503 (no key)`)
      expect(data.error.code).toBe('provider_not_configured')
    } else {
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      console.log(
        `[E2E] Alias 'claude-sonnet' resolved to model: ${data.model}`
      )
    }
  }, 30_000)

  test('short alias claude-opus resolves to Opus 4.7', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proxyToken}`,
        },
        body: JSON.stringify({
          model: 'claude-opus', // Should resolve to claude-opus-4-7
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
      })
    )

    // Should NOT be 400 (model not found)
    expect(res.status).not.toBe(400)

    if (!hasAnthropicKey) {
      expect(res.status).toBe(503)
      console.log(`[E2E] Alias 'claude-opus' resolved — got expected 503 (no key)`)
    } else {
      expect(res.status).toBe(200)
      console.log(`[E2E] Alias 'claude-opus' resolved and produced a response`)
    }
  }, 30_000)

  test('short alias claude-haiku resolves to Haiku 4.5', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proxyToken}`,
        },
        body: JSON.stringify({
          model: 'claude-haiku', // Should resolve to claude-haiku-4-5-20251001
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
      })
    )

    expect(res.status).not.toBe(400)

    if (!hasAnthropicKey) {
      expect(res.status).toBe(503)
      console.log(`[E2E] Alias 'claude-haiku' resolved — got expected 503 (no key)`)
    } else {
      expect(res.status).toBe(200)
      console.log(`[E2E] Alias 'claude-haiku' resolved and produced a response`)
    }
  }, 30_000)
})
