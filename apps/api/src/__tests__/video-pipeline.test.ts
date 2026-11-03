// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'
/**
 * Video input — the whole chain, no API key and no network.
 *
 * `video-watch.integration.test.ts` is the same scenario against real
 * OpenRouter, but it can only run when `OPENROUTER_API_KEY` is set, so nothing
 * executes it in CI. This file runs the identical path with a *scripted*
 * OpenAI-compatible upstream standing in for OpenRouter, which means it proves
 * the wiring unconditionally:
 *
 *   agent loop (pi-ai, openai-completions)
 *     → local AI proxy (`aiProxyRoutes`)
 *       → `OPENROUTER_BASE_URL` (scripted server in this file)
 *
 * The assertion that matters is on the bytes the proxy actually sent upstream:
 * both clips' base64 must appear under `video_url` blocks, not `image_url`.
 * pi-ai can only emit `image_url` (it has no video content type), so a green
 * run here is what proves the `image_url` → `video_url` bridge in
 * `ai-proxy.ts` is what carries the clips to OpenRouter.
 *
 * The fake upstream is scripted by request number: read a.mp4, read b.mp4,
 * then answer. That keeps the loop deterministic without a real model.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateProxyToken } from '../lib/ai-proxy-token'

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'video-pipeline-project', name: 'Video Pipeline' }),
      findUnique: async () => ({ id: 'video-pipeline-project', workspaceId: 'video-pipeline-workspace' }),
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
  getProjectUser: () => 'video-pipeline-user',
}))

import { aiProxyRoutes } from '../routes/ai-proxy'
import { createTools } from '@shogo/agent-runtime/src/gateway-tools'
import { runAgentLoop } from '@shogo/agent-runtime/src/agent-loop'
import { clearDynamicModels, registerDynamicModels } from '@shogo/model-catalog'

const MODEL_ID = 'openrouter:z-ai/glm-5.3-flash'
const API_MODEL = 'z-ai/glm-5.3-flash'
const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'video')

/** One OpenAI chat-completion SSE chunk. */
function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-scripted',
    object: 'chat.completion.chunk',
    created: 0,
    model: API_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  }
}

function sseResponse(chunks: Array<Record<string, unknown>>): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** `read_file` on `path`, streamed the way OpenAI streams a tool call. */
function readFileTurn(id: string, path: string): Response {
  return sseResponse([
    chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path }) },
        },
      ],
    }),
    chunk({}, 'tool_calls'),
  ])
}

describe('video input plumbing (scripted OpenRouter, runs with no key)', () => {
  let workspaceDir = ''
  let proxyServer: ReturnType<typeof Bun.serve> | null = null
  let upstreamServer: ReturnType<typeof Bun.serve> | null = null
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    workspaceDir = mkdtempSync(join(realpathSync(tmpdir()), 'shogo-video-pipeline-'))
    writeFileSync(join(workspaceDir, 'a.mp4'), readFileSync(join(FIXTURE_DIR, 'red-right.mp4')))
    writeFileSync(join(workspaceDir, 'b.mp4'), readFileSync(join(FIXTURE_DIR, 'blue-up.mp4')))

    registerDynamicModels([
      { id: MODEL_ID, provider: 'custom', apiModel: API_MODEL, supportsVideoInput: true },
    ])
  })

  afterAll(() => {
    proxyServer?.stop(true)
    upstreamServer?.stop(true)
    clearDynamicModels()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
  })

  test(
    'both clips reach OpenRouter as video_url blocks in a tool result',
    async () => {
      const b64A = readFileSync(join(FIXTURE_DIR, 'red-right.mp4')).toString('base64')
      const b64B = readFileSync(join(FIXTURE_DIR, 'blue-up.mp4')).toString('base64')

      // ---- scripted upstream standing in for openrouter.ai ----
      const upstreamBodies: any[] = []
      let turn = 0
      upstreamServer = Bun.serve({
        port: 0,
        async fetch(req) {
          upstreamBodies.push(await req.json())
          const script = [
            () => readFileTurn('call_a', 'a.mp4'),
            () => readFileTurn('call_b', 'b.mp4'),
            () =>
              sseResponse([
                chunk({
                  role: 'assistant',
                  content: 'Video A shows a red square moving right; video B shows a blue square moving up.',
                }),
                chunk({}, 'stop', {
                  usage: { prompt_tokens: 4000, completion_tokens: 20, total_tokens: 4020 },
                }),
              ]),
          ][Math.min(turn++, 2)]()
          return script
        },
      })

      // ---- the real proxy, mounted exactly as the API server mounts it ----
      const app = new Hono()
      app.route('/api', aiProxyRoutes())
      proxyServer = Bun.serve({ port: 0, fetch: app.fetch })

      savedEnv.OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL
      savedEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
      savedEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL
      savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY

      process.env.OPENROUTER_BASE_URL = `http://localhost:${upstreamServer.port}/api/v1`
      // Never a real key: the upstream above ignores Authorization entirely.
      process.env.OPENROUTER_API_KEY = 'sk-or-scripted-not-a-real-key'
      process.env.OPENAI_BASE_URL = `http://localhost:${proxyServer.port}/api/ai/v1`
      process.env.OPENAI_API_KEY = await generateProxyToken(
        'video-pipeline-project',
        'video-pipeline-workspace',
        'video-pipeline-user',
      )

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
        projectId: 'video-pipeline',
        effectiveModel: MODEL_ID,
      } as any)
      const readFile = tools.find((t) => t.name === 'read_file')
      if (!readFile) throw new Error('read_file tool not registered')

      const result = await runAgentLoop({
        provider: 'custom',
        model: MODEL_ID,
        apiKey: process.env.OPENAI_API_KEY!,
        system: 'You are a test agent. Use read_file to watch files.',
        history: [],
        prompt: 'Watch a.mp4 and b.mp4 and tell me how they differ.',
        tools: [readFile],
        maxIterations: 6,
        onToolCall: (name, input) => toolCalls.push({ name, input }),
      })

      // The loop did what the script said, and read_file handed the bytes over
      // instead of erroring (a video-unsupported model returns an error text
      // result, which would leave the clips out of every request below).
      const readPaths = toolCalls.filter((c) => c.name === 'read_file').map((c) => String(c.input?.path ?? ''))
      expect(readPaths.some((p) => p.includes('a.mp4'))).toBe(true)
      expect(readPaths.some((p) => p.includes('b.mp4'))).toBe(true)
      expect(result.text.toLowerCase()).toContain('red')

      // Three upstream calls: the prompt, then each tool result.
      expect(upstreamBodies.length).toBe(3)
      expect(upstreamBodies[0].model).toBe(API_MODEL)

      // The first request carries no video at all — nothing was read yet.
      expect(JSON.stringify(upstreamBodies[0])).not.toContain('data:video/')

      const afterA = JSON.stringify(upstreamBodies[1])
      expect(afterA).toContain('video_url')
      expect(afterA).toContain(b64A)
      expect(afterA).not.toContain(b64B)

      // By the last request both clips are attached, each as a video_url.
      const finalBody = upstreamBodies[2]
      const finalJson = JSON.stringify(finalBody)
      expect(finalJson).toContain(b64A)
      expect(finalJson).toContain(b64B)

      const videoBlocks = finalBody.messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((b: any) => b.type === 'video_url')
      expect(videoBlocks.length).toBe(2)
      for (const block of videoBlocks) {
        expect(block.video_url.url.startsWith('data:video/mp4;base64,')).toBe(true)
        // pi-ai's image-only shape must not survive the bridge.
        expect(block.image_url).toBeUndefined()
      }
      expect(finalJson).not.toContain('"type":"image_url"')
    },
    120_000,
  )
})
