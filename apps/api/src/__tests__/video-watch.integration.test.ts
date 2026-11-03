// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * Video input — the agent turn (real OpenRouter, real agent loop).
 *
 * This is the "an agent that can watch video and comment on it" acceptance
 * test: a real agent loop on GLM 5.3 Flash, real `read_file` tools, a real
 * local AI proxy, and a real OpenRouter call. Two clips are in the workspace
 * and the prompt asks how they differ; the test asserts the agent read both
 * files and that the answer names the red square moving right and the blue
 * square moving up.
 *
 * It lives here (rather than in packages/agent-runtime) because it mounts
 * `aiProxyRoutes` in-process — the same arrangement as
 * `ai-proxy-audio-e2e.test.ts`'s full-chain case — which is what makes the
 * `image_url` → `video_url` bridge part of the tested path.
 *
 * Skipped entirely when OPENROUTER_API_KEY is unset. Costs about $0.002.
 *
 * Run: OPENROUTER_API_KEY=sk-or-... bun test apps/api/src/__tests__/video-watch.integration.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateProxyToken } from '../lib/ai-proxy-token'

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'video-watch-project', name: 'Video Watch' }),
      findUnique: async () => ({ id: 'video-watch-project', workspaceId: 'video-watch-workspace' }),
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
  getSession: () => undefined,
  openSession: () => null,
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'video-watch-user',
}))

import { aiProxyRoutes } from '../routes/ai-proxy'
import { createTools } from '@shogo/agent-runtime/src/gateway-tools'
import { runAgentLoop } from '@shogo/agent-runtime/src/agent-loop'
import { clearDynamicModels, registerDynamicModels } from '@shogo/model-catalog'

const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY
const MODEL_ID = 'openrouter:z-ai/glm-5.3-flash'
const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'video')

describe('an agent watches two videos and comments on them (real OpenRouter)', () => {
  let workspaceDir: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let proxyToken = ''

  beforeAll(async () => {
    workspaceDir = mkdtempSync(join(realpathSync(tmpdir()), 'shogo-video-watch-'))
    writeFileSync(join(workspaceDir, 'a.mp4'), readFileSync(join(FIXTURE_DIR, 'red-right.mp4')))
    writeFileSync(join(workspaceDir, 'b.mp4'), readFileSync(join(FIXTURE_DIR, 'blue-up.mp4')))

    // read_file decides whether it may hand the bytes over from
    // `ctx.effectiveModel`; the same dynamic entry also gives resolveModel the
    // context window it would get from the API's AGENT_MODEL_REGISTRY.
    registerDynamicModels([
      { id: MODEL_ID, provider: 'custom', apiModel: 'z-ai/glm-5.3-flash', supportsVideoInput: true },
    ])

    if (hasOpenRouterKey) {
      const app = new Hono()
      app.route('/api', aiProxyRoutes())
      server = Bun.serve({ port: 0, fetch: app.fetch })
      proxyToken = await generateProxyToken('video-watch-project', 'video-watch-workspace', 'video-watch-user')
      // The agent talks to the local proxy with the proxy token; the proxy
      // talks to OpenRouter with OPENROUTER_API_KEY, which stays untouched.
      process.env.OPENAI_BASE_URL = `http://localhost:${server.port}/api/ai/v1`
      process.env.OPENAI_API_KEY = proxyToken
    }
  })

  test(
    'read_file on both clips, and a reply that names red→right and blue→up',
    async () => {
      if (!hasOpenRouterKey) {
        console.log('[Video Watch] Skipping — OPENROUTER_API_KEY not set')
        return
      }

      const toolCalls: Array<{ name: string; input: any }> = []
      const tools = createTools({
        workspaceDir,
        channels: new Map(),
        config: {
          heartbeatInterval: 1800,
          heartbeatEnabled: false,
          quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
          channels: [],
          model: { provider: 'custom', name: MODEL_ID },
        },
        projectId: 'video-watch',
        effectiveModel: MODEL_ID,
      } as any)
      const readFile = tools.find((t) => t.name === 'read_file')
      if (!readFile) throw new Error('read_file tool not registered')

      const result = await runAgentLoop({
        provider: 'custom',
        model: MODEL_ID,
        apiKey: proxyToken,
        system:
          'You are a test agent. Use read_file to watch files. ' +
          'Describe what each video shows: the shape, its colour, and the direction it moves.',
        history: [],
        prompt: 'Watch a.mp4 and b.mp4 and tell me how they differ.',
        tools: [readFile],
        maxIterations: 6,
        onToolCall: (name, input) => toolCalls.push({ name, input }),
      })

      console.log(`[Video Watch] tool calls: ${JSON.stringify(toolCalls.map((c) => c.input))}`)
      console.log(`[Video Watch] reply: ${result.text}`)

      const readPaths = toolCalls.filter((c) => c.name === 'read_file').map((c) => String(c.input?.path ?? ''))
      expect(readPaths.some((p) => p.includes('a.mp4'))).toBe(true)
      expect(readPaths.some((p) => p.includes('b.mp4'))).toBe(true)

      const lower = result.text.toLowerCase()
      expect(lower).toContain('red')
      expect(lower).toMatch(/right|left to right|left-to-right/)
      expect(lower).toContain('blue')
      expect(lower).toMatch(/up|bottom to top|bottom-to-top|upward/)
    },
    240_000,
  )

  test('cleanup', () => {
    server?.stop(true)
    clearDynamicModels()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
  })
})
