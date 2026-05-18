// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy runtime-token auth tests.
 *
 * Confirms that `validateProxyAuth` (Authorization: Bearer rt_v1_*) and
 * `validateAnthropicAuth` (x-api-key: rt_v1_*) accept v1 runtime tokens
 * for projects with a resolvable owner, and reject malformed tokens or
 * orphaned projects with 401.
 *
 * Run: bun test apps/api/src/__tests__/ai-proxy-runtime-token.test.ts
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'

const VALID_PROJECT_ID = 'proj_with_owner'
const ORPHAN_PROJECT_ID = 'proj_orphan'

mock.module(
  '../lib/prisma',
  () =>
    withPrismaExports({
      prisma: {
        project: {
          findUnique: async (args: any) => {
            if (args?.where?.id === VALID_PROJECT_ID) {
              return {
                id: VALID_PROJECT_ID,
                workspaceId: 'ws_1',
                members: [{ userId: 'user_owner' }],
                workspace: { members: [{ userId: 'ws_owner' }] },
              }
            }
            if (args?.where?.id === ORPHAN_PROJECT_ID) {
              return {
                id: ORPHAN_PROJECT_ID,
                workspaceId: 'ws_1',
                members: [],
                workspace: { members: [] },
              }
            }
            return null
          },
          findFirst: async () => ({ id: VALID_PROJECT_ID, name: 'Test' }),
        },
        usageEvent: {
          create: async () => ({}),
        },
        usageWallet: {
          findUnique: async () => ({
            workspaceId: 'ws_1',
            dailyIncludedUsd: 0.5,
            monthlyIncludedUsd: 10,
            monthlyIncludedAllocationUsd: 10,
            dailyUsedThisMonthUsd: 0,
            overageEnabled: false,
            overageHardLimitUsd: null,
            overageAccumulatedUsd: 0,
            stripeMeteredItemId: null,
            lastDailyReset: new Date(),
          }),
          create: async (data: any) => data,
        },
      },
    }),
)

const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { aiProxyRoutes } = await import('../routes/ai-proxy')

describe('AI Proxy — runtime-token (rt_v1_*) auth', () => {
  let app: Hono
  let validToken: string
  let orphanToken: string

  beforeAll(() => {
    app = new Hono()
    app.route('/api', aiProxyRoutes())
    validToken = deriveRuntimeToken(VALID_PROJECT_ID)
    orphanToken = deriveRuntimeToken(ORPHAN_PROJECT_ID)
  })

  // -------------------------------------------------------------------------
  // OpenAI-compatible (Authorization: Bearer)
  // -------------------------------------------------------------------------

  test('GET /api/ai/v1/models accepts a valid runtime token', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/models', {
        headers: { Authorization: `Bearer ${validToken}` },
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.object).toBe('list')
  })

  test('GET /api/ai/v1/models rejects a tampered runtime token (bad HMAC)', async () => {
    const tampered = validToken.slice(0, -4) + 'dead'
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/models', {
        headers: { Authorization: `Bearer ${tampered}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('GET /api/ai/v1/models rejects a runtime token whose project has no owner', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/models', {
        headers: { Authorization: `Bearer ${orphanToken}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Anthropic-native (x-api-key)
  // -------------------------------------------------------------------------

  test('POST /api/ai/anthropic/v1/messages accepts a valid runtime token via x-api-key', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/ai/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validToken,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
        }),
      }),
    )

    // Auth passed if the response is anything other than 401.
    // Without ANTHROPIC_API_KEY in the test env, the proxy short-circuits
    // with 503 ("not configured") — that's the documented success
    // signature in the existing route-handler tests.
    expect(res.status).not.toBe(401)
  })

  test('POST /api/ai/anthropic/v1/messages rejects a tampered runtime token', async () => {
    const tampered = validToken.slice(0, -4) + 'dead'
    const res = await app.fetch(
      new Request('http://localhost/api/ai/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': tampered,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 10,
        }),
      }),
    )
    expect(res.status).toBe(401)
  })
})
