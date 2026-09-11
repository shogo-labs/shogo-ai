// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import { COMPACT_DENSITY, PHONE_DENSITY } from "../../../../lib/phone-density"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          "aria-checked": props.accessibilityState?.checked,
          onClick: onPress,
          role: accessibilityRole,
        },
        children,
      ),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return { Check: Icon, Monitor: Icon, Moon: Icon, Sun: Icon }
})

mock.module(resolve(import.meta.dir, "../../../../lib/phone-density"), () => ({
  PHONE_DENSITY,
  COMPACT_DENSITY,
}))

const { ThemeChoiceList } = await import("../ThemeChoiceList")

describe("ThemeChoiceList", () => {
  test("popover radios stay compact; grouped rows use phone density", () => {
    const onSelect = mock(() => {})
    const popover = render(
      <ThemeChoiceList theme="dark" onSelect={onSelect} variant="popover" />,
    )
    expect(screen.getByLabelText("Dark").className).toContain("py-2.5")
    fireEvent.click(screen.getByLabelText("Light"))
    expect(onSelect).toHaveBeenCalledWith("light")
    popover.unmount()

    render(<ThemeChoiceList theme="dark" onSelect={onSelect} variant="grouped" />)
    expect(screen.getByLabelText("Dark").className).toContain(PHONE_DENSITY.rowMin)
  })
})
