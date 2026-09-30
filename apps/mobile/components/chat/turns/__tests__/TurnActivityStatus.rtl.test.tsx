// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The retry status renders inline where "Planning next moves" does — not in
 * the dock — and only after the 5s grace period.
 */
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const Host = React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  { accessibilityLabel, children, onPress, ...props },
  ref,
) {
  return React.createElement(
    "button",
    { ...props, "aria-label": accessibilityLabel, onClick: onPress, ref },
    children as React.ReactNode,
  )
})

const LabelledView = React.forwardRef<HTMLElement, Record<string, unknown>>(function LabelledView(
  { accessibilityLabel, accessibilityLiveRegion: _live, accessible: _a, children, ...props },
  ref,
) {
  return React.createElement("div", { ...props, "aria-label": accessibilityLabel, ref }, children as React.ReactNode)
})

mock.module("react-native", () => createReactNativeMock({ Pressable: Host, View: LabelledView }))

const { TurnActivityStatus } = await import("../TurnActivityStatus")
const { TurnRetryStatusProvider } = await import("../TurnRetryStatusContext")

function renderSlot(
  status: { cause: "offline" | "server" | "provider"; startedAt: number; reason?: string } | null,
  opts: { isStreaming?: boolean; showPlanning?: boolean; onRetryNow?: () => void; onSwitch?: () => void } = {},
) {
  return render(
    <TurnRetryStatusProvider
      value={{
        status,
        onRetryNow: opts.onRetryNow ?? (() => {}),
        switchModel: opts.onSwitch ? { label: "GPT", onSwitch: opts.onSwitch } : null,
      }}
    >
      <TurnActivityStatus isStreaming={opts.isStreaming ?? true} showPlanning={opts.showPlanning ?? true} />
    </TurnRetryStatusProvider>,
  )
}

describe("TurnActivityStatus", () => {
  test("no retry → Planning next moves", () => {
    renderSlot(null)
    expect(screen.getByLabelText("Planning next moves")).toBeTruthy()
  })

  test("first 5s of a retry → still Planning next moves", () => {
    renderSlot({ cause: "server", startedAt: Date.now() - 1_000 })
    expect(screen.getByLabelText("Planning next moves")).toBeTruthy()
    expect(screen.queryByLabelText("Reconnecting\u2026")).toBeNull()
  })

  test("5–30s → Reconnecting… in its place, even when planning isn't showing", () => {
    renderSlot({ cause: "server", startedAt: Date.now() - 10_000 }, { showPlanning: false })
    expect(screen.getByLabelText("Reconnecting\u2026")).toBeTruthy()
    expect(screen.queryByLabelText("Planning next moves")).toBeNull()
  })

  test("30s+ → cause, elapsed and a working Retry now", () => {
    const onRetryNow = mock(() => {})
    renderSlot({ cause: "offline", startedAt: Date.now() - 45_000 }, { onRetryNow })
    expect(screen.getByLabelText("You're offline")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Retry now"))
    expect(onRetryNow).toHaveBeenCalledTimes(1)
  })

  test("2m+ overload → one-tap switch to a similar model", () => {
    const onSwitch = mock(() => {})
    renderSlot({ cause: "provider", reason: "overloaded", startedAt: Date.now() - 130_000 }, { onSwitch })
    fireEvent.click(screen.getByLabelText("Switch to GPT"))
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  test("turns that aren't streaming never show the retry status", () => {
    renderSlot({ cause: "server", startedAt: Date.now() - 60_000 }, { isStreaming: false, showPlanning: false })
    expect(screen.queryByLabelText("Can't reach Shogo")).toBeNull()
  })
})
