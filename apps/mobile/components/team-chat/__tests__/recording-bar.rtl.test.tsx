// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a person sees and can do while a voice note is recording.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: {
      OS: "web",
      Version: 0,
      isPad: false,
      isTV: false,
      select: <T,>(spec: { web?: T; default?: T }) => spec.web,
    },
    // A test double, so it only needs to behave like RN's Pressable.
    Pressable: (({
      accessibilityLabel,
      accessibilityRole: _role,
      children,
      onPress,
      ...props
    }: {
      accessibilityLabel?: string
      accessibilityRole?: string
      children?: ReactNode
      onPress?: () => void
    }) =>
      createElement(
        "div",
        { ...props, role: "button", "aria-label": accessibilityLabel, onClick: onPress },
        children,
      )) as never,
  }),
)

mock.module("lucide-react-native", () => ({
  Check: () => createElement("span", null, "check-icon"),
  Trash2: () => createElement("span", null, "trash-icon"),
}))

const { RecordingBar } = await import("../RecordingBar")
const { MAX_VOICE_NOTE_MS } = await import("../../../lib/voice-note")

afterEach(cleanup)

const renderBar = (props: Partial<Parameters<typeof RecordingBar>[0]> = {}) => {
  const onCancel = mock(() => {})
  const onFinish = mock(() => {})
  const view = render(
    createElement(RecordingBar, { level: 40, elapsedMs: 7_000, onCancel, onFinish, ...props }),
  )
  return { ...view, onCancel, onFinish }
}

describe('the recording bar', () => {
  test('shows how long the clip has been running', () => {
    renderBar({ elapsedMs: 7_400 })
    expect(screen.getByText("0:07")).toBeDefined()
  })

  test('offers a way out and a way to finish', () => {
    const { onCancel, onFinish } = renderBar()
    fireEvent.click(screen.getByLabelText("Cancel recording"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledTimes(0)

    fireEvent.click(screen.getByLabelText("Finish recording"))
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('draws a level meter that reacts to the microphone', () => {
    const { container, rerender } = renderBar({ level: 100 })
    // Only the meter bars carry both of these classes.
    const meterOf = () =>
      Array.from(container.querySelectorAll("div.flex-1.rounded-full")).map(
        (bar) => (bar as HTMLElement).style.height,
      )

    const loud = meterOf()
    expect(loud.length).toBeGreaterThan(10)
    expect(loud.at(-1)).not.toBe("3px")

    rerender(
      createElement(RecordingBar, { level: 0, elapsedMs: 7_000, onCancel: () => {}, onFinish: () => {} }),
    )
    // A silent sample is still drawn, as a floor-height bar.
    expect(meterOf().at(-1)).toBe("3px")
  })

  test('warns before it hits the length cap, and not before', () => {
    renderBar({ elapsedMs: 1_000 })
    expect(screen.queryByText(/^Max/)).toBeNull()

    renderBar({ elapsedMs: MAX_VOICE_NOTE_MS - 5_000 })
    expect(screen.getByText(`Max ${"5:00"}`)).toBeDefined()
  })
})
