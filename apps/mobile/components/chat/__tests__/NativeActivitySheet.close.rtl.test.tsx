// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
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

mock.module(resolve(import.meta.dir, "../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheetCloseButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { "aria-label": "Close", onClick: onPress }, "Close"),
  NativePhoneSheet: ({
    visible,
    title,
    headerLeft,
    children,
  }: {
    visible: boolean
    title?: string
    headerLeft?: ReactNode
    children: ReactNode
  }) =>
    visible ? (
      <div>
        {headerLeft}
        <h1>{title}</h1>
        {children}
      </div>
    ) : null,
}))

const { NativeActivitySheet } = await import("../NativeActivitySheet")

describe("NativeActivitySheet close control", () => {
  test("hides the close button when the model picker asks for grabber-only dismiss", () => {
    render(
      <NativeActivitySheet visible title="Model" onClose={() => {}} showClose={false}>
        <div>rows</div>
      </NativeActivitySheet>,
    )

    expect(screen.getByText("Model")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
  })

  test("keeps the close button on thought and work sheets", () => {
    render(
      <NativeActivitySheet visible title="Thought" onClose={() => {}}>
        <div>body</div>
      </NativeActivitySheet>,
    )

    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
  })
})
