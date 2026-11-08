// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA gate for SHO-358 §4 (acceptance criterion 4).
 *
 * Prod: the parent turn sat in `agent_spawn` behind a browser `snapshot` on a
 * frozen page. `POST /agent/stop` returned `{stopped:true}` and the turn stayed
 * `active` — the chat was unreachable for 18 h, and the SHO-348 orphan reaper
 * skipped it because the turn held its lock and kept writing progress frames.
 *
 * Criterion 4 has three parts and only the first two were pinned by the
 * implementation's own tests (terminal frame, buffer completed). This adds the
 * third — **the turn lock is free**, so the chat accepts a message again — and a
 * source tripwire on the route wiring, because the grace timer lives inside
 * `server.ts` and cannot be imported without booting the whole runtime.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StreamBufferStore } from '@shogo/shared-runtime'
import { LiveTurnGate } from '../live-turn-wait'
import { createBufferedTurns } from '../buffered-turn'
import { StreamRegistry } from '../stream-registry'

const decoder = new TextDecoder()
const SESSION = 'chat-sho-358-stop'

let store: StreamBufferStore | undefined

afterEach(() => {
  store?.dispose()
  store = undefined
})

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out += decoder.decode(value)
  }
}

function wire(now: () => number = () => Date.now()) {
  const s = new StreamBufferStore()
  store = s
  const gate = new LiveTurnGate(s, 5)
  // The gateway's turn lock is dropped eagerly by `abortCurrentTurn` (the first
  // thing `/agent/stop` does), so by the time the grace reap fires the session
  // is already unlocked — the reap only has to close the buffer and the stream.
  const registry = new StreamRegistry({
    isTurnLocked: () => false,
    orphanTtlMs: 10 * 60_000,
    now,
    log: () => {},
  })
  const turns = createBufferedTurns({
    store: s,
    gate,
    onStreamStart: (h) => registry.register(h),
    onStreamProgress: (id) => registry.touch(id),
    onStreamEnd: (id) => registry.end(id),
  })
  return { store: s, gate, registry, turns }
}

describe('SHO-358 — Stop frees the chat even when the turn never ends', () => {
  test('a wedged turn reaped by Stop leaves no live turn to wait behind', async () => {
    const { store: s, gate, registry, turns } = wire()

    // The prod shape: a tool call that never settles, and a turn that keeps
    // writing progress frames so the orphan reaper's silence rule never fires.
    turns.start(SESSION, async (writer) => {
      const progress = setInterval(() => {
        try {
          writer.write({ type: 'data-tool-progress', data: { elapsedMs: 64_900_000 } })
        } catch { /* buffer already closed by the reap */ }
      }, 10)
      try {
        await new Promise(() => {})
      } finally {
        clearInterval(progress)
      }
    })
    await Bun.sleep(30)

    expect(gate.isBusy(SESSION)).toBe(true)
    expect(registry.hasSession(SESSION)).toBe(true)
    // A queued message would wait here forever.
    expect((await gate.waitUntilFree(SESSION, { timeoutMs: 40 })).timedOut).toBe(true)

    // Exactly what POST /agent/stop does, grace period collapsed.
    const stoppedTurnIds = new Set(registry.turnIdsFor(SESSION))
    gate.markStopped(SESSION)
    const reaped = registry.forceReapSession(
      SESSION,
      'the turn was stopped and did not wind down within the grace period',
      'aborted',
      stoppedTurnIds,
    )

    expect(reaped).toHaveLength(1)
    expect(registry.hasSession(SESSION)).toBe(false)

    // AC4: the chat is no longer `active` and a new message does not queue.
    expect(s.snapshot(SESSION)?.status).not.toBe('active')
    expect(gate.isBusy(SESSION)).toBe(false)
    const free = await gate.waitUntilFree(SESSION, { timeoutMs: 40 })
    expect(free.timedOut).toBe(false)
    expect(free.stopped).toBe(false)

    // AC4: the buffer carries a terminal frame tagged `aborted` (user-initiated,
    // not a crash), so the client stops auto-resuming and the composer unlocks.
    const replay = await readAll(s.createReplayStream(SESSION, { fromSeq: 0, compact: false })!)
    expect(replay).toContain('data-turn-complete')
    expect(replay).toContain('aborted')
  })

  test('the next message after Stop gets its turn; the stopped one is already gone', async () => {
    const { gate, registry, turns } = wire()

    const stopped = turns.start(SESSION, () => new Promise(() => {}))
    const stoppedTurnIds = new Set(registry.turnIdsFor(SESSION))
    gate.markStopped(SESSION)
    registry.forceReapSession(SESSION, 'stopped', 'aborted', stoppedTurnIds)

    const next = turns.start(SESSION, () => new Promise(() => {}))
    await Bun.sleep(5)
    expect(next.turnId).not.toBe(stopped.turnId)
    expect(registry.turnIdsFor(SESSION)).toEqual([next.turnId])
    expect(gate.isBusy(SESSION)).toBe(true)
  })

  test('the route arms the grace reap for the turn ids live at Stop time', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf-8')

    const stopRoute = src.slice(src.indexOf("app.post('/agent/stop'"))
    expect(stopRoute.length).toBeGreaterThan(0)
    expect(stopRoute).toContain('scheduleStopReap(stopSessionKey)')

    const helper = src.slice(src.indexOf('function scheduleStopReap'))
    expect(helper.length).toBeGreaterThan(0)
    // Captured at Stop time so a message sent right after Stop keeps its turn.
    expect(helper).toContain('streamRegistry.turnIdsFor(sessionKey)')
    expect(helper).toContain('forceReapSession')
    expect(helper).toContain("'aborted'")
    expect(helper).toContain('STOP_REAP_GRACE_MS')
  })
})
