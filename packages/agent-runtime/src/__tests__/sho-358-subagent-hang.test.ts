// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A sub-agent that never finishes must not wedge its parent (SHO-358).
 *
 * Prod: a `browser` sub-agent sat in `snapshot` on a frozen page. `agent_spawn`
 * awaited `inst.promise` with no race against anything, so the parent turn stayed
 * `active` for 18 h; `/agent/subagents/:id/stop` returned `{cancelled:true}` and
 * `/agent/stop` returned `{stopped:true}` but neither changed the turn, and the
 * SHO-348 orphan reaper skipped it because the turn still held its lock.
 *
 * These pin the four bounds: the instance settling, the instance being cancelled,
 * the parent turn aborting, and the inactivity/duration watchdog — plus the Stop
 * path that force-reaps a turn whose buffer keeps making progress.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { StreamBufferStore } from '@shogo/shared-runtime'
import { LiveTurnGate } from '../live-turn-wait'
import { createBufferedTurns } from '../buffered-turn'
import { StreamRegistry } from '../stream-registry'
import {
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS,
  DEFAULT_SUBAGENT_MAX_DURATION_MS,
  synthesizeWaitResult,
  waitForSubagentInstance,
  type ManagedInstance,
} from '../agent-manager'
import type { SubagentResult } from '../subagent'

const decoder = new TextDecoder()

function settledResult(text: string): SubagentResult {
  return {
    toolCalls: 1,
    iterations: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    responseText: text,
  }
}

/** A running instance whose promise may or may not ever settle. */
function makeInstance(opts: { settleWith?: SubagentResult; startedAt?: number } = {}) {
  const abort = new AbortController()
  const startedAt = opts.startedAt ?? 0
  let resolvePromise: (r: SubagentResult) => void = () => {}
  const promise = new Promise<SubagentResult>((resolve) => {
    resolvePromise = resolve
  })
  if (opts.settleWith) resolvePromise(opts.settleWith)
  const inst = {
    promise,
    abort,
    startedAt,
    lastActivityAt: startedAt,
  } as Pick<ManagedInstance, 'promise' | 'abort' | 'startedAt' | 'lastActivityAt'> & {
    lastActivityAt: number
  }
  return { inst, abort, settle: (r: SubagentResult) => resolvePromise(r) }
}

describe('waitForSubagentInstance (SHO-358)', () => {
  test('defaults are the documented 10 min idle / 60 min hard cap', () => {
    expect(DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS).toBe(10 * 60_000)
    expect(DEFAULT_SUBAGENT_MAX_DURATION_MS).toBe(60 * 60_000)
  })

  test('returns the result when the instance settles', async () => {
    const { inst, settle } = makeInstance()
    const wait = waitForSubagentInstance(inst, { idleMs: 60_000, maxMs: 60_000 })
    settle(settledResult('done'))
    const outcome = await wait
    expect(outcome.kind).toBe('settled')
    expect(outcome.kind === 'settled' && outcome.result.responseText).toBe('done')
  })

  test('AgentManager.cancel ends the wait within 1s as `cancelled`', async () => {
    const { inst, abort } = makeInstance()
    const started = Date.now()
    const wait = waitForSubagentInstance(inst, { idleMs: 600_000, maxMs: 600_000 })
    setTimeout(() => abort.abort(), 10)
    const outcome = await wait
    expect(Date.now() - started).toBeLessThan(1000)
    expect(outcome).toEqual({ kind: 'cancelled', reason: 'instance-cancel' })
  })

  test('the parent turn aborting ends the wait as `cancelled`', async () => {
    const { inst } = makeInstance()
    const parent = new AbortController()
    const wait = waitForSubagentInstance(inst, {
      idleMs: 600_000,
      maxMs: 600_000,
      parentSignal: parent.signal,
    })
    parent.abort()
    expect(await wait).toEqual({ kind: 'cancelled', reason: 'parent-abort' })
  })

  test('an already-aborted parent signal does not wait at all', async () => {
    const { inst } = makeInstance()
    const parent = new AbortController()
    parent.abort()
    const outcome = await waitForSubagentInstance(inst, {
      idleMs: 600_000,
      maxMs: 600_000,
      parentSignal: parent.signal,
    })
    expect(outcome).toEqual({ kind: 'cancelled', reason: 'parent-abort' })
  })

  test('the inactivity watchdog fires while the instance shows no progress', async () => {
    let clock = 1_000
    const { inst } = makeInstance({ startedAt: clock })
    const outcome = waitForSubagentInstance(inst, {
      idleMs: 50,
      maxMs: 10_000,
      now: () => clock,
      checkIntervalMs: 5,
    })
    // The watchdog samples on a timer, so move the clock after arming it.
    clock = 1_080
    const settled = await Promise.race([outcome, Bun.sleep(500).then(() => ({ kind: 'still-waiting' as const }))])
    expect(settled.kind).toBe('timeout')
  })

  test('progress resets the idle watchdog (a healthy long run is not cut off)', async () => {
    let clock = 1_000
    const { inst } = makeInstance({ startedAt: 1_000 })
    const outcome = waitForSubagentInstance(inst, {
      idleMs: 50,
      maxMs: 10_000,
      now: () => clock,
      checkIntervalMs: 5,
    })
    // An 80-call browser QA run: a tool boundary every 20ms of clock time, far
    // more often than the 50ms idle window.
    for (let i = 0; i < 80; i++) {
      clock += 20
      inst.lastActivityAt = clock
      await Bun.sleep(3)
    }
    const race = await Promise.race([outcome, Promise.resolve({ kind: 'still-waiting' as const })])
    expect(race.kind).toBe('still-waiting')
    // And it still ends when the run itself ends.
    ;(inst as any).abort.abort()
    expect((await outcome).kind).toBe('cancelled')
  })

  test('the hard duration cap fires even while the instance keeps showing activity', async () => {
    let clock = 0
    const { inst } = makeInstance({ startedAt: 0 })
    const outcome = waitForSubagentInstance(inst, {
      idleMs: 50,
      maxMs: 100,
      now: () => clock,
      checkIntervalMs: 5,
    })
    clock = 150
    inst.lastActivityAt = clock
    const settled = await Promise.race([outcome, Bun.sleep(200).then(() => ({ kind: 'still-waiting' as const }))])
    expect(settled.kind).toBe('timeout')
    expect(settled.kind === 'timeout' && settled.reason).toContain('limit')
  })

  test('a cancelled run carries its cause and the partial report', () => {
    const result = synthesizeWaitResult({ toolCalls: 7, responseText: 'found three issues' }, 'The sub-agent stopped.')
    expect(result.error?.message).toBe('The sub-agent stopped.')
    expect(result.responseEmpty).toBe(true)
    expect(result.toolCalls).toBe(7)
    expect(result.responseText).toBe('found three issues')
  })
})

// ---------------------------------------------------------------------------
// Stop always ends the turn (SHO-358 §4)
// ---------------------------------------------------------------------------

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

describe('StreamRegistry.forceReapSession (SHO-358)', () => {
  test('a stopped turn is force-reaped even while it still makes progress', async () => {
    store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    let now = 1_000_000
    const locked = new Set<string>(['chat-stuck'])
    const registry = new StreamRegistry({
      isTurnLocked: (id) => locked.has(id),
      orphanTtlMs: 10 * 60_000,
      now: () => now,
      log: () => {},
    })
    const turns = createBufferedTurns({
      store,
      gate,
      onStreamStart: (h) => registry.register(h),
      onStreamProgress: (id) => registry.touch(id),
      onStreamEnd: (id) => registry.end(id),
    })

    // A turn that never ends on its own — the frozen browser call.
    turns.start('chat-stuck', async (writer) => {
      writer.write({ type: 'data-tool-progress', data: { elapsedMs: 1 } })
      await new Promise(() => {})
    })
    expect(registry.size).toBe(1)
    expect(registry.hasSession('chat-stuck')).toBe(true)

    // The orphan reaper must NOT take it: it holds its lock and keeps writing.
    now += 60 * 60_000
    expect(registry.reapOrphans()).toEqual([])
    expect(registry.size).toBe(1)

    const reaped = registry.forceReapSession('chat-stuck', 'the turn was stopped', 'aborted')
    expect(reaped.length).toBe(1)
    expect(registry.size).toBe(0)

    // The buffer now carries a terminal frame, so the chat is not `active`.
    const replay = await readAll(store.createReplayStream('chat-stuck', { fromSeq: 0, compact: false })!)
    expect(replay).toContain('data-turn-complete')
    expect(replay).toContain('aborted')
    expect(store.snapshot('chat-stuck')?.status).not.toBe('active')
  })

  test('a turn started after the Stop survives the reap', async () => {
    store = new StreamBufferStore()
    const gate = new LiveTurnGate(store, 5)
    const registry = new StreamRegistry({ isTurnLocked: () => true, log: () => {} })
    const turns = createBufferedTurns({
      store,
      gate,
      onStreamStart: (h) => registry.register(h),
      onStreamProgress: (id) => registry.touch(id),
      onStreamEnd: (id) => registry.end(id),
    })

    const stopped = turns.start('chat-next', () => new Promise(() => {}))
    const stoppedIds = new Set(registry.turnIdsFor('chat-next'))
    expect(stoppedIds.has(stopped.turnId)).toBe(true)

    // The user's next message starts a new turn on the same session.
    const next = turns.start('chat-next', () => new Promise(() => {}))
    await Bun.sleep(5)
    expect(registry.turnIdsFor('chat-next')).toHaveLength(2)

    registry.forceReapSession('chat-next', 'stopped', 'aborted', stoppedIds)
    expect(registry.turnIdsFor('chat-next')).toEqual([next.turnId])
  })

  test('hasSession is false for an untouched session and after a reap', () => {
    store = new StreamBufferStore()
    const registry = new StreamRegistry({ isTurnLocked: () => false })
    expect(registry.hasSession('nope')).toBe(false)
  })
})
