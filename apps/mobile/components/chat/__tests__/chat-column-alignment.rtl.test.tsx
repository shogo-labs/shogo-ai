// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Alignment contract for the shared chat column: surfaces that sit inside a
 * column (the composer dock, `ChatColumn` rows) announce it, so children
 * like `ChatInput` add no width or gutter of their own.
 */
import { describe, expect, mock, test } from "bun:test"
import { render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

const { Animated } = await import("react-native")
const { ChatColumn, useIsInsideChatColumn } = await import("../ChatColumn")
const { ProjectComposerDock } = await import("../composer/ProjectComposerDock")
const { chatColumnStyle } = await import("../../../lib/chat-column")

function Probe() {
  return <span data-testid="probe">{String(useIsInsideChatColumn())}</span>
}

describe("shared chat column", () => {
  test("is not announced outside a column", () => {
    const { getByTestId } = render(<Probe />)
    expect(getByTestId("probe").textContent).toBe("false")
  })

  test("ChatColumn announces itself and applies the shared width", () => {
    const { getByTestId, container } = render(
      <ChatColumn presentation="agent" testID="col">
        <Probe />
      </ChatColumn>,
    )
    expect(getByTestId("probe").textContent).toBe("true")
    const column = container.querySelector('[data-rn-shim="col"]') as HTMLElement
    const expected = chatColumnStyle({ presentation: "agent" })
    expect(column.style.width).toBe(String(expected.width))
    expect(column.style.maxWidth).toBe(`${expected.maxWidth}px`)
  })

  test("ProjectComposerDock announces the column to the composer and dock", () => {
    const pad = new Animated.Value(0)
    const { getByTestId } = render(
      <ProjectComposerDock
        presentation="agent"
        keyboardPad={pad}
        keyboardOpen={false}
        restPad={0}
        applyKeyboardPad={false}
        native={false}
      >
        <Probe />
      </ProjectComposerDock>,
    )
    expect(getByTestId("probe").textContent).toBe("true")
  })
})
