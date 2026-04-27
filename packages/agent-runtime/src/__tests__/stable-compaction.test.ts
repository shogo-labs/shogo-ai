// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the prefix-stability invariants of stableTransformContext.
 *
 * The critical contract: for any tool_call_id that has been "decided" in a
 * prior call, the emitted bytes in a subsequent call MUST be identical. If
 * this breaks, the prompt-cache prefix shifts and per-request cache-write
 * cost explodes (the observed failure mode on the naive approach).
 */

import { describe, test, expect } from 'bun:test'
import type { Message, UserMessage, AssistantMessage, ToolResultMessage, TextContent } from '@mariozechner/pi-ai'
import {
  createContentReplacementState,
  stableTransformContext,
  pruneReplacementState,
} from '../stable-compaction'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function assistantToolCall(toolName: string, toolCallId: string, args: Record<string, any> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: args }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as any
}

function assistantText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function toolResult(text: string, toolCallId: string, toolName = 'exec'): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage
}

function extractText(msg: Message): string {
  if (msg.role !== 'toolResult') return ''
  return (msg as ToolResultMessage).content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

/**
 * Build a conversation of `nTurns` tool-use iterations, each producing one
 * large exec tool result (10k chars) and one short assistant summary. This
 * is the adversarial pattern: budget and window shift with every turn.
 */
function buildToolLoop(nTurns: number, resultSize = 10_000): Message[] {
  const msgs: Message[] = [user('initial prompt')]
  for (let i = 0; i < nTurns; i++) {
    const id = `tc_${i}`
    msgs.push(assistantToolCall('exec', id, { cmd: `cmd-${i}` }))
    msgs.push(toolResult('X'.repeat(resultSize) + `\n--- result ${i} ---`, id))
    msgs.push(assistantText(`summary for turn ${i}`))
  }
  return msgs
}

// ---------------------------------------------------------------------------
// Prefix-stability invariants
// ---------------------------------------------------------------------------

describe('stableTransformContext: prefix-stability invariant', () => {
  test('identical input produces byte-identical output across calls', () => {
    const state = createContentReplacementState()
    const msgs = buildToolLoop(8)
    const budget = 200_000

    const r1 = stableTransformContext(msgs, state, budget)
    const r2 = stableTransformContext(msgs, state, budget)

    expect(r1.messages.length).toBe(r2.messages.length)
    for (let i = 0; i < r1.messages.length; i++) {
      expect(extractText(r1.messages[i])).toBe(extractText(r2.messages[i]))
    }
  })

  test('decided tool_call_ids produce byte-identical bytes as history grows', () => {
    const state = createContentReplacementState()
    const budget = 80_000

    // Call 1: history with 6 turns.
    const h1 = buildToolLoop(6)
    const r1 = stableTransformContext(h1, state, budget)
    const snapshotsByCall1: Map<string, string> = new Map()
    for (let i = 0; i < h1.length; i++) {
      const m = h1[i]
      if (m.role === 'toolResult') {
        snapshotsByCall1.set((m as ToolResultMessage).toolCallId, extractText(r1.messages[i]))
      }
    }
    // Capture decided-after-call-1 set BEFORE call 2 mutates state further.
    const decidedAfterCall1 = new Set<string>([
      ...state.replacements.keys(),
      ...state.seenAndPreserved,
    ])

    // Call 2: same history + one more turn appended.
    const h2 = [
      ...h1,
      assistantToolCall('exec', 'tc_NEW', { cmd: 'fresh' }),
      toolResult('Y'.repeat(10_000), 'tc_NEW'),
      assistantText('summary NEW'),
    ]
    const r2 = stableTransformContext(h2, state, budget)

    // For every id decided in call 1, call 2's bytes must match call 1's.
    // Ids that were still in the protected window during call 1 (and decided
    // only in call 2 as they exited) are legitimately allowed to change.
    for (let i = 0; i < h1.length; i++) {
      const m = h1[i]
      if (m.role !== 'toolResult') continue
      const id = (m as ToolResultMessage).toolCallId
      if (!decidedAfterCall1.has(id)) continue
      const c2Text = extractText(r2.messages[i])
      const c1Text = snapshotsByCall1.get(id)!
      expect(c2Text).toBe(c1Text)
    }
  })

  test('decided ids remain byte-identical across many calls with growing history', () => {
    const state = createContentReplacementState()
    const budget = 60_000

    // Simulate 10 iterations of the agent loop, appending one turn each time.
    let history = buildToolLoop(3)
    const perIdHistory: Map<string, string[]> = new Map()
    const perIdDecidedAt: Map<string, number> = new Map()

    for (let iter = 0; iter < 10; iter++) {
      history = [
        ...history,
        assistantToolCall('exec', `tc_iter_${iter}`, { cmd: `iter-${iter}` }),
        toolResult('Z'.repeat(10_000) + `\n--- iter ${iter} ---`, `tc_iter_${iter}`),
        assistantText(`summary iter ${iter}`),
      ]
      const r = stableTransformContext(history, state, budget)
      for (let i = 0; i < history.length; i++) {
        const m = history[i]
        if (m.role !== 'toolResult') continue
        const id = (m as ToolResultMessage).toolCallId
        const text = extractText(r.messages[i])
        const arr = perIdHistory.get(id) ?? []
        arr.push(text)
        perIdHistory.set(id, arr)
        if ((state.replacements.has(id) || state.seenAndPreserved.has(id)) && !perIdDecidedAt.has(id)) {
          perIdDecidedAt.set(id, iter)
        }
      }
    }

    // For every id that was ever decided, all bytes observed from the
    // iteration it was decided onwards must be identical.
    for (const [id, decisions] of perIdHistory) {
      const decidedIter = perIdDecidedAt.get(id)
      if (decidedIter === undefined) continue
      // Count of observations from that iter onwards. The id may have appeared
      // in earlier iters too (but possibly with different content — those are
      // the pre-decision observations, which are the one-time break).
      const postDecisionBytes = decisions.slice(decisions.length - (10 - decidedIter))
      const first = postDecisionBytes[0]
      for (const b of postDecisionBytes) {
        expect(b).toBe(first)
      }
    }
  })

  test('recent protected window ids are locked as seenAndPreserved on first sight', () => {
    // Prior to the protected-window-exit cache-break fix, tool_results
    // inside the protected window were deliberately left out of state —
    // the original intent being "don't commit to a compaction decision
    // for something we might still be reasoning about". That was the
    // source of the cache-break regression: once the id aged out of the
    // window, the layers would run and flip bytes.
    //
    // The fix inverts that: we commit to a "preserved" decision on first
    // sight for every id, including those inside the protected window.
    // Since all three layers pass protected-window results through
    // unchanged, origText === finalText → recorded as seenAndPreserved.
    // When the id later exits the window, frozenIds causes all three
    // layers to skip it, so the wire bytes never change.
    const state = createContentReplacementState()
    const msgs = buildToolLoop(5)
    const budget = 100_000

    stableTransformContext(msgs, state, budget)

    // Every tool_result (tc_0..tc_4) must now have a decision recorded,
    // including the most-recent tc_4 inside the protected window.
    for (let i = 0; i < 5; i++) {
      const id = `tc_${i}`
      expect(state.replacements.has(id) || state.seenAndPreserved.has(id)).toBe(true)
    }
    // tc_4 specifically: layers left it alone → preserved, not replaced.
    expect(state.seenAndPreserved.has('tc_4')).toBe(true)
    expect(state.replacements.has('tc_4')).toBe(false)
  })

  test('messages outside protected window become decided on first observation', () => {
    const state = createContentReplacementState()
    const msgs = buildToolLoop(5)
    const budget = 100_000

    stableTransformContext(msgs, state, budget)

    // Everything outside the protected window should be decided.
    for (const id of ['tc_0', 'tc_1', 'tc_2', 'tc_3']) {
      expect(state.replacements.has(id) || state.seenAndPreserved.has(id)).toBe(true)
    }
  })

  test('under-budget small results are preserved (seenAndPreserved), not replaced', () => {
    // Tool results well below the microcompact threshold (2000) and with no
    // budget pressure should pass through untouched but still be locked in.
    const state = createContentReplacementState()
    const msgs: Message[] = [user('start')]
    for (let i = 0; i < 5; i++) {
      msgs.push(assistantToolCall('exec', `tc_${i}`))
      msgs.push(toolResult('small output', `tc_${i}`))
      msgs.push(assistantText(`done ${i}`))
    }
    const budget = 1_000_000 // huge budget → no trim

    stableTransformContext(msgs, state, budget)

    // Older ids should be in seenAndPreserved (not replaced).
    expect(state.seenAndPreserved.has('tc_0')).toBe(true)
    expect(state.seenAndPreserved.has('tc_1')).toBe(true)
    expect(state.replacements.has('tc_0')).toBe(false)
    expect(state.replacements.has('tc_1')).toBe(false)
  })

  test('consumed large results get replaced with a snip placeholder', () => {
    const state = createContentReplacementState()
    const msgs = buildToolLoop(5)
    const budget = 1_000_000 // no budget pressure; snip should still fire

    stableTransformContext(msgs, state, budget)

    // tc_0..tc_1 are out of the protected window AND have following
    // assistant messages AND are >200 chars → snipConsumedResults should
    // have replaced them.
    expect(state.replacements.has('tc_0')).toBe(true)
    expect(state.replacements.has('tc_1')).toBe(true)
    expect(state.replacements.get('tc_0')).toContain('[Tool output processed')
  })

  // -------------------------------------------------------------------------
  // Regression: cache break when a message exits the protected window
  // -------------------------------------------------------------------------
  //
  // Observed in production (2026-04):
  //   turn=1 with 245 existing tool results, running a long tool-use loop.
  //   Cache-read collapses to ~8k tokens (= sys + tools only, no messages)
  //   on exactly the calls where `newDecided > 0 && R >= 1`.
  //   Calls with `newDecided=0` cache-read the full ~100k prefix.
  //
  // Hypothesis:
  //   Inside the protected window, layers pass tool_results through as-is.
  //   The bytes sent to the API on those calls are the ORIGINAL content.
  //   When history grows and the message exits the protected window, layers
  //   fire and produce COMPACTED bytes. stableTransformContext then records
  //   that compacted text into state.replacements. But the POSITION of this
  //   tool_result in the prefix is the same as it was in prior calls — and
  //   its bytes just changed from original to compacted. The Anthropic cache
  //   key diverges at that position → cache miss for everything after.
  //
  // This test proves the bug by comparing what stableTransformContext emits
  // for a single tool_result across two calls: one where the result is
  // inside the protected window, and one where it has just exited.
  describe('REGRESSION: protected window exit breaks cache', () => {
    test('a tool_result inside the protected window on call 1 keeps the same bytes after it exits on call 2', () => {
      // This test was written to expose the regression where a tool_result
      // first sent while inside the protected window (pass-through, no
      // state entry recorded) would later flip bytes when it exited the
      // window and layers finally decided to compact it. The fix is to
      // record a `seenAndPreserved` decision on first sight regardless of
      // protected-window membership — future calls then frozenIds-skip it
      // and original bytes persist.
      const state = createContentReplacementState()
      const budget = 200_000

      // Call 1: one tool-call iteration only. tc_0 is inside the protected
      // window → layers pass through unchanged. With the fix, the
      // recording loop sees origText === finalText and locks tc_0 in
      // state.seenAndPreserved. Wire bytes at position 2 are the ORIGINAL
      // 10k of X's.
      const h1: Message[] = [
        user('start'),
        assistantToolCall('exec', 'tc_0', { cmd: 'ls' }),
        toolResult('X'.repeat(10_000) + '\n--- result 0 ---', 'tc_0'),
      ]
      const r1 = stableTransformContext(h1, state, budget)
      expect(state.replacements.has('tc_0')).toBe(false)
      expect(state.seenAndPreserved.has('tc_0')).toBe(true)
      const bytesCall1 = JSON.stringify(r1.messages[2])
      expect(bytesCall1).toContain('XXXXXXXXXX') // sanity: original content

      // Call 2: two more iterations + a trailing text summary. tc_0 is
      // now outside the protected window, but frozenIds contains it →
      // all three layers skip it → bytes at position 2 are still the
      // original 10k of X's. This is the fix.
      const h2: Message[] = [
        ...h1,
        assistantText('summary 0'),
        assistantToolCall('exec', 'tc_1', { cmd: 'cat' }),
        toolResult('Y'.repeat(10_000) + '\n--- result 1 ---', 'tc_1'),
        assistantText('summary 1'),
        assistantToolCall('exec', 'tc_2', { cmd: 'grep' }),
        toolResult('Z'.repeat(10_000) + '\n--- result 2 ---', 'tc_2'),
        assistantText('summary 2'),
      ]
      const r2 = stableTransformContext(h2, state, budget)
      const bytesCall2 = JSON.stringify(r2.messages[2])

      expect(bytesCall2).toBe(bytesCall1)
    })

    test('1 user turn, 10 tool-use iterations: prefix bytes must never shift once sent', () => {
      // This mirrors the production failure pattern: a single user turn
      // where the agent runs 10 tool-use iterations back-to-back. On each
      // iteration, pi-agent-core calls streamAssistantResponse exactly once,
      // which triggers transformContext exactly once. The test replays that
      // outer loop: append (toolCallAssistant, toolResult) → stableTransformContext
      // → capture wire bytes. Between iterations the assistant's final text
      // summary is produced only on the LAST iteration (it's what ends the
      // turn), so inside the loop we only append tc+tr pairs.
      //
      // Invariant under test: for any position that was sent to the API on
      // iteration I, the JSON bytes at that position on all later
      // iterations J > I must be identical. Otherwise the Anthropic prompt
      // cache key diverges at that position, forcing a full cache rewrite
      // of everything after — which is exactly the 8242-token cache-read
      // floor we observed in production logs (= sys+tools only).
      const state = createContentReplacementState()
      const budget = 200_000

      let history: Message[] = [user('please refactor X across the codebase')]
      const perPositionHistory: Map<number, string[]> = new Map()
      const iterCount = 10

      for (let iter = 0; iter < iterCount; iter++) {
        // Append one iteration: assistant makes a tool call, we append its
        // result. NO text summary mid-loop — in real operation the text
        // summary only arrives after the LAST tool call when the model
        // decides it's done.
        history = [
          ...history,
          assistantToolCall('exec', `tc_${iter}`, { cmd: `cmd-${iter}` }),
          toolResult('X'.repeat(10_000) + `\n--- result ${iter} ---`, `tc_${iter}`),
        ]
        const r = stableTransformContext(history, state, budget)
        for (let pos = 0; pos < r.messages.length; pos++) {
          const arr = perPositionHistory.get(pos) ?? []
          arr.push(JSON.stringify(r.messages[pos]))
          perPositionHistory.set(pos, arr)
        }
      }

      // Collect every position where bytes diverged from the first time it
      // was sent. Report the iteration at which each divergence first
      // appeared — that's where the cache broke.
      const divergences: Array<{
        pos: number
        firstSeenIter: number
        divergedAtIter: number
        from: string
        to: string
      }> = []
      for (const [pos, snapshots] of perPositionHistory) {
        const first = snapshots[0]
        // firstSeenIter is the iteration at which this position first had a
        // snapshot. Position p first appears at iteration (p is 0-indexed
        // into snapshots but position vs iteration mapping depends on
        // history growth — snapshots.length tells us how many iterations
        // this position has existed for).
        const firstSeenIter = iterCount - snapshots.length
        for (let i = 1; i < snapshots.length; i++) {
          if (snapshots[i] !== first) {
            divergences.push({
              pos,
              firstSeenIter,
              divergedAtIter: firstSeenIter + i,
              from: first.slice(0, 140),
              to: snapshots[i].slice(0, 140),
            })
            break
          }
        }
      }

      if (divergences.length > 0) {
        console.log(`\n❌ ${divergences.length} positions changed bytes mid-session (cache breaks):`)
        console.log(`   Each row = 1 position whose wire bytes diverged between two calls.\n`)
        for (const d of divergences.slice(0, 10)) {
          console.log(`  pos=${d.pos} first-sent-iter=${d.firstSeenIter} diverged-at-iter=${d.divergedAtIter}`)
          console.log(`    was:  ${d.from}...`)
          console.log(`    now:  ${d.to}...`)
        }
        console.log(`\n   Real-world effect: on iter=${divergences[0].divergedAtIter}, the prompt-cache`)
        console.log(`   lookup diverges at pos=${divergences[0].pos}, so everything from that`)
        console.log(`   position onward is cache-miss → cache-read collapses to the`)
        console.log(`   invariant prefix (sys + tools only), observed as ~8k tokens in`)
        console.log(`   a session with ~100k-token history.\n`)
      }
      expect(divergences).toEqual([])
    })
  })

  test('frozenIds-aware layers skip decided ids even under fresh budget pressure', () => {
    // Scenario: first call at loose budget locks some ids as "preserved"
    // (small, no snip, no microcompact, no budget trim). Second call at
    // tight budget must NOT re-compact those preserved ids (would break
    // cache). It should tolerate being over-budget rather than revisit a
    // locked decision.
    const state = createContentReplacementState()
    // 150-char results: below microcompact threshold (2000) AND below
    // snip threshold (200), so all three layers no-op → seenAndPreserved.
    const msgs = buildToolLoop(5, 150)
    const looseBudget = 10_000_000
    const tightBudget = 1_000 // basically forces compaction if state allowed it

    // Call 1: no pressure → older ids get locked as preserved.
    stableTransformContext(msgs, state, looseBudget)
    const preservedIds = new Set(state.seenAndPreserved)
    expect(preservedIds.size).toBeGreaterThan(0)

    // Snapshot the bytes emitted for preserved ids in call 1.
    const call1Out = stableTransformContext(msgs, state, looseBudget)
    const preservedSnapshots = new Map<string, string>()
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role !== 'toolResult') continue
      const id = (m as ToolResultMessage).toolCallId
      if (preservedIds.has(id)) {
        preservedSnapshots.set(id, extractText(call1Out.messages[i]))
      }
    }

    // Call 2: tight budget. Preserved ids must emit the same bytes.
    const call2Out = stableTransformContext(msgs, state, tightBudget)
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role !== 'toolResult') continue
      const id = (m as ToolResultMessage).toolCallId
      if (!preservedIds.has(id)) continue
      expect(extractText(call2Out.messages[i])).toBe(preservedSnapshots.get(id)!)
    }
  })
})

// ---------------------------------------------------------------------------
// Management helpers
// ---------------------------------------------------------------------------

describe('pruneReplacementState', () => {
  test('drops entries whose ids no longer appear in messages', () => {
    const state = createContentReplacementState()
    state.replacements.set('live', 'replacement')
    state.replacements.set('stale', 'replacement')
    state.seenAndPreserved.add('liveP')
    state.seenAndPreserved.add('staleP')

    const msgs: Message[] = [
      user('x'),
      assistantToolCall('exec', 'live'),
      toolResult('a', 'live'),
      assistantToolCall('exec', 'liveP'),
      toolResult('b', 'liveP'),
    ]

    pruneReplacementState(state, msgs)

    expect(state.replacements.has('live')).toBe(true)
    expect(state.replacements.has('stale')).toBe(false)
    expect(state.seenAndPreserved.has('liveP')).toBe(true)
    expect(state.seenAndPreserved.has('staleP')).toBe(false)
  })
})
