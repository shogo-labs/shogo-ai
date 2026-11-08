// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Variant B / C and the "default is unchanged" guarantee (SHO-327).
 *
 * AC3: with no configuration, compaction output is byte-identical to before the
 * feature. AC4: under B every kept `toolCall` still has its `toolResult`, errors
 * and small results survive, the stub names the tool and its args, the facts
 * block lists what was dropped, and the turn-boundary and mid-turn paths
 * produce the same session shape.
 */
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test'
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'
import { SessionManager } from '../session-manager'
import { MidTurnAutocompactor } from '../midturn-autocompact'
import { dropToolResultsAtCompaction, DROP_MIN_RESULT_CHARS } from '../compaction-drop'
import { COMPACTION_VARIANTS, resolveCompactionVariant } from '../compaction-variants'
import { renderTranscriptForSummary } from '../compaction-transcript'
import { renderCompactionFacts, collectCompactionFacts } from '../compaction-facts'

/**
 * The summary prefix messages are stamped with `Date.now()` when a history is
 * built, so two builds in one test can straddle a millisecond and differ by 1 ms
 * (SHO-361). Pin the clock for the whole file: the byte-identical comparisons
 * below stay as strong as they are, timestamps included.
 */
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z')

beforeEach(() => setSystemTime(FIXED_NOW))
afterEach(() => setSystemTime())

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 } as UserMessage
}

function assistant(text: string, calls: Array<{ id: string; name: string; args: Record<string, any> }> = []): Message {
  const content: any[] = [{ type: 'text', text }]
  for (const c of calls) content.push({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args })
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage,
    stopReason: calls.length > 0 ? 'toolUse' : 'stop',
    timestamp: 1,
  } as unknown as AssistantMessage
}

function result(id: string, name: string, text: string, isError = false): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: 1,
  } as unknown as ToolResultMessage
}

const BIG = 'x'.repeat(4_000)
const SMALL = 'y'.repeat(100)

/** Two turns: an old one (the head) and a current one carrying the kept tail. */
function twoTurns(): Message[] {
  return [
    user('start on the payment service'),
    assistant('Reading it.', [{ id: 'c1', name: 'read_file', args: { path: 'src/pay.ts' } }]),
    result('c1', 'read_file', BIG),
    assistant('Now running the tests.', [{ id: 'c2', name: 'exec', args: { command: 'bun test' } }]),
    result('c2', 'exec', 'Error: boom at line 12', true),
    assistant('Fixed it.', [{ id: 'c3', name: 'edit_file', args: { path: 'src/pay.ts' } }]),
    result('c3', 'edit_file', 'edited 3 lines'),
    user('keep going'),
    assistant('One more read.', [{ id: 'c4', name: 'read_file', args: { path: 'src/tax.ts' } }]),
    result('c4', 'read_file', BIG),
    assistant('Still checking.', [{ id: 'c5', name: 'exec', args: { command: 'bun test' } }]),
    result('c5', 'exec', BIG),
    assistant('Almost there.', [{ id: 'c6', name: 'read_file', args: { path: 'src/fee.ts' } }]),
    result('c6', 'read_file', SMALL),
    assistant('Done reading.'),
  ]
}

const summarizer = async () => '## Decisions\n- fixed it\n## Files touched\n- src/pay.ts\n## Current state\n- testing\n'

async function compactedSession(variant: string | undefined, messages = twoTurns()): Promise<SessionManager> {
  const sm = new SessionManager({
    sessionTtlSeconds: 3600,
    maxMessages: 0,
    estimatedTokensPerMessage: 1,
    maxEstimatedTokens: 0,
    keepRecentMessages: 4,
    pruneIntervalSeconds: 3600,
    pruning: false,
    contextWindowTokens: 400_000,
    ...(variant ? { compactionVariant: variant } : {}),
  })
  sm.setSummarizeFn(summarizer)
  const id = 'session-1'
  sm.getOrCreate(id)
  sm.addMessages(id, ...messages)
  await sm.compact(id)
  return sm
}

function messagesOf(sm: SessionManager, id = 'session-1'): Message[] {
  return sm.getDetail(id) ? sm.buildHistory(id) : []
}

describe('default (no configuration) is unchanged', () => {
  test('an unconfigured manager is variant A', () => {
    expect(resolveCompactionVariant(undefined, {}).id).toBe('A')
  })

  test('A and a bare manager produce byte-identical summaries and histories', async () => {
    const a = await compactedSession('A')
    const bare = await compactedSession(undefined)
    const detailA = a.getDetail('session-1')!
    const detailBare = bare.getDetail('session-1')!
    expect(detailA.compactedSummary).toBe(detailBare.compactedSummary)
    expect(JSON.stringify(messagesOf(a))).toBe(JSON.stringify(messagesOf(bare)))
  })

  test('an unknown variant falls back to A rather than changing behaviour', () => {
    expect(resolveCompactionVariant('Z9', {}).id).toBe('A')
  })

  test('A leaves every tool result intact', async () => {
    const sm = await compactedSession('A')
    const kept = messagesOf(sm).filter((m) => m.role === 'toolResult') as ToolResultMessage[]
    expect(kept.every((m) => !m.content[0] || (m.content[0] as any).text !== undefined)).toBe(true)
    expect(messagesOf(sm).some((m) => (m as ToolResultMessage).toolCallId === 'c5' && ((m as ToolResultMessage).content[0] as any).text.startsWith('[Tool output dropped'))).toBe(false)
  })
})

describe('dropToolResultsAtCompaction', () => {
  test('keeps errors and small results, stubs the rest with the tool and its args', () => {
    const { messages, dropped } = dropToolResultsAtCompaction(twoTurns(), { protectedTurns: 0 })
    const byId = new Map(messages.map((m) => [(m as ToolResultMessage).toolCallId, m]))
    // c2 is an error, c3 and c6 are small, c4 is unconsumed at the very end.
    expect(((byId.get('c2') as ToolResultMessage).content[0] as any).text).toContain('Error: boom')
    expect(((byId.get('c3') as ToolResultMessage).content[0] as any).text).toBe('edited 3 lines')
    expect(((byId.get('c6') as ToolResultMessage).content[0] as any).text).toBe(SMALL)
    const stub = ((byId.get('c1') as ToolResultMessage).content[0] as any).text as string
    expect(stub).toContain('read_file')
    expect(stub).toContain('src/pay.ts')
    expect(stub).toContain('Re-run it')
    expect(stub).toContain((BIG.length).toLocaleString('en-US'))
    expect(dropped.map((d) => d.toolCallId).sort()).toEqual(['c1', 'c4', 'c5'])
  })

  test('never removes a result: every toolCall keeps its toolResult', () => {
    const input = twoTurns()
    const { messages } = dropToolResultsAtCompaction(input, { protectedTurns: 0 })
    const callIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const block of (msg as AssistantMessage).content as any[]) {
        if (block.type === 'toolCall') callIds.add(block.id)
      }
    }
    const resultIds = new Set(messages.filter((m) => m.role === 'toolResult').map((m) => (m as ToolResultMessage).toolCallId))
    expect([...callIds].every((id) => resultIds.has(id))).toBe(true)
    expect(messages.length).toBe(input.length)
  })

  test('protectedTurns keeps the last N assistant rounds verbatim', () => {
    const { dropped } = dropToolResultsAtCompaction(twoTurns(), { protectedTurns: 1 })
    // The last round (c6) is protected; c1/c4/c5 are still droppable.
    expect(dropped.map((d) => d.toolCallId).sort()).toEqual(['c1', 'c4', 'c5'])
    // Three rounds back protects c4, c5 and c6.
    const two = dropToolResultsAtCompaction(twoTurns(), { protectedTurns: 3 })
    expect(two.dropped.map((d) => d.toolCallId)).toEqual(['c1'])
  })

  test('a result under the floor is never dropped', () => {
    const tiny = result('c9', 'read_file', 'z'.repeat(DROP_MIN_RESULT_CHARS - 1))
    const { dropped } = dropToolResultsAtCompaction(
      [assistant('r', [{ id: 'c9', name: 'read_file', args: { path: 'a' } }]), tiny, assistant('done')],
      { protectedTurns: 0 },
    )
    expect(dropped).toEqual([])
  })
})

describe('variant B through the session manager', () => {
  test('B1 drops in the kept tail and lists the calls in the facts block', async () => {
    const sm = await compactedSession('B1')
    const summary = sm.getDetail('session-1')!.compactedSummary!
    expect(summary).toContain('## Dropped tool outputs')
    expect(summary).toContain('read_file')
    const history = messagesOf(sm)
    const dropped = history.filter(
      (m) => m.role === 'toolResult' && ((m as ToolResultMessage).content[0] as any).text.startsWith('[Tool output dropped'),
    )
    expect(dropped.length).toBeGreaterThan(0)
  })

  test('A does not grow a dropped section', async () => {
    const sm = await compactedSession('A')
    expect(sm.getDetail('session-1')!.compactedSummary!).not.toContain('## Dropped tool outputs')
  })

  test('turn-boundary and mid-turn compaction produce the same session shape', async () => {
    const boundary = await compactedSession('B1')
    const boundarySummary = boundary.getDetail('session-1')!.compactedSummary!

    // Mid-turn: the compactor applies through the same applyCompaction.
    const sm = new SessionManager({
      sessionTtlSeconds: 3600,
      maxMessages: 0,
      estimatedTokensPerMessage: 1,
      maxEstimatedTokens: 0,
      keepRecentMessages: 4,
      pruneIntervalSeconds: 3600,
      pruning: false,
      contextWindowTokens: 400_000,
      compactionVariant: 'B1',
    })
    sm.setSummarizeFn(summarizer)
    const id = 'session-2'
    sm.getOrCreate(id)
    const messages = twoTurns()
    sm.addMessages(id, ...messages)

    // Same split index as the turn-boundary path above (lastTurnStart of this
    // transcript), so the two paths are compared on equal footing.
    const compactor = new MidTurnAutocompactor({
      autoCompactTokens: 1,
      keepRecentMessages: 8,
      summarize: summarizer,
      apply: (summary, splitIndex, opts) => {
        const applied = sm.applyCompaction(id, { summary, splitIndex, replaceSummary: opts.replaceSummary })
        return applied ? { summary: applied.storedSummary, kept: applied.keptMessages } : undefined
      },
    })
    const out = await compactor.transform(messages)
    expect(out.event).not.toBeNull()

    const midSummary = sm.getDetail(id)!.compactedSummary!
    expect(midSummary).toBe(boundarySummary)

    // The emitted array carries the dropped stub, not the raw output.
    const emittedDropped = out.messages.filter(
      (m) => m.role === 'toolResult' && ((m as ToolResultMessage).content[0] as any).text.startsWith('[Tool output dropped'),
    )
    expect(emittedDropped.length).toBeGreaterThan(0)
    expect(JSON.stringify(out.messages)).toBe(JSON.stringify(sm.buildHistory(id)))
  })
})

describe('variant C: the summarizer sees no result bodies', () => {
  const transcript = () => {
    const msgs = twoTurns()
    return {
      full: renderTranscriptForSummary(msgs, { resultBodies: true }),
      lean: renderTranscriptForSummary(msgs, { resultBodies: false }),
    }
  }

  test('the body is gone and the line stays', () => {
    const { full, lean } = transcript()
    expect(full).toContain(BIG.slice(0, 50))
    expect(lean).not.toContain(BIG.slice(0, 50))
    expect(lean).toContain('← read_file result (4000 chars)')
    expect(lean.length).toBeLessThan(full.length)
  })

  test('an error keeps its head', () => {
    const { lean } = transcript()
    expect(lean).toContain('Error: boom at line 12')
  })

  test('default is unchanged (bodies included)', () => {
    const msgs = twoTurns()
    expect(renderTranscriptForSummary(msgs)).toBe(renderTranscriptForSummary(msgs, { resultBodies: true }))
  })
})

describe('facts block', () => {
  test('renders the dropped calls only when something was dropped', () => {
    const msgs = twoTurns()
    const facts = collectCompactionFacts(msgs)
    const plain = renderCompactionFacts(facts)
    expect(plain).not.toContain('Dropped tool outputs')
    const withDrop = renderCompactionFacts(facts, {
      dropped: [{ toolName: 'read_file', toolCallId: 'c1', args: '{"path":"src/pay.ts"}', chars: 4000 }],
    })
    expect(withDrop).toContain('## Dropped tool outputs')
    expect(withDrop).toContain('read_file({"path":"src/pay.ts"})')
  })
})

describe('variant table', () => {
  test('D is B1 plus C', () => {
    expect(COMPACTION_VARIANTS.D.dropToolResultProtectedTurns).toBe(1)
    expect(COMPACTION_VARIANTS.D.summaryOmitsResultBodies).toBe(true)
    expect(COMPACTION_VARIANTS.C.dropToolResultProtectedTurns).toBeNull()
    expect(COMPACTION_VARIANTS.B2.dropToolResultProtectedTurns).toBe(2)
  })
})
