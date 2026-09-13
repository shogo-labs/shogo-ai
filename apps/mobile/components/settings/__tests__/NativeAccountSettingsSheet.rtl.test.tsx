// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createNativePhoneReactNativeMock, createNativePhoneSheetMock } from "../../../test/native-phone-sheet-mock"

mock.module("react-native", () => createNativePhoneReactNativeMock())

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => ({
  X: () => createElement("span"),
}))

mock.module(resolve(import.meta.dir, "../../../lib/native-phone-layout"), () => ({
  NATIVE_PHONE_ACCOUNT_SETTINGS_SHEET_RATIO: 0.92,
  NATIVE_PHONE_ACCOUNT_SETTINGS_BODY_RATIO: 0.78,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO: 0.78,
  isNativePlatform: () => true,
  useIsNativePhoneLayout: () => true,
  useNativePhoneSheetChrome: () => ({ panel: undefined, backdrop: {} }),
}))

mock.module(resolve(import.meta.dir, "../../phone/NativePhoneSheet"), () => createNativePhoneSheetMock())

const { NativeAccountSettingsSheet } = await import("../NativeAccountSettingsSheet")

describe("NativeAccountSettingsSheet", () => {
  test("shows the tab title and body, then closes", () => {
    const onClose = mock(() => {})
    render(
      <NativeAccountSettingsSheet visible title="People" onClose={onClose}>
        <span>Members</span>
      </NativeAccountSettingsSheet>,
    )

    expect(screen.getByTestId("native-account-settings-sheet")).toBeTruthy()
    expect(screen.getByText("People")).toBeTruthy()
    expect(screen.getByText("Members")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
