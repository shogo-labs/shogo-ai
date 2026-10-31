// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 acceptance (§"Acceptance criteria" of the card) — measured on the
 * request that would go on the wire, through a REAL `AgentGateway.agentTurn`
 * and a REAL `runAgentLoop`, not on the session object.
 *
 * The card's own tests drive `runAgentLoop` with a hand-built transformContext
 * and a compactor whose `apply` does not touch a session. These drive the
 * gateway instead, because that is the wiring the card is about: the threshold
 * comes from the resolved model, the compactor is built inside `agentTurn`, the
 * session is kept in step by `onProgress`, and the transcript frame is written
 * by the same code path the API persists.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { DEFAULT_AUTOCOMPACT_TOKENS, estimateMessageTokens, resolveAutoCompactTokens } from '../session-manager'
import {
  buildSummaryPrefixMessages,
  splitIndexForCompaction,
} from '../session-manager'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = join(tmpdir(), 'qa-sho96')
const CAP = DEFAULT_AUTOCOMPACT_TOKENS
/** The card's ceiling: a request may not be estimated above cap + 5k. */
const CEILING = CAP + 5_000

let lastOverhead = 0

function makeWs(name: string, model: string): string {
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
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\ncontext summarization acceptance\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

interface TurnResult {
  /** Estimated size of each request AT the streamFn boundary (messages only). */
  sizes: number[]
  /** Same, plus the system prompt + tool schemas the request also carries. */
  wire: number[]
  /** JSON of each request's messages, for byte-stability checks. */
  payloads: string[]
  frames: any[]
  compactionFrames: any[]
  usageFrames: any[]
  session: any
  /** messages-only size of the request the compactor rewrote. */
  triggerSizes: number[]
  /** session-manager estimate of the persisted session at turn end */
  sessionEstimate: number
  /** the system prompt + tool schema overhead the gateway used this turn */
  promptOverhead: number
  /** the same overhead, measured independently at the provider boundary */
  measuredOverhead: number
  metrics: { summarized: number; fallbacks: number }
}

/**
 * One real turn: N tool calls that each return `charsPerResult` characters.
 * The provider is mocked; everything from `agentTurn` down is production code.
 */
async function runTurn(opts: {
  name: string
  model?: string
  toolCalls: number
  charsPerResult?: number
  prompt?: string
}): Promise<TurnResult> {
  const ws = makeWs(opts.name, opts.model ?? 'claude-haiku-5-5')
  trustWorkspaceForTests(ws)
  const gw = new AgentGateway(ws, `p-${opts.name}`)
  const body = 'x'.repeat(opts.charsPerResult ?? 30_000)
  gw.setToolMocks({ read_file: () => body })
  const responses = Array.from({ length: opts.toolCalls }, (_, i) =>
    buildToolUseResponse([{ name: 'read_file', arguments: { path: `f-${i}.txt` }, id: `toolu_${i}` }]),
  )
  responses.push(buildTextResponse('all files read'))

  const sizes: number[] = []
  const payloads: string[] = []
  const sm = gw.getSessionManager()
  // The overhead is measured from the request the provider actually receives
  // (system prompt + tool schemas), not from anything the runtime reports — an
  // implementation that forgot it would otherwise agree with itself.
  let measuredOverhead = -1
  const inner = createMockStreamFn(responses, (_i, messages: Message[]) => {
    sizes.push(sm.estimateMessagesTokens(messages))
    payloads.push(JSON.stringify(messages))
  })
  const capturing = ((model: any, context: any, options: any) => {
    if (measuredOverhead < 0) {
      const sys = typeof context.systemPrompt === 'string' ? context.systemPrompt : ''
      const toolChars = (context.tools ?? []).reduce(
        (sum: number, t: any) => sum + JSON.stringify({ name: t.name, description: t.description, input_schema: t.parameters }).length,
        0,
      )
      measuredOverhead = Math.ceil(sys.length / 4) + Math.ceil(toolChars / 4)
    }
    return inner(model, context, options)
  }) as any
  gw.setStreamFn(capturing)

  await gw.start()
  const frames: any[] = []
  /** call index of the request each compaction frame precedes */
  const frameCalls: number[] = []
  try {
    await (gw as any).agentTurn(opts.prompt ?? 'read every file', 'sess-qa96', false, undefined, {
      write: (chunk: any) => {
        frames.push(chunk)
        if (chunk.type === 'data-context-summarized') frameCalls.push(sizes.length)
      },
    })
    const session = (sm as any).sessions.get('sess-qa96')
    const compactionFrames = frames.filter((f) => f.type === 'data-context-summarized')
    // The compactor measures `messages + promptOverheadTokens`; recover the
    // overhead exactly. `write` is batched, so frame arrival cannot be paired
    // with a call — but the request it rewrote is the one right before the
    // first sharp drop in size, and that pair is unambiguous.
    let dropIdx = -1
    for (let i = 0; i < sizes.length - 1; i++) {
      if (sizes[i] - sizes[i + 1] > 40_000) { dropIdx = i; break }
    }
    // What the runtime *believes* it is sending, recovered from its own frame.
    const runtimeOverhead = dropIdx >= 0 && compactionFrames.length
      ? (compactionFrames[0].data.tokensBefore as number) - sizes[dropIdx]
      : 0
    const overhead = measuredOverhead
    return {
      sizes,
      wire: sizes.map((s) => s + overhead),
      payloads,
      frames,
      compactionFrames,
      usageFrames: frames.filter((f) => f.type === 'data-context-usage'),
      session,
      triggerSizes: frameCalls.map((c) => sizes[c]),
      sessionEstimate: sm.estimateTokens(session),
      measuredOverhead,
      promptOverhead: runtimeOverhead,
      metrics: (gw as any).sessionManager?.summarizationMetrics?.() ?? { summarized: 0, fallbacks: 0 },
    }
  } finally {
    clearTrustForTests()
    try { await gw.stop() } catch {}
  }
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
beforeEach(() => { delete process.env.AGENT_AUTOCOMPACT_TOKENS })
afterAll(() => { try { clearTrustForTests() } catch {}; rmSync(ROOT, { recursive: true, force: true }) })

describe('SHO-96 acceptance', () => {
  // ---------------------------------------------------------------- AC 1
  test('AC1: a 1M-window model (haiku-5-5) is budgeted at 200k, and the gateway applies it', async () => {
    // The threshold function itself.
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBe(CAP)
    expect(resolveAutoCompactTokens({ contextWindowTokens: 1_000_000 })).toBeLessThan(968_616)

    // ... and the gateway feeds it the model's real window (nothing used to
    // write `contextWindowTokens`, so every model floated on 200k − reserve).
    const ws = makeWs('ac1', 'claude-haiku-5-5')
    trustWorkspaceForTests(ws)
    const gw = new AgentGateway(ws, 'p-ac1')
    gw.setToolMocks({ read_file: () => 'ok' })
    gw.setStreamFn(createMockStreamFn([buildTextResponse('hi')]))
    await gw.start()
    try {
      await (gw as any).agentTurn('hello', 'sess-ac1', false, undefined, { write: () => {} })
      const sm = gw.getSessionManager()
      expect(sm.contextWindowTokens).toBe(1_000_000)
      expect(sm.autocompactThreshold).toBe(CAP)
    } finally {
      clearTrustForTests()
      try { await gw.stop() } catch {}
    }
  }, 60_000)

  // ---------------------------------------------------------------- AC 2
  test('AC2: a 40-tool-call turn never sends a request above the ceiling', async () => {
    const r = await runTurn({ name: 'ac2', toolCalls: 40 })
    console.log('AC2 wire max=', Math.max(...r.wire), 'triggers=', r.triggerSizes.join(','), 'frames=', r.compactionFrames.map((f: any) => `${f.data.tokensBefore}->${f.data.tokensAfter}/${f.data.messagesBefore}->${f.data.messagesAfter}`).join(' | '), 'metrics=', JSON.stringify(r.metrics))
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...r.wire)).toBeLessThanOrEqual(CEILING)
  }, 120_000)

  test('AC2: a longer turn (60 tool calls) also never exceeds the ceiling', async () => {
    const r = await runTurn({ name: 'ac2-long', toolCalls: 60 })
    console.log('AC2LONG wire max=', Math.max(...r.wire), 'over=', r.wire.filter((x) => x > CEILING).length, 'triggers=', r.triggerSizes.join(','), 'frames=', r.compactionFrames.map((f: any) => `${f.data.tokensBefore}->${f.data.tokensAfter}`).join(' | '))
    expect(r.compactionFrames.length).toBeGreaterThanOrEqual(1)
    const over = r.wire.filter((s) => s > CEILING)
    expect({ over: over.length, max: Math.max(...r.wire), cap: CAP }).toEqual({
      over: 0,
      max: Math.max(...r.wire),
      cap: CAP,
    })
  }, 180_000)

  // ---------------------------------------------------------------- AC 4
  test('AC4: one transcript row per compaction, and the session is really compacted', async () => {
    const r = await runTurn({ name: 'ac4', toolCalls: 60 })
    const autoFrames = r.compactionFrames.filter((f: any) => f.data.trigger === 'auto')
    // A long turn compacts more than once now that the cap is enforced on every
    // call; each one must be its own row.
    expect(autoFrames.length).toBeGreaterThanOrEqual(2)
    // One row per compaction: nothing runs at turn end (SHO-259), so the rows
    // the loop emitted are the whole story.
    expect(r.session.compactionCount).toBe(autoFrames.length)
    for (const f of autoFrames) {
      expect(f.data.tokensAfter).toBeLessThan(f.data.tokensBefore)
      expect(f.data.messagesAfter).toBeLessThan(f.data.messagesBefore)
      expect(f.data.summaryChars).toBeGreaterThan(0)
    }
    // The summary was written back to the session, and the head was really
    // dropped: `totalMessages` counts everything the turn ever held, while
    // `messages` holds the kept tail + what arrived after the rewrite.
    expect(r.session.compactedSummary?.length ?? 0).toBeGreaterThan(0)
    expect(r.session.totalMessages).toBeGreaterThan(r.session.messages.length)
    expect(JSON.stringify(r.session.messages[0])).not.toContain('read every file')
  }, 120_000)

  // ---------------------------------------------------------------- AC 5
  test('AC5: the dock ring never exceeds the cap and ends on the real session size', async () => {
    const r = await runTurn({ name: 'ac5', toolCalls: 60 })
    expect(r.usageFrames.length).toBeGreaterThan(1)
    // The pre-fix ring read 400k on a 200k request: it must never report more
    // than the cap, and never more than the biggest request actually sent.
    for (const f of r.usageFrames) {
      expect(f.data.inputTokens).toBeLessThanOrEqual(CAP + 5_000)
      expect(f.data.inputTokens).toBeLessThanOrEqual(Math.max(...r.wire) + 5_000)
    }
    // ... and it is not a stale running total: at turn end the ring reports the
    // persisted session, which is what a reload repaints.
    const last = r.usageFrames[r.usageFrames.length - 1].data.inputTokens
    const expected = r.sessionEstimate + r.promptOverhead
    // Within 15%: the ring is a snapshot taken at the last compaction plus the
    // turn's growth, and the pre-fix failure mode was a multiple of this, not a
    // few percent.
    expect(Math.abs(last - expected)).toBeLessThanOrEqual(Math.max(2_000, Math.ceil(expected * 0.15)))
  }, 120_000)

  // ---------------------------------------------------------------- AC 7
  test('AC7: one prefix rewrite per compaction, byte-identical in between', async () => {
    const r = await runTurn({ name: 'ac7', toolCalls: 60 })
    const prefixOf = (json: string) => JSON.stringify(JSON.parse(json).slice(0, 2))
    const prefixes = r.payloads.map(prefixOf)
    const compactions = r.compactionFrames.filter((f: any) => f.data.trigger === 'auto').length
    expect(compactions).toBeGreaterThanOrEqual(2)

    // A prefix rewrite is only legal on a compaction: the number of changes must
    // equal the number of compactions, never one per call.
    // The first call of a turn carries one message, so `slice(0, 2)` is not yet
    // a prefix: start comparing once two messages exist.
    const hasTwo = (p: string) => JSON.parse(p).length >= 2
    const stableFrom = prefixes.findIndex(hasTwo)
    expect(stableFrom).toBeGreaterThanOrEqual(0)
    const boundaries: number[] = []
    for (let i = stableFrom + 1; i < prefixes.length; i++) {
      if (prefixes[i] !== prefixes[i - 1]) boundaries.push(i)
    }
    {
      const show = (p: string) => {
        const arr = JSON.parse(p)
        return arr.map((m: any) => `${m.role}:${String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 70)}`).join(' || ')
      }
      if (process.env.QA_DIAG) console.log('AC7DIAG calls=', prefixes.length, 'frames=', r.compactionFrames.map((f: any) => `${f.data.tokensBefore}->${f.data.tokensAfter}/${f.data.messagesBefore}->${f.data.messagesAfter}`).join(' | '))
      if (process.env.QA_DIAG) for (const b of boundaries) console.log(`AC7DIAG boundary@${b}\n  before: ${show(prefixes[b - 1])}\n  after : ${show(prefixes[b])}`)
    }
    expect(boundaries).toHaveLength(compactions)

    // Inside an epoch the bytes are identical — that is the cache-read case.
    let start = stableFrom
    for (const end of [...boundaries, prefixes.length]) {
      expect(end - start).toBeGreaterThan(1)
      for (let i = start; i < end; i++) expect(prefixes[i]).toBe(prefixes[start])
      start = end
    }
    // The first request carries no summary; every later epoch opens with one.
    expect(prefixes[stableFrom]).not.toContain('[Previous conversation summary]')
    expect(prefixes[boundaries[0]]).toContain('[Previous conversation summary]')
  }, 120_000)

  // ---------------------------------------------------------------- AC 3
  test('AC3: the summarizer folds the whole head in chunks (no 12k-char truncation)', async () => {
    // A head whose first and last tenths carry a marker. The old single-shot
    // path sent only the first 12k chars, so the trailing marker never made it.
    const SM = await import('../session-manager')
    const sm = new SM.SessionManager({ keepRecentMessages: 4, summarizeChunkTokens: 10_000 })
    const seen: number[] = []
    sm.setSummarizeFn(async (chunk, prev) => {
      seen.push(chunk.length)
      const text = chunk
        .map((m: any) => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')))
        .join('\n')
      const markers = [...text.matchAll(/MARKER_[A-Z0-9_]+/g)].map((m) => m[0])
      return [prev, ...markers].filter(Boolean).join(' ')
    })
    const head: Message[] = [{ role: 'user', content: 'MARKER_DECISION_AT_START', timestamp: 1 } as any]
    for (let i = 0; i < 20; i++) {
      head.push({ role: 'toolResult', toolCallId: `t${i}`, toolName: 'exec', isError: false, timestamp: 1, content: [{ type: 'text', text: `step ${i} ` + 'd'.repeat(20_000) }] } as any)
      head.push({ role: 'user', content: `step ${i} done`, timestamp: 1 } as any)
    }
    head.push({ role: 'user', content: 'MARKER_FILE_EDITED_AT_END', timestamp: 1 } as any)

    const summary = await sm.summarizeHead(head)
    expect(seen.length).toBeGreaterThan(1) // chunked, not one 24k window
    expect(summary).toContain('MARKER_DECISION_AT_START')
    expect(summary).toContain('MARKER_FILE_EDITED_AT_END')
    expect(head.length).toBeGreaterThan(40)
  })
})

describe('SHO-96 helper contracts the acceptance criteria lean on', () => {
  test('the split never lands mid tool-result chain and keeps the recent tail', () => {
    const messages: Message[] = []
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'user', content: `u${i}`, timestamp: 1 } as any)
      messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'exec', arguments: {} }], timestamp: 1 } as any)
      messages.push({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'exec', isError: false, content: [{ type: 'text', text: 'r' }], timestamp: 1 } as any)
    }
    const split = splitIndexForCompaction(messages, 4)
    expect(split).not.toBeNull()
    expect(messages[split!].role).toBe('user')
    expect(messages.length - split!).toBeGreaterThan(0)
  })

  test('the summary prefix is the same two messages the turn-boundary path writes', () => {
    const prefix = buildSummaryPrefixMessages('the summary')
    expect(prefix).toHaveLength(2)
    expect(prefix[0].role).toBe('user')
    expect(String((prefix[0] as any).content)).toContain('the summary')
    expect(prefix[1].role).toBe('assistant')
  })
})
