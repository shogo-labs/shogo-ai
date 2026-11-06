// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-354 AC 2 — while a reply streams, no turn other than the streaming one
 * re-renders.
 *
 * The turns come into `TurnList` through the same pipeline ChatPanel uses
 * (`foldSnapshotContinuation` → `appendQueuedUserMessages` → `resolveRejoinView`),
 * and each chunk replaces only the last assistant message object, exactly as
 * the AI SDK does. The stub stands in for `TurnGroup` with the same memo
 * comparator, so a historical turn re-rendering here means the real one would
 * too.
 */

import { describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { render } from "@testing-library/react"
import { createElement, memo } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const rnMock = () =>
  createReactNativeMock({
    Text: ({ children, ...rest }: any) =>
      createElement("span", { ...rest, style: undefined }, children),
    View: ({ children, testID, onLayout, ...rest }: any) =>
      createElement(
        "div",
        { ...rest, style: undefined, "data-testid": testID },
        children,
      ),
  })

mock.module("react-native", () => rnMock())
mock.module(require.resolve("react-native"), () => rnMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
}))

const renders = new Map<string, number>()

mock.module(resolve(import.meta.dir, "../TurnGroup.tsx"), () => ({
  // Same comparator as the real TurnGroup: only a changed `turn` (or the
  // props TurnList passes alongside it) re-renders a historical turn.
  TurnGroup: memo(
    function TurnGroup({ turn }: any) {
      renders.set(turn.id, (renders.get(turn.id) ?? 0) + 1)
      return createElement("div", { "data-testid": `group-${turn.id}` })
    },
    (prev: any, next: any) =>
      prev.turn === next.turn &&
      prev.phase === next.phase &&
      prev.showToolTimeline === next.showToolTimeline &&
      prev.summaryCard === next.summaryCard &&
      prev.dimmed === next.dimmed &&
      prev.dimTail === next.dimTail &&
      prev.className === next.className,
  ),
}))

const { TurnList } = await import("../TurnList")
const { appendQueuedUserMessages } = await import("../../queued-user-message")
const { foldSnapshotContinuation } = await import("../../resume-replay-transport")
const { resolveRejoinView } = await import("../../rejoin-view")

const TURNS = 20
const CHUNKS = 50

function history(turns: number) {
  const messages: any[] = []
  for (let index = 0; index < turns; index++) {
    messages.push({
      id: `u${index}`,
      role: "user",
      parts: [{ type: "text", text: `question ${index}` }],
    })
    messages.push({
      id: `a${index}`,
      role: "assistant",
      parts: [{ type: "text", text: `answer ${index}` }],
    })
  }
  return messages
}

/** The display pipeline ChatPanel runs before it hands messages to TurnList. */
function display(messages: any[]) {
  return resolveRejoinView({
    messages: appendQueuedUserMessages(foldSnapshotContinuation(messages, null), []),
    rejoining: false,
  }).messages as any[]
}

describe("TurnList — streaming does not re-render history (AC 2)", () => {
  test("only the streaming turn renders per chunk", () => {
    const base = history(TURNS)
    const view = render(
      createElement(TurnList as any, {
        messages: display(base),
        isStreaming: true,
      }),
    )

    // A turn is keyed by its first message, which is always the prompt here.
    // `slice(0, -2)` drops the whole streaming turn (prompt + reply).
    const historical = base.slice(0, -2).filter((m) => m.role === "user")
    for (const message of historical) {
      expect(renders.get(`turn-${message.id}`)).toBe(1)
    }

    // The live turn is keyed by its prompt, like every other turn.
    const streamingId = `turn-${base[base.length - 2].id}`
    let streamed = base

    for (let chunk = 1; chunk <= CHUNKS; chunk++) {
      // Every chunk is a brand-new message object with a longer text part —
      // what the AI SDK does on each token — while history keeps its identity.
      streamed = [
        ...streamed.slice(0, -1),
        {
          ...streamed[streamed.length - 1],
          parts: [{ type: "text", text: `answer ${TURNS - 1} `.repeat(chunk) }],
        },
      ]
      view.rerender(
        createElement(TurnList as any, {
          messages: display(streamed),
          isStreaming: true,
        }),
      )
    }

    // History: mounted once, never rendered again.
    for (const message of historical) {
      expect(renders.get(`turn-${message.id}`)).toBe(1)
    }
    // The streaming turn followed every chunk.
    expect(renders.get(streamingId)).toBe(CHUNKS + 1)
  })
})
