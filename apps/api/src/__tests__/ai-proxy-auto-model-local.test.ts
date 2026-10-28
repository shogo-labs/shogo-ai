// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * AI Proxy — `model: "auto"` against a local LLM backend (SHO-166, AC4c).
 *
 * `isLocalDev` is a module-level constant in `ai-proxy.ts`, so the
 * Ollama-style branch can only be exercised from a file that turns local mode
 * on before the router is imported. Kept separate from
 * `ai-proxy-auto-model.test.ts`, which runs the cloud-shaped defaults.
 *
 *   bun test apps/api/src/__tests__/ai-proxy-auto-model-local.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'auto-model-local-test-secret'
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434'
process.env.LOCAL_LLM_BASIC_MODEL = 'qwen2.5:3b'
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
delete process.env.AI_MODE

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    platformSetting: { findUnique: async () => null, findMany: async () => [] },
    localConfig: { findUnique: async () => null },
    modelDefinition: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    workspaceModelVisibility: { findMany: async () => [] },
    usageEvent: { create: async () => ({}) },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  ensureSystemWorkspace: async () => {},
  hasBalance: async () => true,
  hasAdvancedModelAccess: async () => true,
  checkUsageBalance: async () => ({ ok: true, remainingIncludedUsd: 100 }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'usage limit reached' }),
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => null,
  getUsageWallet: async () => null,
}))

const billingRuntime = await import('../services/billing-runtime')
mock.module('../services/billing-runtime', () => ({
  ...billingRuntime,
  hasAdvancedModelAccess: async () => true,
}))

mock.module('../lib/proxy-capture', () => ({
  beginCapture: async () => null,
  updateTurnFeedback: async () => {},
  markProjectTurnsReverted: async () => {},
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: () => {},
  accumulateImageUsage: () => {},
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({ getProjectUser: () => 'user-1' }))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
  wipeCloudKeyIfRejected: async () => ({ wiped: false }),
}))

const originalFetch = globalThis.fetch
let fetchCalls: { url: string; init?: RequestInit }[] = []

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    fetchCalls.push({ url, init })
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    return new Response(JSON.stringify({
      id: 'cmpl_local',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as any
})

afterAll(() => { globalThis.fetch = originalFetch })

const { Hono } = await import('hono')
const { aiProxyRoutes, resolveRequestModel } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')

let TOKEN = ''
beforeAll(async () => {
  TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
})

beforeEach(() => { fetchCalls = [] })

describe('auto against a local LLM backend', () => {
  // AC4c
  test('resolveRequestModel maps auto to LOCAL_LLM_BASIC_MODEL', async () => {
    const { resolvedModel, isLocal } = await resolveRequestModel('auto', 'ws-1')
    expect(resolvedModel).toBe('qwen2.5:3b')
    expect(isLocal).toBe(true)
  })

  // AC4c, end to end
  test('chat/completions sends auto to the local endpoint as the local model', async () => {
    const app = new Hono()
    app.route('/api', aiProxyRoutes())

    const res = await app.fetch(new Request('http://x/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    }))

    expect(res.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('http://localhost:11434/v1/chat/completions')
    expect(JSON.parse(String(fetchCalls[0].init?.body)).model).toBe('qwen2.5:3b')
  })
})
