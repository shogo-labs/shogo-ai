// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `extractOrderedParts` — specifically the reasoning-coalescing
 * behavior added to fix the "thinking widget rapidly expands and closes
 * + scrolls the whole screen" bug.
 *
 * Background: extended-thinking models emit multiple
 * `reasoning-start`/`reasoning-end` chunks per assistant turn. The AI SDK
 * pushes a fresh `ReasoningUIPart` for each one (see
 * `node_modules/.bun/node_modules/ai/src/ui/process-ui-message-stream.ts`,
 * case `reasoning-start`). Pre-fix, every part rendered as its own
 * `<ThinkingWidget>` and each ran an independent ~3s auto-close timer,
 * producing a visible cascade of open/close height-spring animations
 * that the parent ScrollView followed.
 */
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "@ai-sdk/react"
import { extractOrderedParts } from "../messageParts"

function asMessage(parts: unknown[]): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts,
  } as unknown as UIMessage
}

describe("extractOrderedParts — reasoning coalescing", () => {
  test("a single streaming reasoning part still produces one widget", () => {
    const result = extractOrderedParts(
      asMessage([{ type: "reasoning", text: "thinking…", state: "streaming" }]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "reasoning",
      text: "thinking…",
      isStreaming: true,
    })
  })

  test("adjacent reasoning parts merge into one widget with concatenated text", () => {
    // Models like Claude 4.6 with extended thinking, or GPT-5 with
    // reasoning, regularly emit several reasoning blocks back-to-back.
    const result = extractOrderedParts(
      asMessage([
        { type: "reasoning", text: "step one", state: "done" },
        { type: "reasoning", text: "step two", state: "done" },
        { type: "reasoning", text: "step three", state: "streaming" },
      ]),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "reasoning",
      text: "step one\n\nstep two\n\nstep three",
      // Any streaming sub-part keeps the merged widget in streaming state.
      isStreaming: true,
      id: "reasoning-0",
    })
  })

  test("reasoning runs separated by a tool call stay as separate widgets", () => {
    // The interleaved-thinking pattern: the model thinks, calls a tool,
    // thinks again, calls another tool, thinks once more. Each thinking
    // block belongs visually next to its tool call, so we MUST NOT
    // collapse them across the tool boundary.
    const result = extractOrderedParts(
      asMessage([
        { type: "reasoning", text: "let me look", state: "done" },
        {
          type: "dynamic-tool",
          toolCallId: "t1",
          toolName: "read_file",
          state: "output-available",
          input: {},
          output: {},
        },
        { type: "reasoning", text: "now let me write", state: "done" },
        {
          type: "dynamic-tool",
          toolCallId: "t2",
          toolName: "write_file",
          state: "output-available",
          input: {},
          output: {},
        },
        { type: "reasoning", text: "summarising", state: "streaming" },
      ]),
    )

    expect(result.map((p) => p.type)).toEqual([
      "reasoning",
      "tool",
      "reasoning",
      "tool",
      "reasoning",
    ])
    expect(result[0]).toMatchObject({ text: "let me look" })
    expect(result[2]).toMatchObject({ text: "now let me write" })
    expect(result[4]).toMatchObject({ text: "summarising", isStreaming: true })
  })

  test("durationMs values are summed across coalesced reasoning bursts", () => {
    // After persistence, project-chat.ts populates `durationMs` per
    // reasoning part. The merged widget should report the total time the
    // model spent thinking across the whole run, not just one burst.
    const result = extractOrderedParts(
      asMessage([
        { type: "reasoning", text: "first", durationMs: 1200 },
        { type: "reasoning", text: "second", durationMs: 800 },
        { type: "reasoning", text: "third", durationMs: 500 },
      ]),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "reasoning",
      // 1200 + 800 + 500 = 2500ms → ceil(2.5) = 3s
      durationSeconds: 3,
    })
  })

  test("empty reasoning parts do not produce phantom widgets", () => {
    const result = extractOrderedParts(
      asMessage([
        { type: "reasoning", text: "", state: "done" },
        { type: "reasoning", text: "", state: "done" },
      ]),
    )
    expect(result).toHaveLength(0)
  })

  test("a streaming-empty reasoning part still appears so the placeholder UI shows", () => {
    // While the model is mid-thinking but no delta has arrived yet, we
    // still need a widget on screen showing "Thinking…".
    const result = extractOrderedParts(
      asMessage([{ type: "reasoning", text: "", state: "streaming" }]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "reasoning",
      text: "",
      isStreaming: true,
    })
  })

  test("coalesced widget keeps the first run-element index as its key", () => {
    // The id is `reasoning-${firstIndexInRun}`. As more bursts get
    // appended into the same run during streaming, the id MUST stay
    // stable so React doesn't unmount/remount the widget.
    const initial = extractOrderedParts(
      asMessage([
        { type: "text", text: "preamble" },
        { type: "reasoning", text: "burst 1", state: "streaming" },
      ]),
    )
    const later = extractOrderedParts(
      asMessage([
        { type: "text", text: "preamble" },
        { type: "reasoning", text: "burst 1", state: "done" },
        { type: "reasoning", text: "burst 2", state: "streaming" },
      ]),
    )

    expect(initial.find((p) => p.type === "reasoning")?.id).toBe("reasoning-1")
    expect(later.find((p) => p.type === "reasoning")?.id).toBe("reasoning-1")
  })
})

/**
 * SHO-306. A streamed delta appends to the turn's last message, so the message
 * and its `parts` array are new on every chunk while the parts already in it
 * keep their identity. Rebuilding a `MessagePart` for each of them gave every
 * earlier row a new object, which defeated the row's memo and made a joined
 * turn cost more on every commit the longer it was.
 */
describe("extractOrderedParts — reusing parts across deltas", () => {
  function toolPart(i: number) {
    return {
      type: "dynamic-tool",
      toolCallId: `call_${i}`,
      toolName: "read_file",
      state: "output-available",
      input: { path: `src/file-${i}.ts` },
      output: { ok: true },
    }
  }

  test("a part that is still the same object yields the same MessagePart", () => {
    const reuse = new WeakMap()
    const raw = [toolPart(0), toolPart(1)]
    const first = extractOrderedParts(asMessage(raw), reuse)
    // The next delta: the same two raw parts, one more appended.
    const second = extractOrderedParts(
      asMessage([...raw, toolPart(2)]),
      reuse,
    )

    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]).not.toBe(first[0])
  })

  test("a part that changed is rebuilt, not reused", () => {
    const reuse = new WeakMap()
    const streaming = {
      type: "dynamic-tool",
      toolCallId: "call_0",
      toolName: "read_file",
      state: "input-available",
      input: { path: "src/a.ts" },
    }
    const first = extractOrderedParts(asMessage([streaming]), reuse)
    const finished = { ...streaming, state: "output-available", output: { ok: true } }
    const second = extractOrderedParts(asMessage([finished]), reuse)

    expect(second[0]).not.toBe(first[0])
    expect(second[0]).toMatchObject({ type: "tool" })
    if (second[0].type === "tool") expect(second[0].tool.state).toBe("success")
  })

  test("a part that moved keeps an id that belongs to its new position", () => {
    const reuse = new WeakMap()
    const first = { type: "text", text: "hello" }
    const second = { type: "text", text: "world" }
    const before = extractOrderedParts(asMessage([first, second]), reuse)
    expect(before.map((p) => p.id)).toEqual(["text-0", "text-1"])

    // Something before `second` disappeared, so it is at index 0 now — it must
    // not keep `text-1`, which would collide with a part that lands there.
    const after = extractOrderedParts(asMessage([second]), reuse)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe("text-0")
    expect(after[0]).not.toBe(before[1])
  })

  test("without a cache every call builds fresh parts", () => {
    const a = extractOrderedParts(asMessage([toolPart(0)]))
    const b = extractOrderedParts(asMessage([toolPart(0)]))
    expect(b[0]).not.toBe(a[0])
  })
})
