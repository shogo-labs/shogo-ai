// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-354 AC 3 — only a bounded number of turns is mounted, however long the
 * chat is, and however it got long.
 *
 * Round 2 (QA): the window must follow the tail when the transcript *grows*
 * after mount, and the reading-position correction must not depend on
 * `onLayout` firing for a turn that only moved (on react-native-web it is
 * ResizeObserver-driven and never does). Both are guarded here.
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

/** A scroll report that puts the top of the mounted window at the viewport bottom. */
function scrollToWindowTop(
  scroll: ReturnType<typeof createTranscriptScrollSignal>,
  start: number,
) {
  act(() => {
    scroll.report({
      y: start * TURN_WINDOW_ESTIMATE - 600,
      viewportHeight: 800,
      contentHeight: 900_000,
    })
  })
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

  test("a transcript that grows after mount stays bounded (0 → 300 turns)", () => {
    const view = render(createElement(TurnList as any, { messages: [] }))
    expect(mountedRows(view.container)).toHaveLength(0)

    view.rerender(createElement(TurnList as any, { messages: longChat(300) }))

    const rows = mountedRows(view.container)
    expect(rows).toHaveLength(TURN_WINDOW_SIZE)
    expect(rows[0]).toBe("turn-row-turn-u270")
  })

  test("a transcript that grows after mount stays bounded (5 → 200 turns)", () => {
    const view = render(
      createElement(TurnList as any, { messages: longChat(5) }),
    )
    expect(mountedRows(view.container)).toHaveLength(5)

    view.rerender(createElement(TurnList as any, { messages: longChat(200) }))

    const rows = mountedRows(view.container)
    expect(rows).toHaveLength(TURN_WINDOW_SIZE)
    expect(rows[0]).toBe("turn-row-turn-u170")
  })

  test("streaming into a long chat does not remount the window", () => {
    let messages = longChat(300)
    const view = render(createElement(TurnList as any, { messages }))
    const before = mountedRows(view.container)

    // 40 more turns arrive the way an attached live turn delivers them.
    for (let chunk = 0; chunk < 40; chunk++) {
      messages = [
        ...messages,
        {
          id: `u-live-${chunk}`,
          role: "user",
          parts: [{ type: "text", text: `live ${chunk}` }],
        },
        {
          id: `a-live-${chunk}`,
          role: "assistant",
          parts: [{ type: "text", text: `reply ${chunk}` }],
        },
      ]
      view.rerender(createElement(TurnList as any, { messages, isStreaming: true }))
    }

    const after = mountedRows(view.container)
    expect(after).toHaveLength(TURN_WINDOW_SIZE)
    expect(after[0]).not.toBe(before[0])
    expect(after[after.length - 1]).toBe("turn-row-turn-u-live-39")
  })

  test("scrolling back mounts the next page of history", () => {
    const scroll = createTranscriptScrollSignal()
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(300),
        scrollSignal: scroll,
      }),
    )

    expect(mountedRows(view.container)).toHaveLength(TURN_WINDOW_SIZE)
    expect(renderedTurns).toHaveLength(TURN_WINDOW_SIZE)

    scrollToWindowTop(scroll, 270)

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

  test("mounting older turns reports exactly the height the spacer was charging for", () => {
    const scroll = createTranscriptScrollSignal()
    const shifts: number[] = []
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(300),
        scrollSignal: scroll,
        onContentShift: (dy: number) => shifts.push(dy),
      }),
    )

    scrollToWindowTop(scroll, 270)
    // The 20 newly mounted turns are still estimated — nothing has been
    // measured, so nothing is reported yet.
    expect(shifts).toEqual([])

    // Each one reports its real height; the reader is corrected by exactly the
    // difference between that and what the spacer was reserving.
    for (let index = 250; index < 270; index++) {
      if (index === 260) continue
      fireLayout(`turn-u${index}`, 0, TURN_WINDOW_ESTIMATE)
    }
    expect(shifts).toEqual([])

    // This one is taller than the spacer reserved for it.
    fireLayout("turn-u260", 0, TURN_WINDOW_ESTIMATE + 40)
    expect(shifts).toEqual([40])

    // A turn nobody expanded for (already measured, no pending estimate) must
    // not report anything when it re-lays out at the same height.
    fireLayout("turn-u261", 0, TURN_WINDOW_ESTIMATE + 400)
    expect(shifts).toEqual([40])

    view.unmount()
  })

  test("returning to the bottom shrinks the window back to the tail", () => {
    const scroll = createTranscriptScrollSignal()
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(300),
        scrollSignal: scroll,
      }),
    )

    scrollToWindowTop(scroll, 270)
    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    // Now at the bottom of the content — the same report the autoscroll that
    // follows a streaming reply produces.
    act(() => {
      scroll.report({ y: 119_000, viewportHeight: 800, contentHeight: 120_000 })
    })
    const rows = mountedRows(view.container)
    expect(rows).toHaveLength(TURN_WINDOW_SIZE)
    expect(rows[0]).toBe("turn-row-turn-u270")

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
