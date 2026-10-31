// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 — context must never sail past the cap uns summarized.
 *
 * These are the acceptance tests from the card, driven through a real
 * `runAgentLoop` with a scripted stream (the estimate is measured at the
 * `streamFn` boundary, i.e. on the request that would actually be sent, not on
 * the session).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { runAgentLoop } from '../agent-loop'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { buildTextResponse, buildToolUseResponse, createMockStreamFn } from './helpers/mock-anthropic'
import { MockToolTracker } from './helpers/mock-tools'
import {
  MIDTURN_KEEP_RECENT_MESSAGES,
  MidTurnAutocompactor,
  type ContextSummarizedEvent,
} from '../midturn-autocompact'
import {
  DEFAULT_AUTOCOMPACT_TOKENS,
  SessionManager,
  estimateMessageTokens,
  resolveAutoCompactTokens,
} from '../session-manager'

const CAP = 200_000
const CEILING = 205_000
/** System prompt + tool schemas, counted the way the gateway counts them. */
// Measured on a live `AgentGateway.agentTurn` at the streamFn boundary:
// systemPrompt.length/4 + every tool schema = 52,021 tokens. The old 12k
// constant made the 205k ceiling look met while real turns sent 211-228k.
const PROMPT_OVERHEAD = 52_000

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

/** Build a deterministic summarizer that names every marker it was given. */
function markerSummarizer() {
  const chunks: string[][] = []
  const summarize = async (head: Message[], previousSummary?: string) => {
    const markers: string[] = []
    for (const msg of head) {
      const text = typeof (msg as any).content === 'string'
        ? (msg as any).content
        : ((msg as any).content as any[])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join(' ')
      for (const match of text.matchAll(/MARKER_[A-Z0-9_]+/g)) {
        if (!markers.includes(match[0])) markers.push(match[0])
      }
    }
    chunks.push(markers)
    return [`SUMMARY chunk ${chunks.length}`, previousSummary, ...markers].filter(Boolean).join(' ')
  }
  return { summarize, chunks }
}

function makeCompactor(opts: {
  autoCompactTokens?: number
  tailBudgetTokens?: number
  minKeepMessages?: number
  apply?: (summary: string, splitIndex: number, o: { replaceSummary: boolean }) => void
  summarize?: (head: Message[], prev?: string) => Promise<string>
}) {
  const events: ContextSummarizedEvent[] = []
  const applied: Array<{ summary: string; splitIndex: number; replaceSummary: boolean }> = []
  const { summarize, chunks } = markerSummarizer()
  const compactor = new MidTurnAutocompactor({
    autoCompactTokens: opts.autoCompactTokens ?? CAP,
    keepRecentMessages: MIDTURN_KEEP_RECENT_MESSAGES,
    ...(opts.tailBudgetTokens ? { tailBudgetTokens: opts.tailBudgetTokens } : {}),
    ...(opts.minKeepMessages ? { minKeepMessages: opts.minKeepMessages } : {}),
    promptOverheadTokens: PROMPT_OVERHEAD,
    summarize: opts.summarize ?? summarize,
    apply: (summary, splitIndex, o) => {
      applied.push({ summary, splitIndex, replaceSummary: o.replaceSummary })
      opts.apply?.(summary, splitIndex, o)
    },
  })
  return { compactor, events, applied, chunks }
}

const originalAutocompactEnv = process.env.AGENT_AUTOCOMPACT_TOKENS
afterEach(() => {
  if (originalAutocompactEnv === undefined) delete process.env.AGENT_AUTOCOMPACT_TOKENS
  else process.env.AGENT_AUTOCOMPACT_TOKENS = originalAutocompactEnv
})

describe('resolveAutoCompactTokens', () => {
  test('a 1M-window model compacts at the 200k cap, not at 968k', () => {
    // The bug: claude-haiku-5-5 is catalogued as 1M and the runtime budgeted
    // window − reserve = 968,616 — far above the size we are willing to send.
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBeLessThan(968_616)
  })

  test('an unknown model keeps the historical 200k window minus reserve', () => {
    expect(resolveAutoCompactTokens({})).toBe(200_000 - 16_384 - 15_000)
  })

  test('a small window uses its own headroom, not the cap', () => {
    expect(resolveAutoCompactTokens({ contextWindowTokens: 100_000 })).toBe(100_000 - 16_384 - 15_000)
  })

  test('AGENT_AUTOCOMPACT_TOKENS lowers the cap and is ignored when garbage', () => {
    process.env.AGENT_AUTOCOMPACT_TOKENS = '120000'
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBe(120_000)
    process.env.AGENT_AUTOCOMPACT_TOKENS = 'lots'
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
  })

  test('SessionManager drives its threshold from the model window it is given', () => {
    const sm = new SessionManager({})
    expect(sm.autocompactThreshold).toBe(200_000 - 16_384 - 15_000)
    sm.setContextWindowTokens(1_000_000)
    expect(sm.autocompactThreshold).toBe(DEFAULT_AUTOCOMPACT_TOKENS)
    sm.setContextWindowTokens(undefined)
    expect(sm.autocompactThreshold).toBe(200_000 - 16_384 - 15_000)
  })
})

describe('mid-turn summarization in a real agent loop', () => {
  for (const calls of [40, 60, 90]) {
    test(`a ${calls}-tool-call turn never sends a request over 205k`, async () => {
      const tracker = new MockToolTracker()
      // 30k chars ≈ 7.5k tokens per result → 300k / 450k / 675k raw tokens.
      const tool = tracker.createTool('fetch_page', 'Fetch a page', () => ({ content: 'x'.repeat(30_000) }))

      const responses = Array.from({ length: calls }, (_, i) =>
        buildToolUseResponse([{ name: 'fetch_page', arguments: { path: `page-${i}.html` }, id: `toolu_${i}` }]),
      )
      responses.push(buildTextResponse('All pages fetched.'))

      const { compactor, events } = makeCompactor({})
      const requestEstimates: number[] = []
      const requestMessages: Message[][] = []

      const mockStream = createMockStreamFn(responses, (_index, messages) => {
        // Estimate at the boundary the provider would see.
        const tokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) + PROMPT_OVERHEAD
        requestEstimates.push(tokens)
        requestMessages.push(messages)
      })

      const result = await runAgentLoop({
        model: 'claude-haiku-5-5',
        system: 'You are a test agent.',
        history: [],
        prompt: 'Fetch all pages.',
        tools: [tool],
        maxIterations: calls + 5,
        loopDetection: false,
        streamFn: mockStream,
        transformContext: async (messages) => {
          const out = await compactor.transform(messages)
          if (out.event) events.push(out.event)
          return out.messages
        },
      })

      expect(result.toolCalls.length).toBe(calls)
      // ≥1 summarization before any request exceeded the cap ...
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].trigger).toBe('auto')
      expect(events[0].tokensBefore).toBeGreaterThan(CAP)
      // ... and the ceiling holds for every request, which needs more than one
      // compaction once the turn outgrows what one compaction can absorb
      // (the old 60s cooldown did exactly this and let 60/90-call turns reach
      // 227k).
      expect(Math.max(...requestEstimates)).toBeLessThanOrEqual(CEILING)
      if (calls > 40) expect(events.length).toBeGreaterThanOrEqual(2)

      // One prefix rewrite per compaction: every summarized request carries a
      // summary prefix, and exactly `events.length` distinct ones exist — so
      // the calls between two compactions re-send byte-identical bytes.
      const summaryPrefixes = requestMessages
        .filter((m) => typeof m[0]?.content === 'string' && m[0].content.startsWith('[Previous conversation summary]'))
        .map((m) => JSON.stringify(m.slice(0, 2)))
      expect(summaryPrefixes.length).toBeGreaterThan(0)
      expect(new Set(summaryPrefixes).size).toBe(events.length)
    }, 60_000)
  }

  test('after a compaction every later request is byte-identical until new messages arrive', async () => {
    const { compactor } = makeCompactor({ autoCompactTokens: 10_000 })

    const messages: Message[] = [user('start')]
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'toolResult',
        toolCallId: `tc_${i}`,
        toolName: 'exec',
        content: [{ type: 'text', text: 'y'.repeat(20_000) }],
        isError: false,
        timestamp: Date.now(),
      } as any)
      messages.push(user(`after ${i}`))
    }

    const first = await compactor.transform(messages)
    expect(first.event).not.toBeNull()
    const afterFirst = JSON.stringify(first.messages)

    // Same input → identical bytes (memoized, not re-summarized).
    const again = await compactor.transform(messages)
    expect(again.event).toBeNull()
    expect(JSON.stringify(again.messages)).toBe(afterFirst)

    // New messages append to the surviving tail; the prefix is untouched.
    const grown = [...messages, user('next'), { role: 'toolResult', toolCallId: 'tc_new', toolName: 'exec', content: [{ type: 'text', text: 'z'.repeat(200) }], isError: false, timestamp: Date.now() } as any]
    const third = await compactor.transform(grown)
    expect(third.event).toBeNull()
    expect(JSON.stringify(third.messages.slice(0, 2))).toBe(JSON.stringify(first.messages.slice(0, 2)))
  })

  test('a manual request summarizes even under the cap and reports trigger=manual', async () => {
    const { compactor } = makeCompactor({ autoCompactTokens: 10_000_000 })
    const messages: Message[] = [user('hello')]
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'toolResult',
        toolCallId: `tc_${i}`,
        toolName: 'exec',
        content: [{ type: 'text', text: 'w'.repeat(4_000) }],
        isError: false,
        timestamp: Date.now(),
      } as any)
      messages.push(user(`after ${i}`))
    }

    const idle = await compactor.transform(messages)
    expect(idle.event).toBeNull()

    compactor.requestManual()
    expect(compactor.hasPendingManualRequest).toBe(true)
    const manual = await compactor.transform(messages)
    expect(manual.event?.trigger).toBe('manual')
    expect(compactor.hasPendingManualRequest).toBe(false)
  })

  test('nothing to compact is an honest no-op and clears the queued request', async () => {
    const { compactor, applied } = makeCompactor({ autoCompactTokens: 1 })
    const messages: Message[] = [user('only one message')]

    compactor.requestManual()
    const out = await compactor.transform(messages)
    expect(out.event).toBeNull()
    expect(out.messages).toBe(messages)
    expect(applied).toHaveLength(0)
    expect(compactor.hasPendingManualRequest).toBe(false)
  })

  test('the summarizer receives the whole head, including decisions from both ends', async () => {
    const { compactor, applied } = makeCompactor({
      autoCompactTokens: 50_000,
      summarize: markerSummarizer().summarize,
    })
    const messages: Message[] = [user('MARKER_DECIDED_AUTH_AT_START')]
    // 20 large tool results ≈ 100k tokens, so the head is far past 12k chars.
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: 'toolResult',
        toolCallId: `tc_${i}`,
        toolName: 'exec',
        content: [{ type: 'text', text: `step ${i} ` + 'd'.repeat(20_000) }],
        isError: false,
        timestamp: Date.now(),
      } as any)
      messages.push(user(`step ${i} done`))
    }
    // ~90% through the head — far past the 12k chars the old single-shot
    // summarizer would have sent, and outside the kept tail.
    messages.push(user('MARKER_FILE_EDITED_AT_END'))
    for (let i = 0; i < 6; i++) messages.push(user(`wrap-up ${i}`))

    const out = await compactor.transform(messages)
    expect(out.event).not.toBeNull()
    expect(applied).toHaveLength(1)
    const summary = applied[0].summary
    // The old single-shot path sent the first 12k chars only — the end marker
    // would never have made it into the summary.
    expect(summary).toContain('MARKER_DECIDED_AUTH_AT_START')
    expect(summary).toContain('MARKER_FILE_EDITED_AT_END')
  })

  test('the session is compacted, and nothing is left for a turn-boundary pass', async () => {
    const sm = new SessionManager({ keepRecentMessages: 10 })
    sm.setSummarizeFn(async (chunk, prev) => `${prev ?? ''} folded ${chunk.length}`)

    const sessionId = 'sess-midturn'
    const session = sm.getOrCreate(sessionId)
    const messages: Message[] = [user('MARKER_IN_SESSION')]
    for (let i = 0; i < 20; i++) {
      const result = {
        role: 'toolResult',
        toolCallId: `tc_${i}`,
        toolName: 'exec',
        content: [{ type: 'text', text: 'q'.repeat(20_000) }],
        isError: false,
        timestamp: Date.now(),
      } as any
      messages.push(result)
      messages.push(user(`turn ${i}`))
    }

    // Mirror the gateway: the session holds the same history the loop is
    // walking, and the compactor's `apply` writes the summary back to it.
    const { compactor } = makeCompactor({
      autoCompactTokens: 50_000,
      summarize: (head, prev) => sm.summarizeHead(head, prev),
      apply: (summary, splitIndex, o) => {
        sm.applyCompaction(sessionId, {
          summary,
          splitIndex,
          replaceSummary: o.replaceSummary,
          extraContext: undefined,
        })
      },
    })
    session.messages = [...messages]
    sm.addMessages(sessionId, ...[]) // no-op, session already seeded

    const before = sm.estimateTokens(session)
    const out = await compactor.transform(messages)
    expect(out.event).not.toBeNull()

    // The session now holds the summary + a small tail, and no longer needs a
    // second summarize at the turn boundary (that would be a duplicate row).
    expect(sm.estimateTokens(session)).toBeLessThan(before)
    expect(session.compactedSummary).toContain('folded')
    expect(sm.needsCompaction(session)).toBe(false)
    expect(sm.getDetail(sessionId)?.compactionCount).toBe(1)
  })
})
