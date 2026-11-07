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
import { createElement, forwardRef } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const layoutHandlers = new Map<string, (event: any) => void>()

const rnMock = () =>
  createReactNativeMock({
    Text: ({ children, ...rest }: any) =>
      createElement("span", { ...rest, style: undefined }, children),
    View: forwardRef(({ children, testID, onLayout, style, ...rest }: any, ref: any) => {
      if (onLayout) layoutHandlers.set(String(testID), onLayout)
      return createElement(
        "div",
        { ...rest, ref, "data-testid": testID, "data-height": style?.height },
        children,
      )
    }),
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
const {
  TURN_WINDOW_SIZE,
  TURN_WINDOW_STEP,
  TURN_WINDOW_ESTIMATE,
  TURN_WINDOW_ROW_GAP,
} = await import("../useTurnWindow")
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
      y: start * (TURN_WINDOW_ESTIMATE + TURN_WINDOW_ROW_GAP) - 600,
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
    // Height *and* gap: the collapsed rows have to reserve the space that
    // separated them from each other, or every expansion adds `gap × page` of
    // uncorrected height above the reader (SHO-359).
    expect(spacer?.getAttribute("data-height")).toBe(
      String(270 * (TURN_WINDOW_ESTIMATE + TURN_WINDOW_ROW_GAP)),
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

  test("a scroll at the bottom never mounts older turns", async () => {
    const scroll = createTranscriptScrollSignal()
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(300),
        scrollSignal: scroll,
      }),
    )

    // The spacer sits *above* the window, so a bottom-of-chat position is
    // farther from the top than the spacer is tall — it must not read as
    // "near the top of history". Five reports, as scrolling/autoscroll gives.
    for (let index = 0; index < 5; index++) {
      act(() => {
        scroll.report({
          y: 119_200 - index * 200,
          viewportHeight: 800,
          contentHeight: 120_000,
        })
      })
    }

    // Past the expansion throttle and its retry timer.
    await new Promise((resolve) => setTimeout(resolve, 400))

    const rows = mountedRows(view.container)
    expect(rows).toHaveLength(TURN_WINDOW_SIZE)
    expect(rows[0]).toBe("turn-row-turn-u270")

    view.unmount()
  })

  test("one top scroll mounts one page and then stops", async () => {
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

    // The viewport has not moved, so the next page is not due: the retry timer
    // must not walk the window back through the whole history on its own.
    await new Promise((resolve) => setTimeout(resolve, 700))

    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    // A further upward scroll mounts exactly one more page.
    scrollToWindowTop(scroll, 250)
    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP * 2,
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP * 2,
    )

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

  // ---- SHO-359: the window must not fight the reader ----------------------

  test("a full expand followed by a shrink keeps the spacer accounting exact", () => {
    const scroll = createTranscriptScrollSignal()
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(120),
        scrollSignal: scroll,
      }),
    )

    const spacerHeight = () =>
      Number(
        view.container
          .querySelector('[data-testid="turn-window-spacer"]')
          ?.getAttribute("data-height") ?? 0,
      )

    // 120 turns → 90 collapsed, each reserving its height and its gap.
    expect(spacerHeight()).toBe(
      90 * (TURN_WINDOW_ESTIMATE + TURN_WINDOW_ROW_GAP),
    )

    scrollToWindowTop(scroll, 90)
    // 20 turns move from the spacer into the tree: the budget drops by exactly
    // what those turns were charging, gaps included.
    expect(spacerHeight()).toBe(
      70 * (TURN_WINDOW_ESTIMATE + TURN_WINDOW_ROW_GAP),
    )

    // Back at the bottom: the window returns to the tail and the spacer
    // reserves the same numbers it started with.
    act(() => {
      scroll.report({ y: 119_300, viewportHeight: 800, contentHeight: 120_000 })
    })
    expect(spacerHeight()).toBe(
      90 * (TURN_WINDOW_ESTIMATE + TURN_WINDOW_ROW_GAP),
    )

    view.unmount()
  })

  test("a correction scroll cannot expand or shrink the window by itself", async () => {
    const scroll = createTranscriptScrollSignal()
    const shifts: number[] = []
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(120),
        scrollSignal: scroll,
        onContentShift: (dy: number) => shifts.push(dy),
      }),
    )

    scrollToWindowTop(scroll, 90)
    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    // The panel applied the hook's correction and reported where it landed —
    // right at the top of the mounted window. Left unlabelled this immediately
    // starts the next expansion (and its retry timer), which is the jump loop
    // Russell saw (SHO-359).
    act(() => {
      scroll.report(
        {
          y: 70 * (TURN_WINDOW_ESTIMATE + TURN_WINDOW_ROW_GAP) - 700,
          viewportHeight: 800,
          contentHeight: 900_000,
        },
        "correction",
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    view.unmount()
  })

  test("a correction that lands on the bottom does not shrink the window", () => {
    const scroll = createTranscriptScrollSignal()
    const view = render(
      createElement(TurnList as any, {
        messages: longChat(120),
        scrollSignal: scroll,
      }),
    )

    scrollToWindowTop(scroll, 90)
    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    // A big estimate→real correction can put the viewport at the end of the
    // content. That is our own scroll, not the person going back down: the
    // history they are reading must stay mounted.
    act(() => {
      scroll.report(
        { y: 119_300, viewportHeight: 800, contentHeight: 120_000 },
        "correction",
      )
    })

    expect(mountedRows(view.container)).toHaveLength(
      TURN_WINDOW_SIZE + TURN_WINDOW_STEP,
    )

    // A real scroll to the same place does shrink it, as SHO-354 requires.
    act(() => {
      scroll.report({ y: 119_400, viewportHeight: 800, contentHeight: 120_000 })
    })
    expect(mountedRows(view.container)).toHaveLength(TURN_WINDOW_SIZE)

    view.unmount()
  })

  test("an expansion clamped by the in-place editor reports no shift at all", async () => {
    const scroll = createTranscriptScrollSignal()
    const shifts: number[] = []
    const view = render(
      createElement(
        EditContextHost,
        { editingMessageId: "u10", countMessagesAfter: () => 578 } as any,
        createElement(TurnList as any, {
          messages: longChat(300),
          scrollSignal: scroll,
          onContentShift: (dy: number) => shifts.push(dy),
        }),
      ),
    )

    // Everything from the edited turn down is pinned, so a top-of-window
    // scroll mounts nothing. The hook must not record a baseline for turns it
    // only *intended* to mount — the next height change on one of those rows
    // would then be read as "content above the reader changed" and scroll the
    // transcript out from under the click.
    scrollToWindowTop(scroll, 10)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(shifts).toEqual([])

    // The edited turn itself is on screen and its work group can be expanded:
    // that growth is *below* the header and belongs to this row, so it must not
    // be reported as a content shift either.
    fireLayout("turn-u10", 0, TURN_WINDOW_ESTIMATE + 300)
    expect(shifts).toEqual([])

    view.unmount()
  })

  test("a newly mounted turn is measured before any input can arrive", () => {
    // react-native-web defers `onLayout` through `setTimeout(0)`, so a click in
    // the same task as the mount used to beat the first measurement and have
    // the row's own growth (a work group opening) charged as content above the
    // reader — the 190 px jump in SHO-359. The row measures its DOM node in a
    // layout effect instead, which runs before paint. This test never fires a
    // layout event: the correction has to arrive from the mount alone.
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: 400,
        width: 320,
        height: 400,
        toJSON: () => ({}),
      } as DOMRect
    }
    try {
      const scroll = createTranscriptScrollSignal()
      const shifts: number[] = []
      const view = render(
        createElement(TurnList as any, {
          messages: longChat(300),
          scrollSignal: scroll,
          onContentShift: (dy: number) => shifts.push(dy),
        }),
      )

      // The tail window mounts with no pending estimate, so it reports nothing.
      expect(shifts).toEqual([])

      // The expansion mounts 20 turns; each is measured at 400 px against the
      // 280 px the spacer reserved, so the reader is corrected by 120 px per
      // turn — without a single layout event being fired.
      scrollToWindowTop(scroll, 270)
      expect(shifts).toEqual(
        Array.from({ length: TURN_WINDOW_STEP }, () => 400 - TURN_WINDOW_ESTIMATE),
      )

      view.unmount()
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })
})
