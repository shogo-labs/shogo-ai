// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-259 acceptance — QA's own gate on "when does a context summary run".
 *
 * The card's unit tests (`autocompact-idle.test.ts`) check the same criteria
 * from the inside. These drive the production wiring instead:
 *
 *   - the cap and the in-loop budget are read from a REAL `AgentGateway` on a
 *     real 1M-window model, not from a constant;
 *   - AC2 is measured on what the provider is asked for: turn 1 ends over the
 *     cap and must NOT summarize, and turn 2's FIRST request must already be
 *     compacted;
 *   - AC3 runs a session that has been through a runtime restart — the gap is
 *     read back from `.shogo/sessions.db`, which is the shape a `[Task update]`
 *     hours later actually takes (memory eviction or a new pod);
 *   - the in-turn rule is driven through `MidTurnAutocompactor` with a fake
 *     clock, including the `minDeltaTokens` bypass and the memoized prefix
 *     staying byte-identical.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import {
  DEFAULT_AUTOCOMPACT_TOKENS,
  IDLE_COMPACT_AFTER_MS,
  resolveAutoCompactTokens,
  resolveIdleCompactAfterMs,
} from '../session-manager'
import { resolveInLoopContextBudgetTokens } from '../stable-compaction'
import { MIDTURN_KEEP_RECENT_MESSAGES, MidTurnAutocompactor } from '../midturn-autocompact'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = join(tmpdir(), 'qa-sho259')
const RESERVE = 16_384 + 15_000
/** Cheap cap so an over-the-cap / idle pair stays fast (floor = 40% = 48k). */
const CAP = 120_000
const FLOOR = CAP * 0.4
/** Marker that must survive untouched until something really summarizes. */
const MARKER = 'SEEDED_HISTORY_MARKER'

const user = (text: string): UserMessage => ({ role: 'user', content: text, timestamp: 1 })

function makeWs(name: string, model = 'claude-haiku-5-5'): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: model },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nsummary timing acceptance\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

const framesOf = (frames: any[], type: string) => frames.filter((f) => f.type === type)

interface Harness {
  gw: AgentGateway
  sm: any
  /** Every request's serialized messages, in provider order, across all turns. */
  requests: string[]
  /** Frames of the most recent turn. */
  turn: (text?: string) => Promise<any[]>
  /** Seed `count` user messages of `chars` chars each (≈ chars/4 tokens). */
  seed: (count: number, chars: number) => void
  stop: () => Promise<void>
}

async function harness(name: string, responses: string[], ws?: string): Promise<Harness> {
  const dir = ws ?? makeWs(name)
  trustWorkspaceForTests(dir)
  const gw = new AgentGateway(dir, `p-${name}`)
  const requests: string[] = []
  const inner = createMockStreamFn(responses.map((text) => buildTextResponse(text)))
  gw.setStreamFn(((model: any, context: any, options: any) => {
    requests.push(JSON.stringify(context.messages))
    return inner(model, context, options)
  }) as any)
  await gw.start()
  const sm = gw.getSessionManager()
  return {
    gw,
    sm,
    requests,
    turn: async (text = 'hello') => {
      const frames: any[] = []
      await (gw as any).agentTurn(text, 'sess-259', false, undefined, {
        write: (chunk: any) => frames.push(chunk),
      })
      return frames
    },
    seed: (count, chars) => {
      sm.getOrCreate('sess-259')
      const seeds: Message[] = []
      for (let i = 0; i < count; i++) seeds.push(user(`${MARKER} ${i} ${'x'.repeat(chars)}`))
      sm.addMessages('sess-259', ...seeds)
    },
    stop: async () => {
      clearTrustForTests()
      try { await gw.stop() } catch {}
    },
  }
}

const prevAutocompact = process.env.AGENT_AUTOCOMPACT_TOKENS
const prevIdle = process.env.AGENT_IDLE_COMPACT_MINUTES
const prevInloop = process.env.AGENT_INLOOP_CONTEXT_BUDGET_TOKENS
afterEach(() => {
  for (const [key, prev] of [
    ['AGENT_AUTOCOMPACT_TOKENS', prevAutocompact],
    ['AGENT_IDLE_COMPACT_MINUTES', prevIdle],
    ['AGENT_INLOOP_CONTEXT_BUDGET_TOKENS', prevInloop],
  ] as const) {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
})

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

/** Capture console.log lines so the trigger a compaction recorded is visible. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
    lines.push(args.map(String).join(' '))
  })
  return { lines, restore: () => spy.mockRestore() }
}

// ---------------------------------------------------------------------------
describe('SHO-259 AC1: cap 235k, in-loop budget 235k, per-model window untouched', () => {
  test('a real 1M-window gateway resolves to 235k / 235k / 94k', async () => {
    delete process.env.AGENT_AUTOCOMPACT_TOKENS
    delete process.env.AGENT_INLOOP_CONTEXT_BUDGET_TOKENS
    expect(DEFAULT_AUTOCOMPACT_TOKENS).toBe(235_000)
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBe(235_000)
    expect(resolveInLoopContextBudgetTokens(235_000)).toBe(235_000)
    // A 200k-window model keeps its own (smaller) threshold: window − reserve.
    expect(resolveAutoCompactTokens({ contextWindowTokens: 200_000 })).toBe(200_000 - RESERVE)

    const h = await harness('ac1', ['ok'])
    try {
      await h.turn('hello')
      expect(h.sm.contextWindowTokens).toBe(1_000_000)
      expect(h.sm.autocompactThreshold).toBe(235_000)
      // The idle floor is 40% of the cap, which is what keeps a *small* context
      // from being summarized for nothing (AC5).
      expect(h.sm.compactionTailBudgetTokens).toBe(94_000)
    } finally {
      await h.stop()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
describe('SHO-259 AC2: nothing summarizes at the end of a turn', () => {
  test('a turn that ends over the cap waits for the next turn; turn 2 is compacted before it is sent', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const logs = captureLogs()
    const h = await harness('ac2', ['y'.repeat(300_000), 'second reply'])
    try {
      h.seed(2, 120_000) // ≈60k on the wire
      const turn1Frames = await h.turn('first')
      const session = h.sm.get('sess-259')!

      // The reply alone pushes the persisted session over the cap — the old
      // post-turn pass fired exactly here.
      expect(h.sm.estimateTokens(session)).toBeGreaterThan(CAP)
      expect(session.compactionCount).toBe(0)
      expect(framesOf(turn1Frames, 'data-context-summarized')).toHaveLength(0)
      expect(logs.lines.some((l) => /post-turn/i.test(l))).toBe(false)

      // The next turn summarizes *before* its first request: the provider never
      // sees the seeded history.
      const before = h.requests.length
      await h.turn('second')
      const firstOfTurn2 = h.requests[before]
      // The seeded messages are gone: the request now leads with a summary and
      // is a fraction of what turn 1 sent. (The marker text itself survives
      // *inside* the summary — that is the summarizer doing its job, not a
      // failed compaction.)
      expect(firstOfTurn2).toContain('Previous conversation summary')
      expect(firstOfTurn2.length).toBeLessThan(h.requests[before - 1].length * 0.6)
      expect(h.sm.get('sess-259')!.compactionCount).toBe(1)
      expect(logs.lines.some((l) => l.includes('Pre-turn autocompact'))).toBe(true)
    } finally {
      logs.restore()
      await h.stop()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
describe('SHO-259 AC3/AC5: the >10-minute rule between turns', () => {
  test('11 minutes idle summarizes once at turn start as `idle`, before the request', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const logs = captureLogs()
    const h = await harness('ac3', ['ok', 'ok'])
    try {
      h.seed(2, 120_000) // ≈60k: above the 48k floor, well under the 120k cap
      await h.turn('first')
      const session = h.sm.get('sess-259')!
      expect(h.sm.estimateTokens(session)).toBeLessThan(CAP)
      expect(session.compactionCount).toBe(0)

      session.lastActivityAt = Date.now() - 11 * 60_000
      const before = h.requests.length
      const frames = await h.turn('after the wait')

      expect(h.sm.get('sess-259')!.compactionCount).toBe(1)
      expect(logs.lines.some((l) => l.includes('"trigger":"idle"'))).toBe(true)
      expect(logs.lines.some((l) => l.includes('Idle autocompact'))).toBe(true)
      // Summarized before the first request, not after it.
      expect(h.requests[before]).toContain('Previous conversation summary')
      expect(h.requests[before].length).toBeLessThan(h.requests[before - 1].length * 0.6)
      expect(framesOf(frames, 'data-context-summarized')).toHaveLength(0)
    } finally {
      logs.restore()
      await h.stop()
    }
  }, 120_000)

  test('9 minutes idle does not summarize', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const h = await harness('ac3-short', ['ok', 'ok'])
    try {
      h.seed(2, 120_000)
      await h.turn('first')
      h.sm.get('sess-259')!.lastActivityAt = Date.now() - 9 * 60_000
      await h.turn('after a short wait')
      expect(h.sm.get('sess-259')!.compactionCount).toBe(0)
    } finally {
      await h.stop()
    }
  }, 120_000)

  test('the gap survives a restart: the persisted session is summarized on resume', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const ws = makeWs('ac3-restart')
    const first = await harness('ac3-restart-1', ['ok'], ws)
    try {
      first.seed(2, 120_000)
      await first.turn('first')
      expect(first.sm.get('sess-259')!.compactionCount).toBe(0)
    } finally {
      await first.stop()
    }

    // Age the persisted row by 11 minutes, exactly as an hour of waiting (or a
    // pod restart) would leave it. Nothing in memory carries the gap.
    const db = new Database(join(ws, '.shogo', 'sessions.db'))
    try {
      const row = db.query('SELECT data FROM sessions WHERE id = ?').get('sess-259') as any
      expect(row).toBeTruthy()
      const data = JSON.parse(row.data)
      data.lastActivityAt = Date.now() - 11 * 60_000
      db.query('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(data), 'sess-259')
    } finally {
      db.close()
    }

    const logs = captureLogs()
    const second = await harness('ac3-restart-2', ['ok'], ws)
    try {
      await second.turn('eleven minutes later')
      expect(second.sm.get('sess-259')!.compactionCount).toBe(1)
      expect(logs.lines.some((l) => l.includes('"trigger":"idle"'))).toBe(true)
    } finally {
      logs.restore()
      await second.stop()
    }
  }, 180_000)

  test('below the floor it is never summarized, however long it waited', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const h = await harness('ac5', ['ok', 'ok'])
    try {
      h.seed(2, 60_000) // ≈30k, under the 48k floor
      await h.turn('first')
      h.sm.get('sess-259')!.lastActivityAt = Date.now() - 60 * 60_000
      await h.turn('an hour later')
      expect(h.sm.get('sess-259')!.compactionCount).toBe(0)
    } finally {
      await h.stop()
    }
  }, 120_000)

  test('AGENT_IDLE_COMPACT_MINUTES=0 turns the between-turn rule off', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    process.env.AGENT_IDLE_COMPACT_MINUTES = '0'
    expect(resolveIdleCompactAfterMs('0')).toBe(0)
    const h = await harness('ac6-off', ['ok', 'ok'])
    try {
      h.seed(2, 120_000) // above the floor: only the switch can stop it
      await h.turn('first')
      h.sm.get('sess-259')!.lastActivityAt = Date.now() - 60 * 60_000
      await h.turn('an hour later')
      expect(h.sm.get('sess-259')!.compactionCount).toBe(0)
    } finally {
      await h.stop()
    }
  }, 120_000)

  test('the default threshold is 10 minutes', () => {
    expect(IDLE_COMPACT_AFTER_MS).toBe(10 * 60_000)
    expect(resolveIdleCompactAfterMs(undefined)).toBe(10 * 60_000)
    expect(resolveIdleCompactAfterMs('not a number')).toBe(10 * 60_000)
    expect(resolveIdleCompactAfterMs('15')).toBe(15 * 60_000)
  })
})

// ---------------------------------------------------------------------------
describe('SHO-259 AC4: the >10-minute rule inside a turn', () => {
  const CAP_TOKENS = 235_000
  const FLOOR_TOKENS = 94_000

  function makeCompactor(clock: { now: number }, idleAfterMs = 10 * 60_000) {
    const events: any[] = []
    const compactor = new MidTurnAutocompactor({
      autoCompactTokens: CAP_TOKENS,
      keepRecentMessages: MIDTURN_KEEP_RECENT_MESSAGES,
      tailBudgetTokens: FLOOR_TOKENS,
      minKeepMessages: 1,
      promptOverheadTokens: 1_000,
      minDeltaTokens: 40_000,
      idleCompactAfterMs: idleAfterMs,
      idleCompactFloorTokens: FLOOR_TOKENS,
      now: () => clock.now,
      summarize: async (head, prev) => `${prev ?? ''} folded ${head.length}`,
      apply: () => {},
    })
    return {
      compactor,
      run: async (messages: Message[]) => {
        const out = await compactor.transform(messages)
        if (out.event) events.push(out.event)
        return out
      },
      events,
    }
  }

  /** ≈120k tokens: above the floor, comfortably under the cap. */
  const bigHistory = (): Message[] => {
    const messages: Message[] = []
    for (let i = 0; i < 6; i++) messages.push(user(`TURN_MARKER_${i} ${'z'.repeat(80_000)}`))
    return messages
  }

  test('an 11-minute gap between two model calls summarizes as `idle`, bypassing minDelta', async () => {
    const clock = { now: 5_000_000 }
    const { run, events } = makeCompactor(clock)
    const messages = bigHistory()

    const first = await run(messages)
    expect(first.event).toBeNull() // no previous call to measure a gap from

    clock.now += 11 * 60_000 // a `wait`, a blocking subagent call, a long exec
    const out = await run(messages)
    expect(out.event).not.toBeNull()
    expect(out.event!.reason).toBe('idle')
    // The transcript row stays `auto`; only telemetry/logs name the reason.
    expect(out.event!.trigger).toBe('auto')
    expect(out.event!.tokensAfter).toBeLessThan(out.event!.tokensBefore)

    // Every later call in the turn re-emits the memoized prefix by identity.
    const again = await run(messages)
    expect(again.event).toBeNull()
    expect(again.messages[0]).toBe(out.messages[0])
    expect(again.messages).toHaveLength(out.messages.length)

    // No thrash: after one idle compaction, a *second* 11-minute gap with the
    // same context must not summarize again (there is nothing new to fold).
    clock.now += 11 * 60_000
    const third = await run(messages)
    expect(third.event).toBeNull()
    expect(events).toHaveLength(1)
  })

  test('a 9-minute gap does not summarize', async () => {
    const clock = { now: 5_000_000 }
    const { run, events } = makeCompactor(clock)
    const messages = bigHistory()
    await run(messages)
    clock.now += 9 * 60_000
    expect((await run(messages)).event).toBeNull()
    expect(events).toHaveLength(0)
  })

  test('a request below the floor is not summarized on idle', async () => {
    const clock = { now: 5_000_000 }
    const { run, events } = makeCompactor(clock)
    const messages: Message[] = []
    for (let i = 0; i < 3; i++) messages.push(user(`small ${i} ${'q'.repeat(20_000)}`))
    await run(messages)
    clock.now += 60 * 60_000
    expect((await run(messages)).event).toBeNull()
    expect(events).toHaveLength(0)
  })

  test('AGENT_IDLE_COMPACT_MINUTES=0 turns the in-turn rule off', async () => {
    const clock = { now: 5_000_000 }
    const { run, events } = makeCompactor(clock, 0)
    const messages = bigHistory()
    await run(messages)
    clock.now += 60 * 60_000
    expect((await run(messages)).event).toBeNull()
    expect(events).toHaveLength(0)
  })
})
