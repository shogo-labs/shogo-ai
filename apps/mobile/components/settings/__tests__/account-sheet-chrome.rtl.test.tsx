// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Text: ({ className, children }: { className?: string; children?: unknown }) =>
      createElement("span", { className }, children as never),
  }),
)

const { AccountSheetChromeProvider, AccountSheetText } = await import(
  "../account-sheet-chrome"
)

describe("AccountSheetText", () => {
  test("keeps desktop Settings type when the Account sheet is closed", () => {
    render(createElement(AccountSheetText, { className: "text-sm" }, "Members"))
    expect(screen.getByText("Members").className).toContain("text-sm")
    expect(screen.getByText("Members").className).not.toContain("text-lg")
  })

  test("bumps type inside an Account settings sheet", () => {
    render(
      createElement(
        AccountSheetChromeProvider,
        null,
        createElement(AccountSheetText, { className: "text-sm text-muted-foreground" }, "Members"),
      ),
    )
    expect(screen.getByText("Members").className).toContain("text-lg")
    expect(screen.getByText("Members").className).toContain("text-muted-foreground")
  })
})
