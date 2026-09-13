// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import { PHONE_DENSITY } from "../../../../lib/phone-density"

mock.module("react-native", () => createReactNativeMock({ Platform: { OS: "ios" } }))
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("lucide-react-native", () => ({
  ChevronRight: () => createElement("span"),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/phone-density"), () => ({
  PHONE_DENSITY,
  densityFor: () => PHONE_DENSITY,
}))

const { AccountSettingsGroup } = await import("../AccountSettingsGroup")

describe("AccountSettingsGroup", () => {
  test("section titles use the phone title size", () => {
    render(
      <AccountSettingsGroup title="Account">
        <span>Email</span>
      </AccountSettingsGroup>,
    )

    const heading = screen.getByText("Account")
    expect(heading.className).toContain(PHONE_DENSITY.text.title)
    expect(heading.className).toContain("font-semibold")
  })
})
