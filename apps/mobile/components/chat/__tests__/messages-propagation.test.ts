// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the `onMessagesChange` propagation gate.
 *
 * Firing `onMessagesChange` on every streamed chunk used to re-render the
 * parent ProjectLayout + every sibling ChatPanel per character. This suite
 * locks in the rule: during streaming, we propagate only on meaningful
 * transitions (count change, tool-state change, stream end) — never on every
 * token.
 */
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import { decideMessagesPropagation } from "../messages-propagation"

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage
}
function assistantMsg(id: string, text: string, extra: any[] = []): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }, ...extra],
  } as unknown as UIMessage
}
function withText(prev: UIMessage, text: string): UIMessage {
  return {
    ...(prev as any),
    parts: [{ type: "text", text }],
  } as unknown as UIMessage
}

/**
 * Simulates the effect's state transitions — matches what the component does
 * inside the useEffect.
 */
function runGate(
  sequence: Array<{ messages: UIMessage[]; isStreaming: boolean }>,
): { propagations: number[]; finalSnapshot: UIMessage[] | null } {
  let prev: UIMessage[] | null = null
  let prevToolSig = ""
  let prevIsStreaming = false
  const propagationsAt: number[] = []

  for (let i = 0; i < sequence.length; i++) {
    const { messages, isStreaming } = sequence[i]
    const decision = decideMessagesPropagation({
      prev,
      next: messages,
      isStreaming,
      prevIsStreaming,
      prevToolSig,
    })
    prevIsStreaming = isStreaming
    if (decision.shouldPropagate) {
      propagationsAt.push(i)
      prev = messages
      prevToolSig = decision.toolSig
    }
  }
  return { propagations: propagationsAt, finalSnapshot: prev }
}

describe("decideMessagesPropagation — streaming text tokens", () => {
  test("500 character tokens into the last message fire ZERO propagations", () => {
    const u = userMsg("u1", "hi")
    let a = assistantMsg("a1", "")
    const sequence: Array<{ messages: UIMessage[]; isStreaming: boolean }> = []

    // Initial render (no messages yet): don't count as propagation target.
    sequence.push({ messages: [u, a], isStreaming: true }) // turn appears
    for (let i = 1; i <= 500; i++) {
      a = withText(a, "x".repeat(i))
      sequence.push({ messages: [u, a], isStreaming: true })
    }

    const { propagations } = runGate(sequence)
    // Only the first step (count went from 0 → 2) should propagate.
    // All 500 subsequent streaming ticks must be silent.
    expect(propagations).toEqual([0])
  })

  test("stream end propagates one final snapshot", () => {
    const u = userMsg("u1", "hi")
    const a1 = assistantMsg("a1", "")
    const a2 = assistantMsg("a1", "hello there")

    const { propagations } = runGate([
      { messages: [u, a1], isStreaming: true }, // i=0 count 0→2
      { messages: [u, withText(a1, "h")], isStreaming: true }, // i=1 token
      { messages: [u, withText(a1, "he")], isStreaming: true }, // i=2 token
      { messages: [u, a2], isStreaming: false }, // i=3 stream ended
    ])

    expect(propagations).toEqual([0, 3])
  })

  test("tool-state transition on last message propagates", () => {
    const u = userMsg("u1", "install something")
    const a0 = assistantMsg("a1", "ok", [
      {
        type: "tool-invocation",
        toolInvocation: {
          toolCallId: "tc1",
          toolName: "tool_install",
          state: "call",
        },
      },
    ])
    const a1 = assistantMsg("a1", "ok", [
      {
        type: "tool-invocation",
        toolInvocation: {
          toolCallId: "tc1",
          toolName: "tool_install",
          state: "result",
          result: { authStatus: "needs_auth", integration: "github" },
        },
      },
    ])

    const { propagations } = runGate([
      { messages: [u, a0], isStreaming: true }, // count change
      { messages: [u, a0], isStreaming: true }, // identical, no change
      { messages: [u, a1], isStreaming: true }, // tool state call→result
    ])

    expect(propagations).toEqual([0, 2])
  })

  test("count change during idle propagates (e.g. history load, deletion)", () => {
    const u1 = userMsg("u1", "a")
    const a1 = assistantMsg("a1", "b")
    const u2 = userMsg("u2", "c")

    const { propagations } = runGate([
      { messages: [u1, a1], isStreaming: false }, // initial
      { messages: [u1, a1], isStreaming: false }, // no-op
      { messages: [u1, a1, u2], isStreaming: false }, // count change while idle
    ])

    expect(propagations).toEqual([0, 2])
  })

  test("user send during active stream is suppressed until stream ends", () => {
    // When the user hits send, the AI SDK appends the user bubble AND a nascent
    // assistant bubble back-to-back with isStreaming=true. The parent does NOT
    // need these intermediate counts — only the final post-stream snapshot.
    const u1 = userMsg("u1", "hi")
    const a1 = assistantMsg("a1", "hello")
    const u2 = userMsg("u2", "follow up")
    const a2Empty = assistantMsg("a2", "")
    const a2Full = assistantMsg("a2", "sure")

    const { propagations } = runGate([
      { messages: [u1, a1], isStreaming: false }, // i=0 initial
      { messages: [u1, a1, u2], isStreaming: true }, // i=1 user bubble appears, stream starts
      { messages: [u1, a1, u2, a2Empty], isStreaming: true }, // i=2 assistant bubble appears
      { messages: [u1, a1, u2, withText(a2Empty, "s")], isStreaming: true }, // i=3 token
      { messages: [u1, a1, u2, withText(a2Empty, "su")], isStreaming: true }, // i=4 token
      { messages: [u1, a1, u2, a2Full], isStreaming: false }, // i=5 stream end
    ])

    // Neither of the two count bumps during streaming propagates — only the
    // first render and the final stream-end snapshot.
    expect(propagations).toEqual([0, 5])
  })

  test("stream without tools or count change still propagates on end", () => {
    const u = userMsg("u1", "summarize")
    let a = assistantMsg("a1", "")

    const sequence: Array<{ messages: UIMessage[]; isStreaming: boolean }> = [
      { messages: [u, a], isStreaming: true }, // count 0→2
    ]
    for (let i = 1; i <= 30; i++) {
      a = withText(a, "a".repeat(i))
      sequence.push({ messages: [u, a], isStreaming: true })
    }
    // final tick: same messages, isStreaming flips to false
    sequence.push({ messages: [u, a], isStreaming: false })

    const { propagations } = runGate(sequence)
    // First (count change) + last (stream end). No intermediate propagations.
    expect(propagations).toEqual([0, sequence.length - 1])
  })

  test("no-op render (same references, same streaming state) does not propagate", () => {
    const u = userMsg("u1", "x")
    const a = assistantMsg("a1", "y")

    const { propagations } = runGate([
      { messages: [u, a], isStreaming: false }, // initial
      { messages: [u, a], isStreaming: false },
      { messages: [u, a], isStreaming: false },
    ])

    expect(propagations).toEqual([0])
  })

  test("two-turn conversation: 200 tokens → 400 tokens, only meaningful events propagate", () => {
    const u1 = userMsg("u1", "a")
    let a1 = assistantMsg("a1", "")
    const sequence: Array<{ messages: UIMessage[]; isStreaming: boolean }> = []

    sequence.push({ messages: [u1, a1], isStreaming: true })
    for (let i = 1; i <= 200; i++) {
      a1 = withText(a1, "x".repeat(i))
      sequence.push({ messages: [u1, a1], isStreaming: true })
    }
    sequence.push({ messages: [u1, a1], isStreaming: false }) // stream end

    const u2 = userMsg("u2", "b")
    sequence.push({ messages: [u1, a1, u2], isStreaming: false }) // user turn
    let a2 = assistantMsg("a2", "")
    sequence.push({ messages: [u1, a1, u2, a2], isStreaming: true }) // count
    for (let i = 1; i <= 400; i++) {
      a2 = withText(a2, "y".repeat(i))
      sequence.push({ messages: [u1, a1, u2, a2], isStreaming: true })
    }
    sequence.push({ messages: [u1, a1, u2, a2], isStreaming: false }) // end

    const { propagations } = runGate(sequence)
    // Expected: initial count(0), stream end 1, user turn, count 2→3→4,
    //   stream end 2. That's 5 propagations across 600+ ticks.
    expect(propagations.length).toBeLessThanOrEqual(6)
    expect(propagations.length).toBeGreaterThanOrEqual(4)
  })
})
