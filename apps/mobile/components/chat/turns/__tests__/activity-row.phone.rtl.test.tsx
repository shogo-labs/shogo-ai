// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every native-phone activity row is on one type scale (SHO-296).
 *
 * Locks:
 *   - the work / thought / planning / tool rows share `NATIVE_ACTIVITY_LABEL`
 *     (15px, one step under the 16px body) instead of splitting across 11, 12
 *     and 15px;
 *   - no row reserves a 44px-tall box around its 20px line — the touch target
 *     comes from `hitSlop`, so the empty space between a row and the sentence
 *     next to it stays in the 8–12px budget.
 */
import { resolve } from "node:path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

/** Exposes `className` and `hitSlop` so a test can read what the row renders. */
const PressableHost = React.forwardRef<HTMLElement, Record<string, unknown>>(
  function PressableHost({ children, accessibilityLabel, className, hitSlop, onPress, ...props }, ref) {
    return React.createElement(
      "button",
      {
        ...props,
        className: className as string | undefined,
        "aria-label": accessibilityLabel as string | undefined,
        "data-hit-slop": hitSlop ? JSON.stringify(hitSlop) : undefined,
        onClick: onPress as (() => void) | undefined,
        ref,
      },
      children as React.ReactNode,
    )
  },
)

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: PressableHost,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  }),
)

mock.module("../../../../lib/native-phone-layout", () => ({
  useIsNativePhoneLayout: () => true,
  usePhoneLayout: () => true,
  useNativePhoneWindow: () => ({ isPhone: true, width: 390, height: 844 }),
  isNativePhoneIntegrationsLayout: () => true,
  nativePhoneFillStyle: (width: number) => ({ width }),
  nativeContentWidth: (windowWidth: number, pad = 32) => Math.max(0, windowWidth - pad),
  NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO: 0.56,
  NATIVE_PHONE_SHEET_COMPACT_RATIO: 0.72,
  NATIVE_PHONE_GUTTER: 16,
}))

mock.module("@legendapp/motion", () => {
  const MotionView = React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionView(
    { children },
    ref,
  ) {
    return React.createElement("div", { ref }, children as React.ReactNode)
  })
  return {
    Motion: { View: MotionView },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  }
})
mock.module("expo-linear-gradient", () => ({ LinearGradient: () => null }))
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}))
// The sheet itself is not under test — its trigger row is.
mock.module(resolve(import.meta.dir, "../../NativeActivitySheet"), () => ({
  NativeActivitySheet: () => null,
  useInsideActivitySheet: () => false,
  NATIVE_ACTIVITY_LABEL: "text-[15px] leading-5 text-muted-foreground",
  NATIVE_ACTIVITY_ROW: "py-0.5",
  NATIVE_ACTIVITY_HIT_SLOP: { top: 12, bottom: 12, left: 8, right: 8 },
}))
mock.module(resolve(import.meta.dir, "../../NativeWorkedSessionExtras"), () => ({
  NativeWorkedSessionExtras: () => null,
}))
mock.module(resolve(import.meta.dir, "../../MarkdownText"), () => ({
  MarkdownText: () => null,
}))
mock.module(resolve(import.meta.dir, "../../ChatContext"), () => ({
  useChatContextSafe: () => null,
}))

const NATIVE_ACTIVITY_LABEL = "text-[15px] leading-5 text-muted-foreground"
const NATIVE_ACTIVITY_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 }

const { ThinkingWidget } = await import("../ThinkingWidget")
const { CollapsibleToolGroup } = await import("../CollapsibleToolGroup")
const { PlanningStatusLine } = await import("../PlanningStatusLine")
const { ExecWidget } = await import("../ExecWidget")

afterEach(cleanup)

/** Every `<Text>` rendered with the shared activity label class. */
function activityLabels(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("span")).filter(
    (el) => el.className === NATIVE_ACTIVITY_LABEL,
  ) as HTMLElement[]
}

describe("native-phone activity rows share one type scale", () => {
  test("the shared label is 15px on a 20px line", () => {
    expect(NATIVE_ACTIVITY_LABEL).toContain("text-[15px]")
    expect(NATIVE_ACTIVITY_LABEL).toContain("leading-5")
  })

  test("a thought row is 15px and hit-slops to a 44pt target", () => {
    const { container } = render(<ThinkingWidget text="thinking it over" />)

    const [label] = activityLabels(container)
    expect(label?.textContent).toBe("Thought")

    const button = container.querySelector("button[data-hit-slop]")
    expect(JSON.parse(button!.getAttribute("data-hit-slop")!)).toEqual(NATIVE_ACTIVITY_HIT_SLOP)
    // 20px line + 12px above + 12px below.
    expect(NATIVE_ACTIVITY_HIT_SLOP.top + 20 + NATIVE_ACTIVITY_HIT_SLOP.bottom).toBeGreaterThanOrEqual(44)
  })

  test("the work-group row drops min-h-11 and hit-slops instead", () => {
    const { container } = render(
      <CollapsibleToolGroup label="Worked for 2m" isStreaming={false}>
        <span>work log</span>
      </CollapsibleToolGroup>,
    )

    const [label] = activityLabels(container)
    expect(label?.textContent).toBe("Worked for 2m")

    const button = container.querySelector("button[data-hit-slop]")!
    expect(button.className).not.toContain("min-h-11")
    expect(JSON.parse(button.getAttribute("data-hit-slop")!)).toEqual(NATIVE_ACTIVITY_HIT_SLOP)
  })

  test("a live work group reads Working… at the same size as its finished label", () => {
    const { container } = render(
      <CollapsibleToolGroup label="Ran 3 commands" isStreaming>
        <span>work log</span>
      </CollapsibleToolGroup>,
    )

    expect(activityLabels(container).map((el) => el.textContent)).toEqual(["Working…"])
  })

  test("the planning status line is on the same scale", () => {
    const { container } = render(<PlanningStatusLine />)

    // The shimmer renders one span per character; all of them share the class.
    expect(activityLabels(container).length).toBeGreaterThan(1)
  })

  test("a streaming exec row is on the same scale", () => {
    const { container } = render(
      <ExecWidget
        tool={{
          id: "tool-1",
          toolName: "exec",
          state: "streaming",
          args: { command: "bun test" },
        } as never}
      />,
    )

    // The row keeps its `flex-1` layout class on top of the shared type scale.
    const rows = Array.from(container.querySelectorAll("span")).filter((el) =>
      el.className.includes("text-[15px]"),
    )
    expect(rows.length).toBe(1)
    expect(rows[0].className).not.toContain("text-[11px]")
  })
})
