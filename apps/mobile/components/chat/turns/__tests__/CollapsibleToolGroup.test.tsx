// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RTL coverage for `CollapsibleToolGroup`'s `scrollBody` prop.
 *
 * Locks:
 *   - `scrollBody` unset (default `true`, used by `WorkGroup`) renders the
 *     expanded body as a `ScrollView` (`collapsible-scroll-body`) — the
 *     capped, internally-scrollable shell individual work runs need.
 *   - `scrollBody={false}` (used by `WorkedForGroup`, the turn-level
 *     "Worked for X" wrapper) renders the expanded body as a plain `View`
 *     (`collapsible-plain-body`) instead — no nested scroll region, so the
 *     final work log opens/closes inline in the page's own scroll.
 *   - Either way, the body's children are actually rendered (not swallowed
 *     by whichever wrapper is chosen).
 *
 * `@legendapp/motion` and `expo-linear-gradient` are stubbed to inert
 * passthroughs — this file only asserts on DOM structure, not animation,
 * matching the project's "extract pure logic, don't RTL-test Animated
 * internals" convention (see `test/testing-library.ts`'s header comment).
 */
import { describe, expect, mock, test } from "bun:test"
import { render, screen, within } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

// Same "Host maps testID -> data-testid" pattern as `TurnFooter.test.tsx` —
// the base mock renders `testID` as a non-standard `data-rn-shim`
// attribute, but `getByTestId` needs a real `data-testid`.
//
// RN-only props are dropped rather than spread onto the div:
//   - `style` — `CollapsibleToolGroup` passes RN-style ARRAY style values
//     (e.g. `[styles.capHeight, WEB_FADE_MASK]`), and React DOM's real
//     `style` prop handling chokes on an array (`Object.keys` walks its
//     indices as "property names", then throws assigning to the DOM
//     `CSSStyleDeclaration`'s read-only indexed properties). Matches
//     `reactNativeMockBase`'s own `passthroughHost`, which drops it too.
//   - `onLayout` / `onContentSizeChange` / `onScrollBeginDrag` /
//     `scrollEnabled` / `nestedScrollEnabled` / `accessibilityLabel` — real
//     RN props with no DOM equivalent; harmless if left in (React just
//     warns), dropped here to keep test output clean.
const Host = React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  {
    children,
    testID,
    style: _style,
    onLayout: _onLayout,
    onContentSizeChange: _onContentSizeChange,
    onScrollBeginDrag: _onScrollBeginDrag,
    scrollEnabled: _scrollEnabled,
    nestedScrollEnabled: _nestedScrollEnabled,
    accessibilityLabel,
    ...props
  },
  ref,
) {
  return React.createElement(
    "div",
    { ...props, "aria-label": accessibilityLabel, "data-testid": testID, ref },
    children as React.ReactNode,
  )
})

mock.module("react-native", () =>
  createReactNativeMock({
    View: Host,
    ScrollView: Host,
    Pressable: React.forwardRef<HTMLElement, Record<string, unknown>>(function PressableHost(
      { children, testID, accessibilityLabel, onPress, ...props },
      ref,
    ) {
      return React.createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, "data-testid": testID, onClick: onPress, ref },
        children as React.ReactNode,
      )
    }),
  }),
)

// `@legendapp/motion`'s `Motion.View` / `AnimatePresence` add animation
// timing this file doesn't care about — swap for inert passthroughs so
// the expanded body renders (and un-renders) synchronously under RTL.
const MotionView = React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionView(
  { children },
  ref,
) {
  return React.createElement("div", { ref }, children as React.ReactNode)
})
mock.module("@legendapp/motion", () => ({
  Motion: { View: MotionView },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

// The top/bottom scroll fade overlays are native-only decoration (see
// `CollapsibleToolGroup`'s `Platform.OS !== "web"` guard) — stub the
// module anyway so its import doesn't need a real native module.
mock.module("expo-linear-gradient", () => ({
  LinearGradient: () => null,
}))

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

// All mocks above MUST be registered before `CollapsibleToolGroup`'s module
// graph is evaluated — see `TurnFooter.test.tsx` for why this has to be a
// dynamic import rather than a static top-level one.
const { CollapsibleToolGroup } = await import("../CollapsibleToolGroup")

describe("CollapsibleToolGroup scrollBody", () => {
  test("defaults to a ScrollView body (used by per-run WorkGroup accordions)", () => {
    render(
      <CollapsibleToolGroup label="Ran 3 commands" isStreaming={false} isExpanded>
        <span>work log contents</span>
      </CollapsibleToolGroup>,
    )

    const body = screen.getByTestId("collapsible-scroll-body")
    expect(body).toBeTruthy()
    expect(screen.queryByTestId("collapsible-plain-body")).toBeNull()
    expect(within(body).getByText("work log contents")).toBeTruthy()
  })

  test("scrollBody={false} renders a plain View body with no inner scroll (used by the final Worked-for wrapper)", () => {
    render(
      <CollapsibleToolGroup label="Worked for 2m" isStreaming={false} isExpanded scrollBody={false}>
        <span>full work log</span>
      </CollapsibleToolGroup>,
    )

    const body = screen.getByTestId("collapsible-plain-body")
    expect(body).toBeTruthy()
    expect(screen.queryByTestId("collapsible-scroll-body")).toBeNull()
    expect(within(body).getByText("full work log")).toBeTruthy()
  })

  test("collapsing (isExpanded=false) hides both body variants", () => {
    render(
      <CollapsibleToolGroup label="Worked for 2m" isStreaming={false} isExpanded={false} scrollBody={false}>
        <span>full work log</span>
      </CollapsibleToolGroup>,
    )

    expect(screen.queryByTestId("collapsible-plain-body")).toBeNull()
    expect(screen.queryByTestId("collapsible-scroll-body")).toBeNull()
  })
})
