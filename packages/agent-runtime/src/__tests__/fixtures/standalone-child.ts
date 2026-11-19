// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Child process for the standalone-runtime integration test (SHO-418).
 *
 * Boots the real server in standalone mode against a mock OpenAI-compatible
 * endpoint, then reports readiness on stdout so the parent can drive it:
 *
 *   READY <port>          the mock model endpoint is listening
 *   GATEWAY               the agent gateway is up
 *   TURN_STARTED          a chat turn is streaming
 *
 * The parent sends SIGTERM while the turn is still open and measures how long
 * the process takes to exit, which is the documented drain bound.
 *
 * Not a test file: `run-tests-isolated.ts` only picks up `*.test.ts`.
 */

import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const workspace = mkdtempSync(join('/tmp', 'shogo-standalone-child-'))
mkdirSync(join(workspace, '.shogo'), { recursive: true })

/** Each model call streams slowly, so the turn is still open when SIGTERM lands. */
const CHUNK_DELAY_MS = 250
const CHUNKS_PER_CALL = 12

const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
    await req.json()
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (delta: unknown, finish: string | null = null) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'chatcmpl-child',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'qwen3-coder',
                choices: [{ index: 0, delta, finish_reason: finish }],
              })}\n\n`,
            ),
          )
        send({ role: 'assistant', content: '' })
        for (let i = 0; i < CHUNKS_PER_CALL; i++) {
          send({ content: `chunk ${i} ` })
          await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS))
        }
        send({}, 'stop')
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})

process.env.WORKSPACE_DIR = workspace
process.env.SHOGO_STANDALONE = '1'
process.env.RUNTIME_AUTH_SECRET = 'child-secret'
process.env.AGENT_MODEL = 'local:qwen3-coder'
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.port}/v1`
process.env.OPENAI_API_KEY = 'local'
process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.NODE_ENV = 'production'
process.env.PROJECT_ID = 'standalone'
delete process.env.SHOGO_API_URL
delete process.env.API_URL
delete process.env.AI_PROXY_URL

console.log(`READY ${mock.port}`)

const server = (await import('../../server')).default

for (let i = 0; i < 120; i++) {
  const res = (await server.fetch(new Request('http://runtime.test/health'), {} as any))!
  const body = (await res.json()) as { gateway?: { running?: boolean } }
  if (body.gateway?.running) break
  await new Promise((r) => setTimeout(r, 250))
}
console.log('GATEWAY')

const res = (await server.fetch(
  new Request('http://runtime.test/agent/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer child-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      chatSessionId: 'child-chat',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'say something long' }] }],
    }),
  }),
  {} as any,
))!
console.log(`TURN_STARTED ${res.status}`)

// Drain the stream so the turn stays active until the parent's SIGTERM.
const reader = res.body!.getReader()
for (;;) {
  const { done } = await reader.read()
  if (done) break
}
console.log('TURN_FINISHED')
