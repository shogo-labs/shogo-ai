// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for groupMessagesIntoTurns — the pure core of `useTurnGrouping`.
 *
 * These tests reproduce the hot streaming path the UI hits on every token and
 * assert the invariant that actually matters for React.memo downstream:
 *
 *   → historical turn objects MUST keep the same reference across renders when
 *     their underlying (userMessage, assistantMessage) references haven't
 *     changed — regardless of how many times the currently-streaming message
 *     mutates.
 *
 * If this invariant breaks, every `TurnGroup` memo bails out on every token
 * and the chat re-renders N turns * M characters times per turn.
 */
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import { groupMessagesIntoTurns } from "../useTurnGrouping"
import type { ConversationTurn } from "../types"
import type { ToolCallData } from "../tools/types"

type Msg = UIMessage

function userMsg(id: string, text: string): Msg {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as unknown as Msg
}

function assistantMsg(id: string, text: string, extraParts: any[] = []): Msg {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }, ...extraParts],
  } as unknown as Msg
}

function cloneAssistantWithText(prev: Msg, text: string): Msg {
  // Simulate AI SDK behavior: on every streaming token a NEW message object
  // replaces the previous last message with an extended text part.
  return {
    ...(prev as any),
    parts: [{ type: "text", text }],
  } as unknown as Msg
}

describe("groupMessagesIntoTurns — referential stability during streaming", () => {
  test("historical turn references are preserved when only the last message changes", () => {
    const u1 = userMsg("u1", "hello")
    const a1 = assistantMsg("a1", "hi there")
    const u2 = userMsg("u2", "how are you?")
    const a2 = assistantMsg("a2", "")

    // Initial render: no prevTurns yet.
    const r0 = groupMessagesIntoTurns([u1, a1, u2, a2], true, undefined, undefined)
    expect(r0).toHaveLength(2)
    expect(r0[0].userMessage).toBe(u1)
    expect(r0[0].assistantMessage).toBe(a1)
    expect(r0[0].isStreaming).toBe(false)
    expect(r0[1].isStreaming).toBe(true)

    // Stream 10 tokens into a2 — only the final message gets a new reference.
    let currentAssistant = a2
    let prev: ConversationTurn[] = r0
    const chars = "Hello world"
    for (let i = 1; i <= chars.length; i++) {
      currentAssistant = cloneAssistantWithText(currentAssistant, chars.slice(0, i))
      const nextMessages = [u1, a1, u2, currentAssistant]
      const next = groupMessagesIntoTurns(nextMessages, true, undefined, prev)

      expect(next).toHaveLength(2)
      // Historical turn MUST be reference-equal to the previous render.
      expect(next[0]).toBe(prev[0])
      // The streaming turn must be a fresh object because the assistant
      // message reference changed.
      expect(next[1]).not.toBe(prev[1])
      expect(next[1].assistantMessage).toBe(currentAssistant)
      expect(next[1].isStreaming).toBe(true)

      prev = next
    }
  })

  test("no-op render (no messages changed) returns the exact same turn objects", () => {
    const u1 = userMsg("u1", "a")
    const a1 = assistantMsg("a1", "b")
    const u2 = userMsg("u2", "c")
    const a2 = assistantMsg("a2", "d")

    const first = groupMessagesIntoTurns([u1, a1, u2, a2], false, undefined, undefined)
    const second = groupMessagesIntoTurns([u1, a1, u2, a2], false, undefined, first)

    expect(second).toHaveLength(first.length)
    for (let i = 0; i < first.length; i++) {
      expect(second[i]).toBe(first[i])
    }
  })

  test("appending a new user message keeps prior historical turn refs stable", () => {
    const u1 = userMsg("u1", "a")
    const a1 = assistantMsg("a1", "b")
    const u2 = userMsg("u2", "c")
    const a2 = assistantMsg("a2", "d")

    const first = groupMessagesIntoTurns([u1, a1, u2, a2], false, undefined, undefined)

    const u3 = userMsg("u3", "e")
    const second = groupMessagesIntoTurns([u1, a1, u2, a2, u3], false, undefined, first)

    expect(second).toHaveLength(3)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2].userMessage).toBe(u3)
    expect(second[2].assistantMessage).toBeNull()
  })

  test("streaming flag flip on same assistant message produces a new turn object", () => {
    const u1 = userMsg("u1", "hello")
    const a1 = assistantMsg("a1", "streaming response")

    const streaming = groupMessagesIntoTurns([u1, a1], true, undefined, undefined)
    expect(streaming[0].isStreaming).toBe(true)

    // Stream ended: same message reference but isStreaming is now false.
    const done = groupMessagesIntoTurns([u1, a1], false, undefined, streaming)
    expect(done[0]).not.toBe(streaming[0])
    expect(done[0].userMessage).toBe(u1)
    expect(done[0].assistantMessage).toBe(a1)
    expect(done[0].isStreaming).toBe(false)
  })

  test("external tool calls only rebuild the last turn", () => {
    const u1 = userMsg("u1", "run task")
    const a1 = assistantMsg("a1", "done")
    const u2 = userMsg("u2", "another")
    const a2 = assistantMsg("a2", "working")

    const base = groupMessagesIntoTurns([u1, a1, u2, a2], true, undefined, undefined)

    const ext: ToolCallData[] = [
      {
        id: "ext-1",
        toolName: "subagent",
        category: "skill",
        state: "streaming",
        timestamp: 0,
      },
    ]
    const withExt = groupMessagesIntoTurns([u1, a1, u2, a2], true, ext, base)

    expect(withExt).toHaveLength(2)
    // Historical turn stays the same reference.
    expect(withExt[0]).toBe(base[0])
    // Last turn is rebuilt with merged tool calls.
    expect(withExt[1]).not.toBe(base[1])
    expect(withExt[1].toolCalls.some((t) => t.id === "ext-1")).toBe(true)

    // Calling again with the SAME external tool calls (already merged) is a no-op
    // on the reference → we still rebuild the last turn each call with externals,
    // but this only happens when externalToolCalls is non-empty. That's accepted.
    const again = groupMessagesIntoTurns([u1, a1, u2, a2], true, ext, withExt)
    expect(again[0]).toBe(withExt[0])
  })
})

describe("groupMessagesIntoTurns — performance (character streaming simulation)", () => {
  test("streaming 500 characters into 1 of 10 turns allocates a bounded number of turn objects", () => {
    // Build 9 historical turns and 1 currently-streaming turn.
    const messages: Msg[] = []
    const historicalTurns: Array<{ u: Msg; a: Msg }> = []
    for (let i = 0; i < 9; i++) {
      const u = userMsg(`u${i}`, `q${i}`)
      const a = assistantMsg(`a${i}`, `a${i}-response`)
      messages.push(u, a)
      historicalTurns.push({ u, a })
    }
    const streamingUser = userMsg("uS", "final question")
    let streamingAssistant = assistantMsg("aS", "")
    messages.push(streamingUser, streamingAssistant)

    let prev = groupMessagesIntoTurns(messages, true, undefined, undefined)

    // Capture initial historical refs.
    const initialHistoricalRefs = prev.slice(0, 9).map((t) => t)

    const N = 500
    let historicalRefChanges = 0
    let streamingRefChanges = 0
    const t0 = performance.now()

    for (let i = 1; i <= N; i++) {
      streamingAssistant = cloneAssistantWithText(streamingAssistant, "x".repeat(i))
      const next = [...messages.slice(0, -1), streamingAssistant]
      const result = groupMessagesIntoTurns(next, true, undefined, prev)

      for (let j = 0; j < 9; j++) {
        if (result[j] !== initialHistoricalRefs[j]) historicalRefChanges++
      }
      if (result[9] !== prev[9]) streamingRefChanges++
      prev = result
    }
    const elapsedMs = performance.now() - t0

    // Historical turns MUST never change reference across 500 tokens.
    expect(historicalRefChanges).toBe(0)
    // Streaming turn MUST change reference on every token (its message ref
    // changed every iteration).
    expect(streamingRefChanges).toBe(N)
    // Sanity: the whole thing should run well under 100ms on any dev box.
    expect(elapsedMs).toBeLessThan(250)
  })

  test("character-by-character streaming into a 1-turn chat only rebuilds the streaming turn", () => {
    const u = userMsg("u", "say something long")
    let a = assistantMsg("a", "")
    let prev = groupMessagesIntoTurns([u, a], true, undefined, undefined)
    const initialTurnRef = prev[0]

    const full = "the quick brown fox jumps over the lazy dog"
    const refs = new Set<ConversationTurn>()
    for (let i = 1; i <= full.length; i++) {
      a = cloneAssistantWithText(a, full.slice(0, i))
      const next = groupMessagesIntoTurns([u, a], true, undefined, prev)
      expect(next).toHaveLength(1)
      // The one turn must be a new object each token because its assistant ref changed.
      expect(next[0]).not.toBe(initialTurnRef)
      refs.add(next[0])
      prev = next
    }
    // Every token produced a distinct turn object (expected, since there's no
    // historical turn to preserve here).
    expect(refs.size).toBe(full.length)
  })
})
