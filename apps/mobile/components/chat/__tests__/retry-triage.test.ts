// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the pure retry-triage decision behind ChatPanel's "Retry" button.
 *
 * Headline regression locked down here (the reported bug — must not come back):
 *
 *   Tapping "Retry" used to run
 *     setMessages(messages.slice(0, lastUserIdx))
 *     sendMessageInternal(content)            // re-send original prompt
 *   which DELETED the interrupted turn's completed tool calls + partial answer
 *   (potentially minutes of work) and restarted from scratch.
 *
 *   The fix triages into reconnect / continue / resend and NEVER truncates
 *   completed work. These tests pin the decision and the no-truncation
 *   guarantee.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/retry-triage.test.ts
 */
import { describe, expect, test } from "bun:test"
import { decideRetryAction, lastAssistantHasResumableWork } from "../retry-triage"

describe("decideRetryAction", () => {
  test("active turn -> reconnect (agent still running, transport drop)", () => {
    expect(decideRetryAction({ turnStatus: "active", hasResumableTurn: false })).toBe("reconnect")
    // 'active' wins even if there is resumable work — reconnecting to the live
    // stream is strictly better than restarting a continuation.
    expect(decideRetryAction({ turnStatus: "active", hasResumableTurn: true })).toBe("reconnect")
  })

  test("terminal/unknown with resumable work -> continue (preserve work)", () => {
    for (const turnStatus of ["completed", "failed", "aborted", "unknown"] as const) {
      expect(decideRetryAction({ turnStatus, hasResumableTurn: true })).toBe("continue")
    }
  })

  test("nothing resumable -> resend (last resort)", () => {
    for (const turnStatus of ["completed", "failed", "aborted", "unknown"] as const) {
      expect(decideRetryAction({ turnStatus, hasResumableTurn: false })).toBe("resend")
    }
  })
})

describe("lastAssistantHasResumableWork", () => {
  test("true when the last assistant message has a completed tool call", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "working" },
          { type: "dynamic-tool", toolName: "read_file", state: "output-available" },
        ],
      },
    ]
    expect(lastAssistantHasResumableWork(messages)).toBe(true)
  })

  test("true when the last assistant message has non-empty text", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "partial answer" }] },
    ]
    expect(lastAssistantHasResumableWork(messages)).toBe(true)
  })

  test("false when the model produced nothing yet (user is last)", () => {
    const messages = [{ role: "user", parts: [{ type: "text", text: "hi" }] }]
    expect(lastAssistantHasResumableWork(messages)).toBe(false)
  })

  test("false when the last assistant message is empty", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "   " }] },
    ]
    expect(lastAssistantHasResumableWork(messages)).toBe(false)
  })
})

describe("REGRESSION: retry must never truncate completed work", () => {
  // The exact shape from the bug report: a user message followed by an
  // assistant turn that completed tool calls before the connection dropped.
  const messages = [
    { role: "user", parts: [{ type: "text", text: "build the feature" }] },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "On it." },
        { type: "dynamic-tool", toolName: "edit_file", state: "output-available" },
        { type: "dynamic-tool", toolName: "exec", state: "output-available" },
      ],
    },
  ]

  test("a terminal turn with completed tool calls chooses continue (not resend)", () => {
    const action = decideRetryAction({
      turnStatus: "failed",
      hasResumableTurn: lastAssistantHasResumableWork(messages),
    })
    // Must NOT be 'resend' — resend was the destructive path that truncated.
    expect(action).toBe("continue")
  })

  test("an active turn with completed tool calls chooses reconnect (not resend)", () => {
    const action = decideRetryAction({
      turnStatus: "active",
      hasResumableTurn: lastAssistantHasResumableWork(messages),
    })
    expect(action).toBe("reconnect")
  })

  test("the decision input does not mutate or drop the message list", () => {
    const snapshot = JSON.parse(JSON.stringify(messages))
    decideRetryAction({
      turnStatus: "failed",
      hasResumableTurn: lastAssistantHasResumableWork(messages),
    })
    // Pure functions: the completed assistant + tool-call messages are intact.
    expect(messages).toEqual(snapshot)
    expect(messages).toHaveLength(2)
    expect((messages[1].parts as any[]).filter((p) => p.type === "dynamic-tool")).toHaveLength(2)
  })
})
