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
 *   POST /agent/stop             → flip the agent's abort signal. The agent
 *                                   loop emits its trailing wind-down frames
 *                                   into the buffer and then completes
 *                                   naturally; the buffer is NOT torn down
 *                                   synchronously so partial-usage frames
 *                                   reach reconnecting clients.
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
 *   5. Stop mid-stream → resume drains partial body + the trailing
 *      wind-down frame the mock agent emits on abort (regression for the
 *      "tokens: 0 on stopped turn" billing bug).
 *   6. Late reconnect after completion still replays full content.
 *   7. Resume on unknown session returns 204.
 *   8. Client disconnect doesn't cancel the underlying "agent" work.
 *   9. New POST for same session replaces the buffer (fresh turn).
 *  10. Two subscribers on a live stream both receive full content.
 *  11. Client abandons the stream mid-turn (auto-resume budget exhausted /
 *      app backgrounded) WHILE the server turn keeps running. The reported
 *      "UI says disconnected but the stream is still going" bug. Asserts the
 *      condition is recoverable: `/turn` still reports `active`, and a fresh
 *      `/stream?fromSeq=N` replays only the missed delta + live tail with no
 *      duplicated and no dropped chunks.
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
  /** Per-session abort signals — flipped by `/agent/stop`. */
  agentAborts: Map<string, AbortController>
  /** Send a request to the Hono app without going over the network. */
  request(path: string, init?: RequestInit): Promise<Response>
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * Deterministic "agent" stream — emits up to `count` chunks with a delay
 * between each. If `signal` aborts mid-emission, the stream emits one final
 * `${sessionId}:winddown\n` chunk (analogous to the runtime's trailing
 * `data-usage` + `data-turn-complete{status:'aborted'}` frames) and closes.
 * Production mirrors this contract: agent-loop catches the abort, the
 * gateway sets `_lastTurnUsage`, and server.ts writes the wind-down frames
 * into the buffer before `bufWriter.complete()`.
 */
function makeAgentStream(
  sessionId: string,
  count: number,
  delayMs: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let i = 0
  let windDownEmitted = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted && !windDownEmitted) {
        windDownEmitted = true
        controller.enqueue(encode(`${sessionId}:winddown\n`))
        controller.close()
        return
      }
      if (i >= count) {
        controller.close()
        return
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      if (signal?.aborted && !windDownEmitted) {
        windDownEmitted = true
        controller.enqueue(encode(`${sessionId}:winddown\n`))
        controller.close()
        return
      }
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
  const agentAborts = new Map<string, AbortController>()

  // POST /agent/chat → start stream, return replay-backed response.
  app.post('/agent/chat', async (c) => {
    const body = await c.req.json<{ chatSessionId?: string }>().catch(() => ({} as { chatSessionId?: string }))
    const sessionId = body.chatSessionId || 'chat'

    // Per-turn abort controller — `/agent/stop` flips this, the mock agent
    // observes it, emits a wind-down chunk, and closes.
    const abortController = new AbortController()
    agentAborts.set(sessionId, abortController)

    // Replace any existing buffer for this key.
    const bufWriter = store.create(sessionId)
    const agentStream = makeAgentStream(sessionId, chunksPerTurn, chunkDelayMs, abortController.signal)

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
        agentAborts.delete(sessionId)
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

  // GET /agent/chat/:sessionId/stream → reconnect. Honors `?fromSeq=N` so a
  // client that already consumed up to seq N only receives the delta + live
  // tail (mirrors `server.ts` and `auto-resuming-fetch`).
  app.get('/agent/chat/:sessionId/stream', (c) => {
    const sessionId = c.req.param('sessionId')
    const fromSeqRaw = c.req.query('fromSeq')
    const fromSeq = fromSeqRaw ? Math.max(0, parseInt(fromSeqRaw, 10) || 0) : 0
    const snapshot = store.snapshot(sessionId)
    const replayStream = store.createReplayStream(sessionId, { fromSeq })
    if (!replayStream || !snapshot) return new Response(null, { status: 204 })
    return new Response(replayStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/x-ai-sdk-ui-stream',
        'X-Turn-Id': snapshot.turnId,
        'X-Last-Seq': String(snapshot.lastSeq),
        'X-Turn-Status': snapshot.status,
      },
    })
  })

  // GET /agent/chat/:sessionId/turn → read-only durable-turn snapshot. Mirrors
  // the runtime's `/turn` probe the client uses to decide whether to reconnect.
  app.get('/agent/chat/:sessionId/turn', (c) => {
    const sessionId = c.req.param('sessionId')
    const snapshot = store.snapshot(sessionId)
    if (!snapshot) return c.json({ status: 'unknown' as const }, 404)
    return c.json({
      chatSessionId: sessionId,
      turnId: snapshot.turnId,
      status: snapshot.status,
      lastSeq: snapshot.lastSeq,
    })
  })

  // POST /agent/stop → flip the abort signal so the agent emits its
  // wind-down frame and the buffer completes naturally. We deliberately
  // do NOT call `store.abort(sessionId)` here — mirrors the production
  // change in `packages/agent-runtime/src/server.ts` so partial-usage
  // frames are not lost.
  app.post('/agent/stop', async (c) => {
    const body = await c.req.json<{ chatSessionId?: string }>().catch(() => ({} as { chatSessionId?: string }))
    const sessionId = body.chatSessionId || 'chat'
    agentAborts.get(sessionId)?.abort()
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
    agentAborts,
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

  test('stop mid-stream: resume drains the agent wind-down frame (no partial-usage loss)', async () => {
    // Regression for the "tokens: 0 on stopped turn" bug. Production used
    // to call `store.abort()` synchronously from `/agent/stop`, which
    // killed the buffer before the agent loop could write its trailing
    // `data-usage` + `data-turn-complete{status:'aborted'}` frames. Now
    // `/agent/stop` only signals abort; the buffer completes naturally
    // once the wind-down frame lands, so reconnecting clients (and the
    // server-side billing tracker) still see the partial-usage payload.
    const sess = 'sess-stop'
    const res1 = await h.request('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(res1.ok).toBe(true)
    // Drop the original POST connection after one chunk to mirror the
    // real client cut on Stop.
    await readText(res1.body!, { maxChunks: 1 })

    const stopRes = await h.request('/agent/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: sess }),
    })
    expect(stopRes.ok).toBe(true)

    // Wait for the mock agent's wind-down to finish flushing into the
    // buffer (analogous to project-chat's auto-resume waiting on the
    // runtime's bgReader).
    await h.agentDone.get(sess)

    const resumeRes = await h.request(`/agent/chat/${sess}/stream`)
    // Buffer is preserved (in 'completed' grace window), so resume gets
    // the full replay including the trailing wind-down frame.
    expect(resumeRes.status).toBe(200)
    const tail = await readText(resumeRes.body!, { maxMs: 5_000 })
    expect(tail.done).toBe(true)
    expect(tail.text).toContain(`${sess}:winddown\n`)
    // And we got at least one real chunk before the wind-down (proving
    // the partial body was preserved).
    expect(tail.text).toContain(`${sess}:chunk-0\n`)
    // Verify the wind-down frame is the LAST line, mirroring the real
    // ordering (data-usage / data-turn-complete only fire after every
    // text-delta and tool-output the agent produced before abort).
    expect(tail.text.trim().endsWith(`${sess}:winddown`)).toBe(true)
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

  test('client abandons stream mid-turn while server keeps running: /turn stays active and fromSeq resume recovers the delta', async () => {
    // Reproduces the reported bug: the client's stream ends mid-turn (its
    // auto-resume budget exhausted, or the app was backgrounded) so the UI
    // shows "disconnected / tap Retry", but the agent is STILL running and
    // buffering frames server-side. The recovery contract the client relies
    // on must hold: `/turn` reports `active`, and `/stream?fromSeq=N` returns
    // exactly the chunks the client missed plus the live tail — no dupes,
    // nothing dropped.
    //
    // Uses a local harness with generous timing so the turn is unambiguously
    // still active at probe time (no flaky races with the mock agent).
    const local = createChatHarness({ chunksPerTurn: 8, chunkDelayMs: 40 })
    const sess = 'sess-abandon-midturn'
    try {
      const res1 = await local.request('/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatSessionId: sess }),
      })
      expect(res1.ok).toBe(true)

      // Client consumes the first 2 chunks (seq 1 + 2) then "gives up" —
      // readText's finally cancels the reader, tearing down the HTTP body
      // exactly as auto-resuming-fetch does when its retry budget is spent.
      const consumed = await readText(res1.body!, { maxChunks: 2 })
      expect(consumed.chunks).toBe(2)
      expect(consumed.done).toBe(false)
      const fromSeq = consumed.chunks // last seq the client actually saw

      // The UI would now show "disconnected". Probe the durable-turn snapshot
      // the client uses to decide whether to auto-reconnect: it must report
      // the turn is STILL active even though the client dropped.
      const turnRes = await local.request(`/agent/chat/${sess}/turn`)
      expect(turnRes.status).toBe(200)
      const turn = (await turnRes.json()) as { status: string; turnId: string; lastSeq: number }
      expect(turn.status).toBe('active')
      expect(turn.turnId).toBeTruthy()

      // Auto-recovery: reconnect from the last seq the client saw. The resume
      // must be tagged with the SAME turnId (so the client doesn't graft a
      // different turn onto its accumulator) and replay only seq > fromSeq.
      const resumeRes = await local.request(`/agent/chat/${sess}/stream?fromSeq=${fromSeq}`)
      expect(resumeRes.status).toBe(200)
      expect(resumeRes.headers.get('X-Turn-Id')).toBe(turn.turnId)

      const recovered = await readText(resumeRes.body!, { maxMs: 5_000 })
      expect(recovered.done).toBe(true)

      // The delta must contain none of the already-seen chunks and all of the
      // remaining ones, in order.
      expect(recovered.text).not.toContain(`${sess}:chunk-0\n`)
      expect(recovered.text).not.toContain(`${sess}:chunk-1\n`)
      const fullText = consumed.text + recovered.text
      expect(fullText).toBe(expectedFullPayload(sess, local.chunksPerTurn))
      // Exactly chunksPerTurn chunks across both reads — no duplication.
      expect((fullText.match(/chunk-/g) || []).length).toBe(local.chunksPerTurn)
    } finally {
      await Promise.allSettled(Array.from(local.agentDone.values()))
      local.store.dispose()
    }
  })
})
