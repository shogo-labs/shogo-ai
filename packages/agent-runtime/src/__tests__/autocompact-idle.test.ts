// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-259 — when context gets summarized.
 *
 * Summarizing rewrites the prompt prefix, so the next request pays a full
 * cache write. That makes two moments wrong and one moment free:
 *   - the end of a turn is the worst time (the next turn would have read a
 *     warm cache) — nothing compacts there any more;
 *   - after a wait longer than the 5-minute cache the write is happening
 *     either way, so summarizing then is free and the write is smaller.
 *
 * These tests drive a real `AgentGateway.agentTurn` for the between-turn rule
 * and the real `MidTurnAutocompactor` with an injected clock for the in-turn
 * one.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import {
  DEFAULT_AUTOCOMPACT_TOKENS,
  IDLE_COMPACT_AFTER_MS,
  resolveAutoCompactTokens,
  resolveIdleCompactAfterMs,
  type SessionManager,
} from '../session-manager'
import { resolveInLoopContextBudgetTokens } from '../stable-compaction'
import { MIDTURN_KEEP_RECENT_MESSAGES, MidTurnAutocompactor } from '../midturn-autocompact'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = join(tmpdir(), 'sho259-idle')
const RESERVE = 16_384 + 15_000
/**
 * Cheap cap so an "over the cap" test stays fast. It must stay well above the
 * ~25k of system prompt + tool schemas the request estimate adds, or the cap
 * path fires before the idle path can be observed.
 */
const CAP = 120_000

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
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nidle compaction\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

const framesOf = (frames: any[], type: string) => frames.filter((f) => f.type === type)

interface Harness {
  gw: AgentGateway
  sm: SessionManager
  /** Frames of the most recent turn. */
  turn: (text?: string) => Promise<any[]>
  /** Seed `count` user messages of `chars` each (4 chars ≈ 1 token). */
  seed: (count: number, chars: number) => void
  stop: () => Promise<void>
}

async function harness(name: string, responses: string[]): Promise<Harness> {
  const ws = makeWs(name)
  trustWorkspaceForTests(ws)
  const gw = new AgentGateway(ws, `p-${name}`)
  gw.setStreamFn(createMockStreamFn(responses.map((text) => buildTextResponse(text))))
  await gw.start()
  const sm = gw.getSessionManager()
  const sessionId = 'sess-idle'
  return {
    gw,
    sm,
    turn: async (text = 'hello') => {
      const frames: any[] = []
      await (gw as any).agentTurn(text, sessionId, false, undefined, {
        write: (chunk: any) => frames.push(chunk),
      })
      return frames
    },
    seed: (count, chars) => {
      sm.getOrCreate(sessionId)
      const seeds: Message[] = []
      for (let i = 0; i < count; i++) seeds.push(user('x'.repeat(chars)))
      sm.addMessages(sessionId, ...seeds)
    },
    stop: async () => {
      clearTrustForTests()
      try { await gw.stop() } catch {}
    },
  }
}

const prevAutocompact = process.env.AGENT_AUTOCOMPACT_TOKENS
const prevIdle = process.env.AGENT_IDLE_COMPACT_MINUTES
afterEach(() => {
  if (prevAutocompact === undefined) delete process.env.AGENT_AUTOCOMPACT_TOKENS
  else process.env.AGENT_AUTOCOMPACT_TOKENS = prevAutocompact
  if (prevIdle === undefined) delete process.env.AGENT_IDLE_COMPACT_MINUTES
  else process.env.AGENT_IDLE_COMPACT_MINUTES = prevIdle
})

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('SHO-259 AC1: the cap moves to 235k', () => {
  test('a 1M window summarizes at 235k and checkpoints at 235k', () => {
    delete process.env.AGENT_AUTOCOMPACT_TOKENS
    delete process.env.AGENT_INLOOP_CONTEXT_BUDGET_TOKENS
    expect(DEFAULT_AUTOCOMPACT_TOKENS).toBe(235_000)
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBe(235_000)
    expect(resolveInLoopContextBudgetTokens(235_000)).toBe(235_000)
    // A 200k-window model still summarizes at its own window minus the reserve.
    expect(resolveAutoCompactTokens({ contextWindowTokens: 200_000 })).toBe(200_000 - RESERVE)
  })
})

describe('SHO-259 AC6: the idle threshold is configurable', () => {
  test('default 10 minutes, 0 turns it off, garbage falls back', () => {
    expect(resolveIdleCompactAfterMs(undefined)).toBe(IDLE_COMPACT_AFTER_MS)
    expect(IDLE_COMPACT_AFTER_MS).toBe(10 * 60_000)
    expect(resolveIdleCompactAfterMs('')).toBe(IDLE_COMPACT_AFTER_MS)
    expect(resolveIdleCompactAfterMs('0')).toBe(0)
    expect(resolveIdleCompactAfterMs('15')).toBe(15 * 60_000)
    expect(resolveIdleCompactAfterMs('lots')).toBe(IDLE_COMPACT_AFTER_MS)
  })
})

describe('SHO-259 AC2: a turn never summarizes at its end', () => {
  test('a session that ends over the cap waits for the next turn', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    // Turn 1 starts under the cap (~60k on the wire) and its reply pushes the
    // session to ~135k — over the cap — so the old post-turn pass would have
    // fired there.
    const h = await harness('ac2', ['y'.repeat(300_000), 'done'])
    try {
      h.seed(2, 120_000)
      const frames = await h.turn('first')
      const session = h.sm.get('sess-idle')!

      expect(h.sm.estimateTokens(session)).toBeGreaterThan(CAP)
      expect(session.compactionCount).toBe(0)
      expect(framesOf(frames, 'data-context-summarized')).toHaveLength(0)

      // ...and the next turn summarizes before its first request.
      await h.turn('second')
      expect(h.sm.get('sess-idle')!.compactionCount).toBe(1)
    } finally {
      await h.stop()
    }
  }, 120_000)
})

describe('SHO-259 AC3/AC5: between turns, a wait over 10 minutes summarizes', () => {
  test('above the floor and under the cap, 11 minutes idle summarizes once as `idle`', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const logged: string[] = []
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logged.push(args.map(String).join(' '))
    })
    const h = await harness('ac3', ['ok', 'ok'])
    try {
      h.seed(2, 120_000) // ~60k: above the 48k floor, well under the 120k cap
      await h.turn('first')
      const session = h.sm.get('sess-idle')!
      expect(session.compactionCount).toBe(0)

      session.lastActivityAt = Date.now() - 11 * 60_000
      await h.turn('after the wait')

      expect(h.sm.get('sess-idle')!.compactionCount).toBe(1)
      expect(logged.some((line) => line.includes('"trigger":"idle"'))).toBe(true)
    } finally {
      spy.mockRestore()
      await h.stop()
    }
  }, 120_000)

  test('9 minutes idle does not summarize', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const h = await harness('ac3-short', ['ok', 'ok'])
    try {
      h.seed(2, 120_000)
      await h.turn('first')
      h.sm.get('sess-idle')!.lastActivityAt = Date.now() - 9 * 60_000
      await h.turn('after a short wait')
      expect(h.sm.get('sess-idle')!.compactionCount).toBe(0)
    } finally {
      await h.stop()
    }
  }, 120_000)

  test('below the floor it never summarizes, however long it waited', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    const h = await harness('ac5', ['ok', 'ok'])
    try {
      h.seed(2, 60_000) // ~30k, under the 48k floor
      await h.turn('first')
      h.sm.get('sess-idle')!.lastActivityAt = Date.now() - 60 * 60_000
      await h.turn('an hour later')
      expect(h.sm.get('sess-idle')!.compactionCount).toBe(0)
    } finally {
      await h.stop()
    }
  }, 120_000)

  test('AGENT_IDLE_COMPACT_MINUTES=0 turns the between-turn rule off', async () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = String(CAP)
    process.env.AGENT_IDLE_COMPACT_MINUTES = '0'
    const h = await harness('ac6-off', ['ok', 'ok'])
    try {
      h.seed(2, 120_000) // above the floor, so only the env switch can stop it
      await h.turn('first')
      h.sm.get('sess-idle')!.lastActivityAt = Date.now() - 60 * 60_000
      await h.turn('an hour later')
      expect(h.sm.get('sess-idle')!.compactionCount).toBe(0)
    } finally {
      await h.stop()
    }
  }, 120_000)
})

describe('SHO-259 AC4: inside a turn, a gap over 10 minutes summarizes', () => {
  const CAP_TOKENS = 235_000
  const FLOOR = 94_000

  function makeIdleCompactor(opts: {
    idleCompactAfterMs?: number
    idleCompactFloorTokens?: number
    clock: { now: number }
  }) {
    const events: any[] = []
    const applied: Array<{ summary: string; splitIndex: number }> = []
    const compactor = new MidTurnAutocompactor({
      autoCompactTokens: CAP_TOKENS,
      keepRecentMessages: MIDTURN_KEEP_RECENT_MESSAGES,
      tailBudgetTokens: FLOOR,
      minKeepMessages: 1,
      promptOverheadTokens: 1_000,
      idleCompactAfterMs: opts.idleCompactAfterMs ?? 10 * 60_000,
      idleCompactFloorTokens: opts.idleCompactFloorTokens ?? FLOOR,
      now: () => opts.clock.now,
      summarize: async (head, prev) => `${prev ?? ''} folded ${head.length}`,
      apply: (summary, splitIndex) => applied.push({ summary, splitIndex }),
    })
    const transform = async (messages: Message[]) => {
      const out = await compactor.transform(messages)
      if (out.event) events.push(out.event)
      return out
    }
    return { compactor, transform, events, applied }
  }

  /** ~120k tokens: above the floor, well under the cap. */
  const bigHistory = (): Message[] => {
    const messages: Message[] = []
    for (let i = 0; i < 6; i++) messages.push(user(`MARKER_${i} ${'z'.repeat(80_000)}`))
    return messages
  }

  test('an 11-minute gap under the cap summarizes as reason `idle`', async () => {
    const clock = { now: 1_000_000 }
    const { transform, events, applied } = makeIdleCompactor({ clock })
    const messages = bigHistory()

    const first = await transform(messages)
    expect(first.event).toBeNull() // no clock yet — nothing to compare against

    clock.now += 11 * 60_000
    const out = await transform(messages)
    expect(out.event).not.toBeNull()
    expect(out.event!.reason).toBe('idle')
    // The transcript row keeps `auto`; only telemetry names the reason.
    expect(out.event!.trigger).toBe('auto')
    expect(applied).toHaveLength(1)

    // Calls after the compaction re-emit the memoized prefix byte-identically.
    const again = await transform(messages)
    expect(again.event).toBeNull()
    expect(again.messages[0]).toBe(out.messages[0])
    expect(again.messages.length).toBe(out.messages.length)
    expect(events).toHaveLength(1)
  })

  test('a 9-minute gap does not summarize', async () => {
    const clock = { now: 1_000_000 }
    const { transform, events } = makeIdleCompactor({ clock })
    const messages = bigHistory()
    await transform(messages)
    clock.now += 9 * 60_000
    const out = await transform(messages)
    expect(out.event).toBeNull()
    expect(events).toHaveLength(0)
  })

  test('a request below the floor does not summarize on idle', async () => {
    const clock = { now: 1_000_000 }
    const { transform, events } = makeIdleCompactor({ clock })
    const messages: Message[] = []
    for (let i = 0; i < 3; i++) messages.push(user(`small ${i} ${'q'.repeat(20_000)}`))
    await transform(messages)
    clock.now += 60 * 60_000
    const out = await transform(messages)
    expect(out.event).toBeNull()
    expect(events).toHaveLength(0)
  })

  test('AGENT_IDLE_COMPACT_MINUTES=0 turns the in-turn rule off', async () => {
    const clock = { now: 1_000_000 }
    const { transform, events } = makeIdleCompactor({ clock, idleCompactAfterMs: 0 })
    const messages = bigHistory()
    await transform(messages)
    clock.now += 60 * 60_000
    const out = await transform(messages)
    expect(out.event).toBeNull()
    expect(events).toHaveLength(0)
  })
})
