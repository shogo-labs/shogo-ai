// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock({ Platform: { OS: "ios" } }))

const { CappedContentScroll } = await import("../CappedContentScroll")

describe("CappedContentScroll", () => {
  test("pins a pixel height so a tall plan cannot push the composer off screen", () => {
    const { container } = render(
      <CappedContentScroll maxHeight={200} testID="capped">
        <div>Plan body</div>
      </CappedContentScroll>,
    )
    const scroller = container.querySelector('[data-rn-shim="capped"]')
    expect(scroller).toBeTruthy()
    expect((scroller as HTMLElement).style.height).toBe("200px")
  })
})
