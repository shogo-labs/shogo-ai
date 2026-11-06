// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-354 AC 3 — only a bounded number of turns is mounted, however long the
 * chat is; scrolling back mounts older turns again, and an expansion never
 * moves what the person is reading (the anchor correction).
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { act, render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const layoutHandlers = new Map<string, (event: any) => void>()

const rnMock = () =>
  createReactNativeMock({
    Text: ({ children, ...rest }: any) =>
      createElement("span", { ...rest, style: undefined }, children),
    View: ({ children, testID, onLayout, style, ...rest }: any) => {
      if (onLayout) layoutHandlers.set(String(testID), onLayout)
      return createElement(
        "div",
        { ...rest, "data-testid": testID, "data-height": style?.height },
        children,
      )
    },
  })

mock.module("react-native", () => rnMock())
mock.module(require.resolve("react-native"), () => rnMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
}))

const renderedTurns: string[] = []
mock.module(resolve(import.meta.dir, "../TurnGroup.tsx"), () => ({
  TurnGroup: ({ turn }: any) => {
    renderedTurns.push(turn.id)
    return createElement("div", { "data-testid": `group-${turn.id}` })
  },
}))

const { TurnList } = await import("../TurnList")
const { createTranscriptScrollSignal } = await import("../transcript-scroll")
const { TURN_WINDOW_SIZE, TURN_WINDOW_STEP, TURN_WINDOW_ESTIMATE } = await import(
  "../useTurnWindow"
)
const { EditContextHost } = await import("./editContextFixture")

function longChat(turnCount: number) {
  const messages: any[] = []
  for (let index = 0; index < turnCount; index++) {
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

function mountedRows(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll('[data-testid^="turn-row-"]'),
  ).map((node) => node.getAttribute("data-testid")!)
}

function fireLayout(turnId: string, y: number, height: number) {
  const handler = layoutHandlers.get(`turn-row-${turnId}`)
  handler?.({ nativeEvent: { layout: { x: 0, y, width: 320, height } } })
}

afterEach(() => {
  layoutHandlers.clear()
  renderedTurns.length = 0
})

describe("TurnList — mounted window (AC 3)", () => {
  test("a 300-turn chat mounts only the tail window", () => {
    const view = render(
      createElement(TurnList as any, { messages: longChat(300) }),
    )

    const rows = mountedRows(view.container)
    expect(rows).toHaveLength(TURN_WINDOW_SIZE)
    expect(rows[0]).toBe("turn-row-turn-u270")
    expect(rows[rows.length - 1]).toBe("turn-row-turn-u299")

    const spacer = view.container.querySelector(
      '[data-testid="turn-window-spacer"]',
    )
    expect(spacer?.getAttribute("data-height")).toBe(
      String(270 * TURN_WINDOW_ESTIMATE),
    )
  })

  test("scrolling to the top mounts the next page of history", () => {
    const scroll = createTranscriptScrollSignal()
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(300),
        scrollSignal: scroll,
      }),
    )

    expect(mountedRows(view.container)).toHaveLength(TURN_WINDOW_SIZE)
    expect(renderedTurns).toHaveLength(TURN_WINDOW_SIZE)

    act(() => {
      // Viewport bottom has reached the top of the mounted window: the
      // 270 collapsed turns occupy 270 * TURN_WINDOW_ESTIMATE px above it.
      scroll.report({
        y: 270 * TURN_WINDOW_ESTIMATE - 600,
        viewportHeight: 800,
        contentHeight: 120_000,
      })
    })

    const rows = mountedRows(view.container)
    expect(rows).toHaveLength(TURN_WINDOW_SIZE + TURN_WINDOW_STEP)
    expect(rows[0]).toBe(`turn-row-turn-u${270 - TURN_WINDOW_STEP}`)
    // Nothing older than the tail window re-renders: only the newly mounted
    // page is added to the tree. (Counted by identity — the stub TurnGroup is
    // not memoized, so a re-render of the list touches every mounted row.)
    expect(new Set(renderedTurns).size).toBe(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    view.unmount()
  })

  test("mounting older turns keeps the reading position", () => {
    const scroll = createTranscriptScrollSignal()
    const shifts: number[] = []
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(300),
        scrollSignal: scroll,
        onContentShift: (dy: number) => shifts.push(dy),
      }),
    )

    // The topmost mounted turn is the anchor; its offset is measured first.
    fireLayout("turn-u270", 76_000, 120)
    expect(shifts).toHaveLength(0)

    act(() => {
      // Viewport bottom has reached the top of the mounted window: the
      // 270 collapsed turns occupy 270 * TURN_WINDOW_ESTIMATE px above it.
      scroll.report({
        y: 270 * TURN_WINDOW_ESTIMATE - 600,
        viewportHeight: 800,
        contentHeight: 120_000,
      })
    })

    // Older turns are now mounted above the anchor with real heights, so it
    // moved down by exactly that much — the caller scrolls back by the same
    // amount and the person keeps looking at the same turn.
    fireLayout("turn-u270", 76_000 + 2_400, 120)
    expect(shifts).toEqual([2_400])

    // The anchor's own resize does not move it, so it is not reported.
    fireLayout("turn-u270", 76_000 + 2_400, 260)
    expect(shifts).toEqual([2_400])

    view.unmount()
  })

  test("opening the in-place editor mounts the turn that owns the divider", () => {
    const view = render(
      createElement(
        EditContextHost,
        { editingMessageId: "u10", countMessagesAfter: () => 578 } as any,
        createElement(TurnList as any, { messages: longChat(300) }),
      ),
    )

    const rows = mountedRows(view.container)
    expect(rows[0]).toBe("turn-row-turn-u10")
    expect(view.getByText("578 messages below will be replaced")).toBeTruthy()
  })
})
