// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import { NATIVE_MODEL_SHEET } from "../model-picker-sheet-chrome"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("../../lib/native-phone-layout", () => ({
  isNativePlatform: () => true,
}))

const { AutoModelOption } = await import("../AutoModelOption")

describe("AutoModelOption sheet type", () => {
  test("uses the larger phone sheet type without cost copy", () => {
    render(
      <AutoModelOption currentModelId="auto" presentation="sheet" onSelect={() => {}} />,
    )

    expect(screen.getByText("Auto").className).toContain(NATIVE_MODEL_SHEET.nameClass)
    expect(screen.queryByText("Uses fewer credits per step")).toBeNull()
    expect(screen.queryByText("Cheaper")).toBeNull()
  })

  test("does not render cost copy when the model is selected", () => {
    render(
      <AutoModelOption
        currentModelId="auto"
        presentation="sheet"
        onSelect={() => {}}
      />,
    )

    expect(screen.getByText("Auto")).toBeTruthy()
    expect(screen.queryByText("Uses fewer credits per step")).toBeNull()
    expect(screen.queryByText("Cheaper")).toBeNull()
  })
})
