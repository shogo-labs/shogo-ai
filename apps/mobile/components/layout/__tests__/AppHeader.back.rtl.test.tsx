// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-570 — the phone chrome above the Projects list.
 *
 * Every other phone screen with the shared hamburger header is a place you
 * land on, so its left control opens the sidebar. The Projects list is reached
 * from More, so its header shows the standard glass Back instead — the same
 * control every More destination uses to get back.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const onBack = mock(() => {})
let pathname = "/projects"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, onClick: onPress, role: accessibilityRole },
        children,
      ),
  }),
)
mock.module("expo-router", () => ({ usePathname: () => pathname }))
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))
mock.module(resolve(import.meta.dir, "../../../lib/native-phone-layout"), () => ({
  NATIVE_PHONE_HEADER_ICON_SIZE: 22,
  WEB_WIDE_MIN_WIDTH: 768,
  useNativePhoneIconChrome: () => ({ color: "#000", strokeWidth: 2 }),
}))
mock.module(resolve(import.meta.dir, "../../../lib/phone-density"), () => ({
  PHONE_DENSITY: { hit: "h-10 w-10", text: { title: "text-lg" } },
}))
mock.module(resolve(import.meta.dir, "../../notifications/NotificationBell"), () => ({
  NotificationBell: () => null,
}))
mock.module(resolve(import.meta.dir, "../PhoneBackButton"), () => ({
  PhoneBackButton: () => createElement("button", { "aria-label": "Back", onClick: onBack }, "<"),
}))

const { AppHeader } = await import("../AppHeader")

beforeEach(() => {
  cleanup()
  onBack.mockClear()
  pathname = "/projects"
})

describe("AppHeader on the Projects list", () => {
  test("shows the standard Back control instead of the sidebar menu", () => {
    render(createElement(AppHeader, { back: true, onMenuPress: () => {} }))
    expect(screen.getByLabelText("Back")).toBeTruthy()
    expect(screen.queryByLabelText("Open menu")).toBeNull()
    // The title still comes from the shell, so the screen needs no header of its own.
    expect(screen.getByText("Projects")).toBeTruthy()
  })

  test("Back leaves the screen", () => {
    render(createElement(AppHeader, { back: true, onMenuPress: () => {} }))
    fireEvent.click(screen.getByLabelText("Back"))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test("every other screen keeps the hamburger", () => {
    pathname = "/members"
    const onMenuPress = mock(() => {})
    render(createElement(AppHeader, { onMenuPress }))
    expect(screen.queryByLabelText("Back")).toBeNull()
    fireEvent.click(screen.getByLabelText("Open menu"))
    expect(onMenuPress).toHaveBeenCalledTimes(1)
  })
})
