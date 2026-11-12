// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-381 — the mid-turn compactor must count only the tool schemas that are
 * actually sent.
 *
 * Since SHO-97 a deferred tool keeps a one-line catalog entry in the system
 * prompt and no schema in the request. The compactor's overhead still summed
 * every tool, so in a workspace with many integration tools it added ~330k
 * phantom tokens: every turn looked over the 235k cap, compacted, and could
 * never get its estimate under the ~370k floor.
 */
import { describe, test, expect } from 'bun:test'
import type { Message } from '@mariozechner/pi-ai'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { MidTurnAutocompactor, MIDTURN_KEEP_RECENT_MESSAGES } from '../midturn-autocompact'
import {
  advertisedTools,
  createPromptOverheadReader,
  promptOverheadTokens,
  toolSchemaChars,
} from '../prompt-overhead'
import { estimateMessageTokens } from '../session-manager'

const CAP = 235_000
const SYSTEM_PROMPT = 's'.repeat(40_000) // 10k tokens
const DEFERRED_TOOLS = 300
const ADVERTISED_TOOLS = 20
const DEFERRED_SCHEMA_CHARS = 4_000

function makeTool(name: string, descriptionChars: number): AgentTool {
  return {
    name,
    label: name,
    description: 'd'.repeat(descriptionChars),
    parameters: { type: 'object', properties: {} } as any,
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as AgentTool
}

/**
 * A tool-heavy workspace: 300 deferred integration tools of ~4k chars each and
 * 20 advertised core tools. `active` is the advertised set, mutated by the
 * activation test to model `read_guide` mid-turn.
 */
function makeFixture() {
  const deferred = Array.from({ length: DEFERRED_TOOLS }, (_, i) =>
    makeTool(`INTEGRATION_TOOL_${i}`, DEFERRED_SCHEMA_CHARS),
  )
  const advertised = Array.from({ length: ADVERTISED_TOOLS }, (_, i) => makeTool(`core_tool_${i}`, 200))
  const tools = [...advertised, ...deferred]
  const active = new Set(advertised.map((t) => t.name))
  const isAdvertisedTool = (tool: AgentTool) => active.has(tool.name)
  return { tools, advertised, deferred, active, isAdvertisedTool }
}

/** A conversation of roughly `tokens` tokens, in user/assistant pairs. */
function conversation(tokens: number): Message[] {
  const messages: Message[] = []
  const perMessage = 2_000 // chars → ~500 tokens
  let remaining = tokens
  let i = 0
  while (remaining > 0) {
    const chars = Math.min(perMessage, remaining * 4)
    messages.push({ role: 'user', content: `u${i} ` + 'x'.repeat(chars), timestamp: 1 } as any)
    messages.push({ role: 'assistant', content: `a${i}`, timestamp: 1 } as any)
    remaining -= Math.ceil(chars / 4)
    i++
  }
  return messages
}

function makeCompactor(overhead: number | (() => number), tailBudgetTokens?: number) {
  const events: any[] = []
  let summarizeCalls = 0
  const compactor = new MidTurnAutocompactor({
    autoCompactTokens: CAP,
    keepRecentMessages: MIDTURN_KEEP_RECENT_MESSAGES,
    ...(tailBudgetTokens ? { tailBudgetTokens, minKeepMessages: 1 } : {}),
    promptOverheadTokens: overhead,
    summarize: async () => {
      summarizeCalls++
      return 'SUMMARY of the folded head'
    },
    apply: () => undefined,
  })
  return { compactor, events, summarizeCalls: () => summarizeCalls }
}

describe('SHO-381 prompt overhead counts only the advertised tools', () => {
  test('300 deferred tools add nothing; the overhead is the system prompt + advertised schemas', () => {
    const f = makeFixture()
    const overhead = promptOverheadTokens({
      systemPrompt: SYSTEM_PROMPT,
      tools: f.tools,
      isAdvertisedTool: f.isAdvertisedTool,
    })

    const advertisedChars = f.advertised.reduce((sum, t) => sum + toolSchemaChars(t), 0)
    expect(overhead).toBe(Math.ceil(SYSTEM_PROMPT.length / 4) + Math.ceil(advertisedChars / 4))
    // ~11k, not the ~311k the old all-tools sum produced.
    expect(overhead).toBeLessThan(20_000)

    // The old formula, for the record: this is what the compactor used to add.
    const allTools = Math.ceil(SYSTEM_PROMPT.length / 4) +
      f.tools.reduce((sum, t) => sum + Math.ceil(toolSchemaChars(t) / 4), 0)
    expect(allTools).toBeGreaterThan(CAP)
  })

  test('advertisedTools falls back to every tool when deferral is off', () => {
    const f = makeFixture()
    expect(advertisedTools(f.tools, undefined)).toHaveLength(f.tools.length)
    expect(advertisedTools(f.tools, f.isAdvertisedTool)).toHaveLength(ADVERTISED_TOOLS)
  })

  test('a 60k-token conversation does not compact in a tool-heavy workspace', async () => {
    const f = makeFixture()
    const overhead = createPromptOverheadReader({
      systemPrompt: SYSTEM_PROMPT,
      tools: f.tools,
      isAdvertisedTool: f.isAdvertisedTool,
    })
    const { compactor, summarizeCalls } = makeCompactor(overhead)
    const messages = conversation(60_000)

    const out = await compactor.transform(messages)
    expect(out.event).toBeNull()
    expect(summarizeCalls()).toBe(0)
    expect(out.messages).toBe(messages)
  })

  test('regression: the same fixture on the old all-tools overhead compacts', async () => {
    // This is the pre-fix behaviour, kept as the failing case: with every tool
    // schema counted, a 60k conversation looks ~370k and compacts for nothing.
    const f = makeFixture()
    const oldOverhead = Math.ceil(SYSTEM_PROMPT.length / 4) +
      f.tools.reduce((sum, t) => sum + Math.ceil(toolSchemaChars(t) / 4), 0)
    const { compactor, summarizeCalls } = makeCompactor(oldOverhead)

    const out = await compactor.transform(conversation(60_000))
    expect(out.event).not.toBeNull()
    expect(out.event!.tokensBefore).toBeGreaterThan(CAP)
    expect(summarizeCalls()).toBe(1)
  })

  test('activating a deferred tool mid-turn raises the overhead on the next call', async () => {
    const f = makeFixture()
    const overhead = createPromptOverheadReader({
      systemPrompt: SYSTEM_PROMPT,
      tools: f.tools,
      isAdvertisedTool: f.isAdvertisedTool,
    })
    const before = overhead()

    const activated = f.deferred[0]
    f.active.add(activated.name)
    const after = overhead()

    expect(after - before).toBe(Math.ceil(toolSchemaChars(activated) / 4))
    // The reader is memoized on the advertised names, so an unchanged set is
    // free and a changed one is recomputed.
    expect(overhead()).toBe(after)
  })

  test('a mid-turn compaction lands at the tail budget plus the real overhead', async () => {
    const f = makeFixture()
    const tailBudgetTokens = 94_000
    const overhead = createPromptOverheadReader({
      systemPrompt: SYSTEM_PROMPT,
      tools: f.tools,
      isAdvertisedTool: f.isAdvertisedTool,
    })
    const { compactor } = makeCompactor(overhead, tailBudgetTokens)

    const out = await compactor.transform(conversation(300_000))
    expect(out.event).not.toBeNull()
    expect(out.event!.tokensBefore).toBeGreaterThan(CAP)
    // Not a constant ~370k floor: the tail budget plus what the request really
    // carries. The summary prefix is a few dozen tokens on top.
    expect(out.event!.tokensAfter).toBeLessThanOrEqual(tailBudgetTokens + overhead() + 1_000)
    expect(out.event!.tokensAfter).toBeLessThan(out.event!.tokensBefore)
  })

  test('a numeric overhead still works (deferral off)', async () => {
    const { compactor } = makeCompactor(52_000)
    const out = await compactor.transform(conversation(60_000))
    expect(out.event).toBeNull()
    const over = await compactor.transform(conversation(200_000))
    expect(over.event).not.toBeNull()
    expect(over.event!.tokensBefore).toBeGreaterThan(200_000 + 52_000)
  })
})

describe('SHO-381 estimate sanity', () => {
  test('the fixture conversation really is ~60k tokens', () => {
    const messages = conversation(60_000)
    const tokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
    expect(tokens).toBeGreaterThan(55_000)
    expect(tokens).toBeLessThan(65_000)
  })
})
