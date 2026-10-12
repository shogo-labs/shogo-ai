// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react"
import { describe, expect, mock, test } from "bun:test"
import { render } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import { preserveUserLineBreaks } from "../user-markdown"

mock.module("react-native", () => createReactNativeMock())

const { MarkdownText } = await import("../MarkdownText.web")

describe("user message markdown", () => {
  test("renders markdown syntax and preserves typed line breaks", () => {
    const { container } = render(
      <MarkdownText isStreaming={false}>
        {preserveUserLineBreaks("**bold**\nsecond line")}
      </MarkdownText>,
    )

    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe(
      "bold",
    )
    expect(container.textContent).toContain("second line")
    expect(container.textContent).not.toContain("**")
  })
})
