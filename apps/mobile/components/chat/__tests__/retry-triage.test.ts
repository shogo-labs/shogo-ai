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
 *   The fix triages into reconnect / reload / continue / resend and NEVER truncates
 *   completed work. These tests pin the decision and the no-truncation
 *   guarantee.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/retry-triage.test.ts
 */
import { describe, expect, test } from "bun:test"
import { decideRetryAction, lastAssistantHasResumableWork } from "../retry-triage"

describe("decideRetryAction", () => {
  test("active turn -> reconnect (agent still running, transport drop)", () => {
    for (const clientLostStream of [true, false]) {
      expect(decideRetryAction({ turnStatus: "active", hasResumableTurn: false, clientLostStream })).toBe("reconnect")
      // 'active' wins even if there is resumable work — reconnecting to the live
      // stream is strictly better than restarting a continuation.
      expect(decideRetryAction({ turnStatus: "active", hasResumableTurn: true, clientLostStream })).toBe("reconnect")
    }
  })

  test("completed turn the client lost -> reload, never a new (billed) continue or resend turn", () => {
    // #1083: the server finished and saved the turn while the client's view
    // died; Retry used to send `continue: true` for already-finished work.
    expect(decideRetryAction({ turnStatus: "completed", hasResumableTurn: true, clientLostStream: true })).toBe("reload")
    expect(decideRetryAction({ turnStatus: "completed", hasResumableTurn: false, clientLostStream: true })).toBe("reload")
  })

  test("completed turn the client saw end with an empty response -> resend, not a no-op reload", () => {
    // Reloading would show the same empty turn and Retry would do nothing.
    expect(decideRetryAction({ turnStatus: "completed", hasResumableTurn: false, clientLostStream: false })).toBe("resend")
  })

  test("completed turn the client saw end with partial work -> continue", () => {
    expect(decideRetryAction({ turnStatus: "completed", hasResumableTurn: true, clientLostStream: false })).toBe("continue")
  })

  test("failed/aborted/unknown with resumable work -> continue (preserve work)", () => {
    for (const turnStatus of ["failed", "aborted", "unknown"] as const) {
      for (const clientLostStream of [true, false]) {
        expect(decideRetryAction({ turnStatus, hasResumableTurn: true, clientLostStream })).toBe("continue")
      }
    }
  })

  test("nothing resumable -> resend (last resort)", () => {
    for (const turnStatus of ["failed", "aborted", "unknown"] as const) {
      for (const clientLostStream of [true, false]) {
        expect(decideRetryAction({ turnStatus, hasResumableTurn: false, clientLostStream })).toBe("resend")
      }
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
      clientLostStream: true,
    })
    // Must NOT be 'resend' — resend was the destructive path that truncated.
    expect(action).toBe("continue")
  })

  test("an active turn with completed tool calls chooses reconnect (not resend)", () => {
    const action = decideRetryAction({
      turnStatus: "active",
      hasResumableTurn: lastAssistantHasResumableWork(messages),
      clientLostStream: true,
    })
    expect(action).toBe("reconnect")
  })

  test("the decision input does not mutate or drop the message list", () => {
    const snapshot = JSON.parse(JSON.stringify(messages))
    decideRetryAction({
      turnStatus: "failed",
      hasResumableTurn: lastAssistantHasResumableWork(messages),
      clientLostStream: true,
    })
    // Pure functions: the completed assistant + tool-call messages are intact.
    expect(messages).toEqual(snapshot)
    expect(messages).toHaveLength(2)
    expect((messages[1].parts as any[]).filter((p) => p.type === "dynamic-tool")).toHaveLength(2)
  })
})
