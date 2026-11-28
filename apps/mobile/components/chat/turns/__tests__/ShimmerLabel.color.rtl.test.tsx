// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-609 — "Planning next moves" rendered black on the dark theme.
 *
 * The label is one `Animated.Text` per character carrying
 * `text-muted-foreground`. NativeWind never applied that class (the animated
 * primitive was not registered with `cssInterop`), so after SHO-544 dropped the
 * grey literal the row fell back to react-native's black — invisible on dark.
 *
 * This spec asks the animated node what it was actually handed. It fails on
 * origin/main, where the style carries no colour at all.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock, reactNativeMockBase } from "../../../../test/react-native-mock"

let phoneLayout = false
const captured: Record<string, unknown>[] = []

mock.module("react-native", () =>
  createReactNativeMock({
    Animated: {
      ...reactNativeMockBase.Animated,
      Text: (props: Record<string, unknown>) => {
        captured.push(props)
        return createElement("span", null, props.children as never)
      },
    },
  }),
)
const phoneLayoutModule = await import("../../../../lib/native-phone-layout")
mock.module("../../../../lib/native-phone-layout", () => ({
  ...phoneLayoutModule,
  // The predicate is native-only, so a test viewport cannot drive it.
  useIsNativePhoneLayout: () => phoneLayout,
}))
mock.module("../NativeActivitySheet", () => ({
  NATIVE_ACTIVITY_LABEL: "text-[15px] leading-5 text-muted-foreground",
}))

const { ShimmerLabel } = await import("../ShimmerLabel")

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten))
  if (style && typeof style === "object") return style as Record<string, unknown>
  return {}
}

afterEach(() => {
  cleanup()
  captured.length = 0
  phoneLayout = false
})

describe("ShimmerLabel colour (SHO-609)", () => {
  test("every character carries the muted-foreground token as a real colour", () => {
    render(createElement(ShimmerLabel, { label: "Planning" }))

    expect(captured.length).toBe("Planning".length)
    for (const props of captured) {
      const style = flatten(props.style)
      expect(style.color).toBe("rgb(var(--color-muted-foreground))")
      expect(String(props.className)).toContain("text-muted-foreground")
    }
  })

  test("the sweep still drives a per-character opacity", () => {
    render(createElement(ShimmerLabel, { label: "Planning" }))
    const opacities = captured.map((props) => flatten(props.style).opacity)
    expect(opacities.length).toBe("Planning".length)
    // The interpolated value, not a number: the band still sweeps.
    for (const opacity of opacities) expect(typeof opacity).toBe("object")
  })

  test("the phone row keeps the 15px activity scale and its own class", () => {
    phoneLayout = true
    render(createElement(ShimmerLabel, { label: "Rejoining" }))
    const style = flatten(captured[0].style)
    expect(style.fontSize).toBe(15)
    expect(String(captured[0].className)).toContain("text-[15px]")
  })
})
