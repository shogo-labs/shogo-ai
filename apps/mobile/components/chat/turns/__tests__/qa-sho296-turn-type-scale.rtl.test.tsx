// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-296 acceptance — one assistant turn on a native phone is one type scale
 * and one vertical rhythm.
 *
 * Independently written from the card's ACs (it does not mock the shared
 * constants it asserts on): every activity row renders the real
 * `NATIVE_ACTIVITY_LABEL` exported by `NativeActivitySheet`, and none of the
 * rows in a turn keeps an 11/12px label or a `min-h-11` box.
 */
import { resolve } from "node:path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

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
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  }),
)

mock.module("../../../lib/native-phone-layout", () => ({
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

mock.module(resolve(import.meta.dir, "../../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheet: () => null,
  NativePhoneSheetCloseButton: () => null,
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
mock.module(resolve(import.meta.dir, "../../NativeWorkedSessionExtras"), () => ({
  NativeWorkedSessionExtras: () => null,
}))
mock.module(resolve(import.meta.dir, "../../MarkdownText"), () => ({ MarkdownText: () => null }))
mock.module(resolve(import.meta.dir, "../../ChatContext"), () => ({ useChatContextSafe: () => null }))

const {
  NATIVE_ACTIVITY_LABEL,
  NATIVE_ACTIVITY_ROW,
  NATIVE_ACTIVITY_HIT_SLOP,
} = await import("../../NativeActivitySheet")
const { ThinkingWidget } = await import("../ThinkingWidget")
const { CollapsibleToolGroup } = await import("../CollapsibleToolGroup")
const { PlanningStatusLine } = await import("../PlanningStatusLine")
const { ExecWidget } = await import("../ExecWidget")
const { EditFileWidget } = await import("../EditFileWidget")
const { WriteFileWidget } = await import("../WriteFileWidget")
const { InlineToolWidget } = await import("../InlineToolWidget")

afterEach(cleanup)

/** Every span whose class list carries a small legacy transcript size. */
function smallText(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("span")).filter((el) => {
    const cls = el.className
    return cls.includes("text-[11px]") || cls.includes("text-xs") || cls.includes("text-[12px]")
  }) as HTMLElement[]
}

function textsOnActivityScale(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("span")).filter((el) =>
    el.className.includes(NATIVE_ACTIVITY_LABEL),
  ) as HTMLElement[]
}

const LONG_LINE = 20

describe("SHO-296 — native-phone activity rows", () => {
  test("the shared label is 15px on a 20px line", () => {
    expect(NATIVE_ACTIVITY_LABEL).toContain("text-[15px]")
    expect(NATIVE_ACTIVITY_LABEL).toContain("leading-5")
    // Nothing smaller than the acticity scale survives in a row.
    expect(NATIVE_ACTIVITY_LABEL).not.toContain("text-[11px]")
    expect(NATIVE_ACTIVITY_LABEL).not.toContain("text-xs")
  })

  test("the row keeps a 20px line, not a 44px box", () => {
    expect(NATIVE_ACTIVITY_ROW).not.toContain("min-h-11")
    expect(NATIVE_ACTIVITY_HIT_SLOP.top + LONG_LINE + NATIVE_ACTIVITY_HIT_SLOP.bottom).toBeGreaterThanOrEqual(44)
  })

  test("a thought row is 15px, hit-slops to 44pt, and opens its sheet", () => {
    const { container } = render(<ThinkingWidget text="thinking it over" />)

    const labels = textsOnActivityScale(container)
    expect(labels.map((el) => el.textContent)).toEqual(["Thought"])

    const button = container.querySelector("button[data-hit-slop]")!
    expect(JSON.parse(button.getAttribute("data-hit-slop")!)).toEqual(NATIVE_ACTIVITY_HIT_SLOP)
    expect(smallText(container)).toHaveLength(0)
  })

  test("a finished and a live work-group row share the scale and drop min-h-11", () => {
    for (const [label, expected] of [
      ["Worked for 2m", "Worked for 2m"],
      ["Ran 3 commands", "Working…"],
    ] as const) {
      const streaming = label === "Ran 3 commands"
      const { container, unmount } = render(
        <CollapsibleToolGroup label={label} isStreaming={streaming}>
          <span>log</span>
        </CollapsibleToolGroup>,
      )

      expect(textsOnActivityScale(container).map((el) => el.textContent)).toEqual([expected])
      const button = container.querySelector("button[data-hit-slop]")!
      expect(button.className).not.toContain("min-h-11")
      expect(JSON.parse(button.getAttribute("data-hit-slop")!)).toEqual(NATIVE_ACTIVITY_HIT_SLOP)
      unmount()
    }
  })

  test("the planning status line is on the same scale", () => {
    const { container } = render(<PlanningStatusLine />)
    expect(textsOnActivityScale(container).length).toBeGreaterThan(1)
    expect(smallText(container)).toHaveLength(0)
  })

  test("a streaming exec row is 15px, not 11px", () => {
    const { container } = render(
      <ExecWidget
        tool={{ id: "t1", toolName: "exec", state: "streaming", args: { command: "bun test" } } as never}
      />,
    )
    const rows = textsOnActivityScale(container)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((el) => el.className.includes("flex-1"))).toBe(true)
  })

  test("an inline tool row is 15px, not 11px", () => {
    const { container } = render(
      <InlineToolWidget
        tool={{ id: "t2", toolName: "read_file", state: "streaming", args: { path: "a.ts" } } as never}
      />,
    )
    expect(textsOnActivityScale(container).length).toBeGreaterThan(0)
  })
})
