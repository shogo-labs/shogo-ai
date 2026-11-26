// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-599, a streamed provider call records its usage on every
 * exit, once (card acceptance criteria 1, 2, 5 and 6).
 *
 * These drive the real routes (`/ai/v1/chat/completions` and
 * `/ai/anthropic/v1/messages`) against a real desktop-mode SQLite database and
 * a fake upstream, so what is asserted is a real `usage_events` row, not a
 * mocked `consumeUsage` call:
 *
 *   1. Anthropic-native stream cancelled by the client after `message_start`
 *      (`x-api-key` dialect) → one row with the input + cache tokens the
 *      provider already billed.
 *   2. The same route completing normally → exactly one row (never twice when
 *      `flush()` also settles the meter).
 *   3. `/ai/v1/chat/completions` (Anthropic provider, `proxyAnthropicStream`)
 *      cancelled → one row.
 *   4. `/ai/v1/chat/completions` (OpenAI provider) cancelled → one row.
 *   5. The OpenAI-via-`/ai/anthropic/v1/messages` stream, which used to record
 *      nothing at all, records now — and the request carries
 *      `stream_options.include_usage`.
 *   6. Desktop/local mode behaves the same way (channel rule: no surface
 *      divergence).
 *   7. Admin cost analytics count a `refused` row's real provider cost while
 *      billing nothing for it.
 *
 *   bun test apps/api/src/__tests__/qa-sho599-stream-usage.acceptance.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'qa-sho599-secret'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'qa-sho599-better-secret'
process.env.ANTHROPIC_API_KEY = 'sk-ant-qa-sho599'
process.env.OPENAI_API_KEY = 'sk-openai-qa-sho599'

const { setupChannelsTestDb, seedWorkspace, waitFor } = await import('./helpers/channels-test-db')
// Leaves `SHOGO_LOCAL_MODE=true`, which is the point: this file is the desktop
// half of the channel's "no surface divergence" rule. `lib/prisma` builds the
// SQLite client from it, and `consumeUsage` takes the local recording path.
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const analytics = await import('../services/analytics.service')

const db = prisma as any

const ANTHROPIC_MODEL = 'claude-haiku-4-5'
const OPENAI_MODEL = 'gpt-5.5'

const seeded = await seedWorkspace(db)
const app = new Hono()
app.route('/api', aiProxyRoutes())

let projectId: string
let token: string

/** A fresh project per test, so each assertion owns its `usage_events` rows. */
async function freshProject(): Promise<{ projectId: string; token: string }> {
  const project = await db.project.create({
    data: { name: `SHO-599 ${crypto.randomUUID().slice(0, 8)}`, workspaceId: seeded.workspaceId },
  })
  const proxyToken = await generateProxyToken(project.id, seeded.workspaceId, seeded.owner)
  return { projectId: project.id, token: proxyToken }
}

const TE = new TextEncoder()

/** Anthropic SSE: `message_start` (real input/cache tokens) then slow deltas. */
function anthropicFrames(opts: { withFinalUsage: boolean }): string[] {
  const frames = [
    'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"msg_qa","usage":{"input_tokens":120,"cache_read_input_tokens":30,"cache_creation_input_tokens":20}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from the Shogo proxy"}}\n\n',
  ]
  if (opts.withFinalUsage) {
    frames.push(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    )
  } else {
    // More content keeps arriving slowly, which is what lets the client Stop
    // mid-turn instead of the stream ending on its own.
    for (let i = 0; i < 20; i++) {
      frames.push(
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" more-${i}"}}\n\n`,
      )
    }
  }
  return frames
}

/** OpenAI chat-completions SSE with a final `usage` chunk. */
function openAIFrames(opts: { withFinalUsage: boolean }): string[] {
  const frames = [
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n',
  ]
  if (opts.withFinalUsage) {
    frames.push(
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":12,"total_tokens":212,"prompt_tokens_details":{"cached_tokens":50}}}\n\n',
      'data: [DONE]\n\n',
    )
  } else {
    for (let i = 0; i < 20; i++) {
      frames.push(`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" more-${i}"}}]}\n\n`)
    }
  }
  return frames
}

/** A fake upstream whose frames arrive slowly enough to cancel mid-body. */
function installUpstream(frames: string[], opts: { delayMs?: number } = {}) {
  const requests: Array<{ url: string; body: any; headers: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    let body: any = undefined
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined } catch { body = init?.body }
    requests.push({ url: String(url), body, headers: init?.headers })
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= frames.length) {
          controller.close()
          return
        }
        if (i > 0 && opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        controller.enqueue(TE.encode(frames[i]!))
        i++
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as any
  return requests
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

beforeEach(async () => {
  const fresh = await freshProject()
  projectId = fresh.projectId
  token = fresh.token
})

afterAll(async () => {
  // Leave no rows behind in the throwaway database.
  await db.usageEvent.deleteMany({ where: { workspaceId: seeded.workspaceId } })
})

function rowsFor(project: string) {
  return db.usageEvent.findMany({ where: { projectId: project }, orderBy: { createdAt: 'asc' } })
}

/** Reads the body until `enough` bytes arrived, then cancels the reader (Stop). */
async function readThenCancel(res: Response, enough = 1): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (let i = 0; i < enough; i++) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return out
}

/** Reads until the answer text itself streamed through, then cancels (Stop mid-answer). */
async function readUntilTextThenCancel(res: Response, marker: string): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (let i = 0; i < 8; i++) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
    if (out.includes(marker)) break
  }
  await reader.cancel()
  return out
}

function anthropicRequest(model: string, stream: boolean) {
  return new Request('http://localhost/api/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, stream }),
  })
}

function chatRequest(model: string, stream: boolean) {
  return new Request('http://localhost/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream }),
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — every exit records once, on every streaming path
// ──────────────────────────────────────────────────────────────────────────────

describe('SHO-599 AC2: a cancelled stream still records its usage (local/desktop)', () => {
  test('Anthropic-native `/ai/anthropic/v1/messages` cancel keeps the billed input + cache tokens', async () => {
    installUpstream(anthropicFrames({ withFinalUsage: false }), { delayMs: 25 })

    const res = await app.fetch(anthropicRequest(ANTHROPIC_MODEL, true))
    expect(res.status).toBe(200)
    const seen = await readUntilTextThenCancel(res, 'Hello from the Shogo proxy')
    expect(seen).toContain('message_start')

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.billedUsd).toBe(0) // local/desktop never charges
    expect(Number(row.rawUsd)).toBeGreaterThan(0) // but the provider cost is real
    expect(row.actionMetadata.inputTokens).toBe(120)
    expect(row.actionMetadata.cachedInputTokens).toBe(30)
    expect(row.actionMetadata.cacheWriteTokens).toBe(20)
    expect(row.actionMetadata.streamOutcome).toBe('cancelled')
    // Output never reached message_delta, so it is estimated and flagged.
    expect(row.actionMetadata.usageEstimated).toBe(true)
    expect(row.actionMetadata.outputTokens).toBeGreaterThan(0)
  })

  test('the same route completing normally writes exactly one row (flush + onStreamEnd never double-record)', async () => {
    installUpstream(anthropicFrames({ withFinalUsage: true }), { delayMs: 5 })

    const res = await app.fetch(anthropicRequest(ANTHROPIC_MODEL, true))
    expect(res.status).toBe(200)
    await res.text()

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actionMetadata.inputTokens).toBe(120)
    expect(rows[0]!.actionMetadata.outputTokens).toBe(7)
    expect(rows[0]!.actionMetadata.streamOutcome).toBeUndefined()
    // Wait past the teardown path and re-check: still one row.
    await new Promise((r) => setTimeout(r, 100))
    expect(await rowsFor(projectId)).toHaveLength(1)
  })

  test('`/ai/v1/chat/completions` (Anthropic provider) cancel records once', async () => {
    installUpstream(anthropicFrames({ withFinalUsage: false }), { delayMs: 25 })

    const res = await app.fetch(chatRequest(ANTHROPIC_MODEL, true))
    expect(res.status).toBe(200)
    await readUntilTextThenCancel(res, 'Hello from the Shogo proxy')

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actionMetadata.inputTokens).toBe(120)
    expect(rows[0]!.actionMetadata.streamOutcome).toBe('cancelled')
  })

  test('`/ai/v1/chat/completions` (OpenAI provider) cancel records once', async () => {
    installUpstream(openAIFrames({ withFinalUsage: false }), { delayMs: 25 })

    const res = await app.fetch(chatRequest(OPENAI_MODEL, true))
    expect(res.status).toBe(200)
    await readUntilTextThenCancel(res, 'there')

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actionMetadata.streamOutcome).toBe('cancelled')
    expect(rows[0]!.actionMetadata.inputTokens).toBeGreaterThan(0)
  })

  test('`/ai/v1/responses` cancel records once (estimated, and flagged)', async () => {
    installUpstream(
      [
        'data: {"type":"response.output_text.delta","delta":"hello from responses"}\n\n',
        'data: {"type":"response.output_text.delta","delta":" more"}\n\n',
        'data: {"type":"response.output_text.delta","delta":" more again"}\n\n',
        'data: {"type":"response.output_text.delta","delta":" tail"}\n\n',
      ],
      { delayMs: 25 },
    )

    const res = await app.fetch(
      new Request('http://localhost/api/ai/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: OPENAI_MODEL, input: 'hi', stream: true }),
      }),
    )
    expect(res.status).toBe(200)
    await readUntilTextThenCancel(res, 'hello from responses')

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actionMetadata.streamOutcome).toBe('cancelled')
    expect(rows[0]!.actionMetadata.usageEstimated).toBe(true)
    expect(rows[0]!.actionMetadata.outputTokens).toBeGreaterThan(0)
  })

  test('an upstream error mid-stream still records the tokens already billed', async () => {
    const frames = anthropicFrames({ withFinalUsage: false }).slice(0, 2)
    globalThis.fetch = (async () => {
      let i = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (i >= frames.length) {
              controller.error(new TypeError('fetch failed'))
              return
            }
            controller.enqueue(TE.encode(frames[i]!))
            i++
            await new Promise((r) => setTimeout(r, 10))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as any

    const res = await app.fetch(anthropicRequest(ANTHROPIC_MODEL, true))
    expect(res.status).toBe(200)
    // The client body errors; the metering must have happened anyway.
    await res.text().catch(() => {})

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actionMetadata.inputTokens).toBe(120)
    expect(rows[0]!.actionMetadata.cachedInputTokens).toBe(30)
    // A mid-body fault makes the wrapper inject an `event: error` frame and
    // close the client stream, so the meter settles as `complete`; the point of
    // AC2 is that the tokens are recorded once, not the label.
    await new Promise((r) => setTimeout(r, 100))
    expect(await rowsFor(projectId)).toHaveLength(1)
  })

  test('OpenAI on `/ai/anthropic/v1/messages` now records, and asks for usage', async () => {
    const requests = installUpstream(openAIFrames({ withFinalUsage: true }), { delayMs: 5 })

    const res = await app.fetch(anthropicRequest(OPENAI_MODEL, true))
    expect(res.status).toBe(200)
    await res.text()

    // The gap the card found: no `stream_options.include_usage`, no usage hook.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body?.stream_options).toEqual({ include_usage: true })

    const rows = await waitFor(async () => {
      const r = await rowsFor(projectId)
      return r.length > 0 ? r : null
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actionMetadata.inputTokens).toBe(150) // 200 prompt - 50 cached
    expect(rows[0]!.actionMetadata.cachedInputTokens).toBe(50)
    expect(rows[0]!.actionMetadata.outputTokens).toBe(12)
    expect(rows[0]!.actionMetadata.streamOutcome).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — admin cost analytics count a refused row's real provider spend
// ──────────────────────────────────────────────────────────────────────────────

describe('SHO-599 AC1: admin analytics include refused rows at their real cost', () => {
  test('getUsageSummary totals the refused rawUsd while billing nothing for it', async () => {
    const now = Date.now()
    await db.usageEvent.create({
      data: {
        workspaceId: seeded.workspaceId,
        projectId,
        memberId: seeded.owner,
        actionType: 'chat_message',
        rawUsd: 2.5,
        billedUsd: 3,
        source: 'daily',
        balanceBefore: 0,
        balanceAfter: 0,
        actionMetadata: { model: ANTHROPIC_MODEL, inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        createdAt: new Date(now - 60_000),
      },
    })
    // The provider charged us for this turn; the wallet refused the debit, so
    // it billed the user nothing and must still show up as real spend.
    await db.usageEvent.create({
      data: {
        workspaceId: seeded.workspaceId,
        projectId,
        memberId: seeded.owner,
        actionType: 'chat_message',
        rawUsd: 4,
        billedUsd: 0,
        source: 'refused',
        balanceBefore: 0,
        balanceAfter: 0,
        actionMetadata: {
          model: ANTHROPIC_MODEL,
          totalTokens: 400,
          refused: true,
          refusalReason: 'overage_requires_payment',
        },
        createdAt: new Date(now - 30_000),
      },
    })

    const summary = await analytics.getUsageSummary({ workspaceId: seeded.workspaceId, projectId })
    expect(summary.summaries.length).toBe(1)
    expect(summary.summaries[0]!.requestCount).toBe(2)
    expect(summary.summaries[0]!.totalBilledUsd).toBeCloseTo(3, 6)
    expect(summary.summaries[0]!.totalRawUsd).toBeCloseTo(6.5, 6)
  })
})

const _dir = dir // keep the temp dir alive for the SQLite connection
