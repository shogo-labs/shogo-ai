// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createNativePhoneReactNativeMock, createNativePhoneSheetMock } from "../../../test/native-phone-sheet-mock"

mock.module("react-native", () => createNativePhoneReactNativeMock())

mock.module(resolve(import.meta.dir, "../../phone/NativePhoneSheet"), () => createNativePhoneSheetMock())

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
