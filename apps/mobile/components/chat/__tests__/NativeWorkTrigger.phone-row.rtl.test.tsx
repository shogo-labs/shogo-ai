// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `NativeWorkTrigger` — the "Thought" / "Worked for …" row on a native phone
 * (SHO-296).
 *
 * The row is one 15px line plus 2px of padding; its 44pt touch target comes
 * from `hitSlop` rather than a `min-h-11` box, which is what used to leave
 * ~14px of empty space above and below the text.
 */
import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

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
  createReactNativeMock({ Platform: { OS: "ios" }, Pressable: PressableHost }),
)
mock.module(resolve(import.meta.dir, "../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? React.createElement("div", null, children) : null,
  NativePhoneSheetCloseButton: () => null,
}))

const { NativeWorkTrigger, NATIVE_ACTIVITY_HIT_SLOP, NATIVE_ACTIVITY_LABEL } = await import(
  "../NativeActivitySheet"
)

describe("NativeWorkTrigger", () => {
  test("renders the shared 15px activity label", () => {
    render(
      <NativeWorkTrigger label="Worked for 2m">
        <div>details</div>
      </NativeWorkTrigger>,
    )

    const label = screen.getByText("Worked for 2m")
    expect(label.className).toBe(NATIVE_ACTIVITY_LABEL)
    expect(NATIVE_ACTIVITY_LABEL).toContain("text-[15px]")
  })

  test("keeps a 44pt touch target without padding the row out to 44px", () => {
    render(
      <NativeWorkTrigger label="Thought">
        <div>details</div>
      </NativeWorkTrigger>,
    )

    const button = screen.getByRole("button", { name: "Thought" })
    expect(JSON.parse(button.getAttribute("data-hit-slop")!)).toEqual(NATIVE_ACTIVITY_HIT_SLOP)
    // A 20px line (`leading-5`) plus the slop on both sides clears 44pt.
    expect(NATIVE_ACTIVITY_HIT_SLOP.top + 20 + NATIVE_ACTIVITY_HIT_SLOP.bottom).toBeGreaterThanOrEqual(44)
  })
})
