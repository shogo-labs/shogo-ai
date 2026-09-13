// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import { NATIVE_PHONE_HOME_CANVAS } from "../../../lib/native-phone-layout"

mock.module("react-native", () => createReactNativeMock({ Platform: { OS: "ios" } }))
mock.module("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children, style, ...props }: any) =>
    createElement("div", { ...props, style, "data-testid": "safe-area" }, children),
}))

const { NativeSheetDrawerShell } = await import("../NativeSheetDrawerShell")

function drawerStub(overrides: Record<string, unknown> = {}) {
  return {
    drawerOpen: false,
    sheetSwipeHandlers: undefined,
    sheetStyle: { transform: [{ translateX: 0 }] },
    sheetClipStyle: {
      flex: 1,
      overflow: "hidden",
      backgroundColor: NATIVE_PHONE_HOME_CANVAS,
    },
    sheetFill: NATIVE_PHONE_HOME_CANVAS,
    sheetCompositing: false,
    underlayStyle: { position: "absolute" },
    ...overrides,
  } as any
}

describe("NativeSheetDrawerShell", () => {
  test("native drawer frame uses the sheet fill and does not clip the slide", () => {
    const { container } = render(
      <NativeSheetDrawerShell
        isWide={false}
        nativeSheetDrawer
        canvas="#000000"
        sidebarWide={null}
        sidebarSheet={<span>Sidebar</span>}
        header={null}
        drawer={drawerStub()}
      >
        <span>Home</span>
      </NativeSheetDrawerShell>,
    )

    expect(screen.getByTestId("safe-area").style.backgroundColor).toBe(
      NATIVE_PHONE_HOME_CANVAS,
    )
    const frame = Array.from(container.querySelectorAll("div")).find(
      (node) => node.style.overflow === "visible",
    )
    expect(frame?.style.backgroundColor).toBe(NATIVE_PHONE_HOME_CANVAS)
    expect(frame?.style.overflow).toBe("visible")
  })
})
