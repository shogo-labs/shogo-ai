// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests: streaming + tab-switch resume contract.
 *
 * Mirrors the server.ts transport contract:
 *   POST /agent/chat             → start a stream (buffered in-memory, client
 *                                   receives a replay stream so a client
 *                                   disconnect doesn't cancel the "agent")
 *   GET  /agent/chat/:id/stream  → reconnect; returns 204 if no active buffer,
 *                                   else replay buffered chunks + live tail
 *   POST /agent/stop             → abort buffer so future GETs return 204
 *
 * These tests exercise the contract end-to-end by calling the Hono app's
 * `.fetch()` directly (no localhost roundtrip) against a deterministic mock
 * "agent" generator so we can assert exact bytes without needing an LLM.
 * Using `app.fetch()` instead of `Bun.serve + global fetch` also keeps us
 * isolated from other tests in the suite that monkey-patch `global.fetch`.
 *
 * Scenarios covered:
 *   1. Basic streaming still works (no tab switching).
 *   2. Tab switch mid-stream → reconnect replays buffered chunks + live tail.
 *   3. Rapid disconnect/reconnect cycles retain full coverage (no dropped chunks).
 *   4. Concurrent tabs / chat sessions don't cross-contaminate.
 *   5. Stop (abort) → subsequent resume returns 204.
 *   6. Late reconnect after completion still replays full content.
 *   7. Resume on unknown session returns 204.
 *   8. Client disconnect doesn't cancel the underlying "agent" work.
 *   9. New POST for same session replaces the buffer (fresh turn).
 *  10. Two subscribers on a live stream both receive full content.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { StreamBufferStore } from '../stream-buffer'

// ---------------------------------------------------------------------------
// Test harness: minimal Hono app mirroring server.ts's chat/resume contract.
// ---------------------------------------------------------------------------

interface ChatHarness {
  app: Hono
  store: StreamBufferStore
  /** How many chunks each mock-agent "turn" should emit. */
  chunksPerTurn: number
  /** Delay (ms) between chunks so tests have time to disconnect/reconnect. */
  chunkDelayMs: number
  /** Resolves when the background agent work for `sessionId` finishes. */
  agentDone: Map<string, Promise<void>>
  /** Send a request to the Hono app without going over the network. */
  request(path: string, init?: RequestInit): Promise<Response>
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Deterministic "agent" stream — emits `count` chunks with a delay between each. */
function makeAgentStream(
  sessionId: string,
  count: number,
  delayMs: number,
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= count) {
        controller.close()
        return
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      controller.enqueue(encode(`${sessionId}:chunk-${i}\n`))
      i++
    },
  })
}

function createChatHarness(opts?: {
  chunksPerTurn?: number
  chunkDelayMs?: number
}): ChatHarness {
  const store = new StreamBufferStore()
  const app = new Hono()
  const chunksPerTurn = opts?.chunksPerTurn ?? 6
  const chunkDelayMs = opts?.chunkDelayMs ?? 15
  const agentDone = new Map<string, Promise<void>>()

  // POST /agent/chat → start stream, return replay-backed response.
  app.post('/agent/chat', async (c) => {
    const body = await c.req.json<{ chatSessionId?: string }>().catch(() => ({} as { chatSessionId?: string }))
    const sessionId = body.chatSessionId || 'chat'

    // Replace any existing buffer for this key.
    const bufWriter = store.create(sessionId)
    const agentStream = makeAgentStream(sessionId, chunksPerTurn, chunkDelayMs)

    // Background reader: decouples agent work from HTTP connection.
    const reader = agentStream.getReader()
    const done = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bufWriter.append(value)
        }
      } finally {
        bufWriter.complete()
      }
    })()
    agentDone.set(sessionId, done)

    const replayStream = store.createReplayStream(sessionId)
    if (!replayStream) {
      return c.json({ error: 'no buffer' }, 500)
    }
    return new Response(replayStream, {
      status: 200,
      headers: { 'Content-Type': 'text/x-ai-sdk-ui-stream' },
    })
  })

  // GET /agent/chat/:sessionId/stream → reconnect.
  app.get('/agent/chat/:sessionId/stream', (c) => {
    const sessionId = c.req.param('sessionId')
    const replayStream = store.createReplayStream(sessionId)
    if (!replayStream) return new Response(null, { status: 204 })
    return new Response(replayStream, {
      status: 200,
      headers: { 'Content-Type': 'text/x-ai-sdk-ui-stream' },
    })
  })

  // POST /agent/stop → abort buffer, future GETs return 204.
  app.post('/agent/stop', async (c) => {
    const body = await c.req.json<{ chatSessionId?: string }>().catch(() => ({} as { chatSessionId?: string }))
    const sessionId = body.chatSessionId || 'chat'
    store.abort(sessionId)
    return c.json({ stopped: true })
  })

  // Call the Hono app directly — avoids spinning up a real TCP server and
  // sidesteps any test-wide monkey-patching of `global.fetch`.
  const request = (path: string, init?: RequestInit): Promise<Response> => {
    const url = `http://harness.local${path}`
    return Promise.resolve(app.fetch(new Request(url, init)))
  }

  return {
    app,
    store,
    chunksPerTurn,
    chunkDelayMs,
    agentDone,
    request,
  }
}

async function readText(
  stream: ReadableStream<Uint8Array>,
  opts: { maxChunks?: number; maxMs?: number } = {},
): Promise<{ text: string; done: boolean; chunks: number }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let chunks = 0
  const deadline = opts.maxMs ? Date.now() + opts.maxMs : undefined
  try {
    while (true) {
      if (opts.maxChunks && chunks >= opts.maxChunks) {
        return { text, done: false, chunks }
      }
      if (deadline && Date.now() >= deadline) {
        return { text, done: false, chunks }
      }
      const readPromise = reader.read()
      const { done, value } = deadline
        ? await Promise.race([
            readPromise,
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(
                () => r({ done: true, value: undefined }),
                Math.max(0, deadline - Date.now()),
              ),
            ),
          ])
        : await readPromise
      if (done) return { text, done: true, chunks }
      text += decoder.decode(value, { stream: true })
      chunks++
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* noop */
    }
    reader.releaseLock()
  }
}

function expectedFullPayload(sessionId: string, chunks: number): string {
  let s = ''
  for (let i = 0; i < chunks; i++) s += `${sessionId}:chunk-${i}\n`
  return s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streaming + tab-switch resume', () => {
  let h: ChatHarness

  beforeEach(() => {
    h = createChatHarness({ chunksPerTurn: 6, chunkDelayMs: 15 })
  })

  afterEach(async () => {
    // Let any still-running mock-agent tasks drain so delayed-chunk timers
    // don't leak into later tests.
    await Promise.allSettled(Array.from(h.agentDone.values()))
    h.store.dispose()
  })

  test('happy path: streaming still works end-to-end', async () => {
    const res = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: 'sess-basic' }),
    })
    expect(res.ok).toBe(true)
    expect(res.body).not.toBeNull()

    const { text, done, chunks } = await readText(res.body!)
    expect(done).toBe(true)
    expect(chunks).toBe(h.chunksPerTurn)
    expect(text).toBe(expectedFullPayload('sess-basic', h.chunksPerTurn))
  })

  test('tab switch mid-stream: reconnect replays buffered + delivers live tail', async () => {
    const sess = 'sess-tabswitch'

    // 1. "Open tab A" — start stream, read first few chunks.
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)
    const partial = await readText(res1.body!, { maxChunks: 2 })
    expect(partial.chunks).toBe(2)
    expect(partial.done).toBe(false)

    // 2. "Switch tabs" — the reader was cancelled in readText's finally,
    //    which simulates the client dropping its HTTP connection. The
    //    background agent keeps producing into the buffer.

    // 3. "Switch back" — reconnect via GET /stream. The replay must include
    //    everything from the start of the turn (buffered chunks + live tail).
    const res2 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res2.status).toBe(200)
    expect(res2.body).not.toBeNull()

    const tail = await readText(res2.body!, { maxMs: 5_000 })
    expect(tail.done).toBe(true)
    expect(tail.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))
  })

  test('rapid disconnect/reconnect cycles: no chunks lost across multiple tab flips', async () => {
    const sess = 'sess-pingpong'
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)
    await readText(res1.body!, { maxChunks: 1 })

    const res2 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res2.status).toBe(200)
    await readText(res2.body!, { maxChunks: 2 })

    const res3 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res3.status).toBe(200)
    await readText(res3.body!, { maxChunks: 3 })

    // Final reconnect — must read the full payload from the start.
    const res4 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res4.status).toBe(200)
    const final = await readText(res4.body!, { maxMs: 5_000 })
    expect(final.done).toBe(true)
    expect(final.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))
  })

  test('concurrent sessions: two tabs streaming at once stay isolated', async () => {
    const [resA, resB] = await Promise.all([
      h.request('/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatSessionId: 'sess-A' }),
      }),
      h.request('/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatSessionId: 'sess-B' }),
      }),
    ])
    expect(resA.ok).toBe(true)
    expect(resB.ok).toBe(true)

    const [a, b] = await Promise.all([
      readText(resA.body!, { maxMs: 5_000 }),
      readText(resB.body!, { maxMs: 5_000 }),
    ])

    expect(a.done).toBe(true)
    expect(b.done).toBe(true)
    expect(a.text).toBe(expectedFullPayload('sess-A', h.chunksPerTurn))
    expect(b.text).toBe(expectedFullPayload('sess-B', h.chunksPerTurn))
    expect(a.text).not.toContain('sess-B')
    expect(b.text).not.toContain('sess-A')
  })

  test('concurrent subscribers on the same session each get full replay', async () => {
    const sess = 'sess-multi-sub'
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)

    const res2 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res2.status).toBe(200)

    const [t1, t2] = await Promise.all([
      readText(res1.body!, { maxMs: 5_000 }),
      readText(res2.body!, { maxMs: 5_000 }),
    ])
    expect(t1.done).toBe(true)
    expect(t2.done).toBe(true)
    expect(t1.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))
    expect(t2.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))
  })

  test('stop mid-stream: subsequent resume returns 204', async () => {
    const sess = 'sess-stop'
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)
    await readText(res1.body!, { maxChunks: 1 })

    const stopRes = await h.request('/agent/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(stopRes.ok).toBe(true)

    const resumeRes = await h.request(`/agent/chat/${sess}/stream`)
    expect(resumeRes.status).toBe(204)
  })

  test('resume on unknown session returns 204', async () => {
    const res = await h.request('/agent/chat/nonexistent-session/stream')
    expect(res.status).toBe(204)
  })

  test('late reconnect after completion still replays full content', async () => {
    const sess = 'sess-late'
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)

    const first = await readText(res1.body!, { maxMs: 5_000 })
    expect(first.done).toBe(true)
    expect(first.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))

    // Reconnect — buffer is still within the completed-grace window, so
    // the replay should return the entire payload and then close.
    const res2 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res2.status).toBe(200)
    const second = await readText(res2.body!, { maxMs: 5_000 })
    expect(second.done).toBe(true)
    expect(second.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))
  })

  test('client disconnect does not cancel the underlying agent work', async () => {
    const sess = 'sess-disconnect'
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)
    await readText(res1.body!, { maxChunks: 1 })
    // `readText`'s `finally` cancelled the reader → socket torn down.

    // Wait for the mock agent to finish (all chunks should have been
    // appended to the buffer regardless of the client disconnect).
    await h.agentDone.get(sess)

    // Any reconnect now should see the ENTIRE payload.
    const res2 = await h.request(`/agent/chat/${sess}/stream`)
    expect(res2.status).toBe(200)
    const tail = await readText(res2.body!, { maxMs: 5_000 })
    expect(tail.done).toBe(true)
    expect(tail.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))
  })

  test('restart for same session replaces buffer (new POST = fresh turn)', async () => {
    const sess = 'sess-restart'

    // Turn 1 — send a message and drain fully.
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)
    const r1 = await readText(res1.body!, { maxMs: 5_000 })
    expect(r1.done).toBe(true)
    expect(r1.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))

    // Turn 2 — send a new message in the same session. The store's create()
    // contract replaces the existing buffer, so resume after a new POST
    // should show turn-2's bytes, NOT turn-1's.
    const res2 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res2.ok).toBe(true)
    const r2 = await readText(res2.body!, { maxMs: 5_000 })
    expect(r2.done).toBe(true)
    expect(r2.text).toBe(expectedFullPayload(sess, h.chunksPerTurn))

    // Fresh turn — exactly chunksPerTurn chunks, no spillover from turn 1.
    const chunkCount = (r2.text.match(/chunk-/g) || []).length
    expect(chunkCount).toBe(h.chunksPerTurn)
  })
})
