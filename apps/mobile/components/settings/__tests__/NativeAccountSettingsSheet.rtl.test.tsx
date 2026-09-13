// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
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

mock.module("lucide-react-native", () => ({
  X: () => createElement("span"),
}))

mock.module(resolve(import.meta.dir, "../../../lib/native-phone-layout"), () => ({
  NATIVE_PHONE_ACCOUNT_SETTINGS_SHEET_RATIO: 0.92,
  NATIVE_PHONE_ACCOUNT_SETTINGS_BODY_RATIO: 0.78,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO: 0.78,
  isNativePlatform: () => true,
  useNativePhoneSheetChrome: () => ({ panel: undefined, backdrop: {} }),
}))

mock.module(resolve(import.meta.dir, "../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheetCloseButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { "aria-label": "Close", onClick: onPress }, "Close"),
  NativePhoneSheet: ({
    visible,
    title,
    children,
    headerLeft,
  }: {
    visible: boolean
    title?: string
    children: ReactNode
    headerLeft?: ReactNode
  }) =>
    visible
      ? createElement(
          "div",
          { "data-testid": "native-account-settings-sheet" },
          headerLeft,
          createElement("h1", null, title),
          children,
        )
      : null,
}))

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
