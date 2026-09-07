// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RTL coverage for TurnFooter — the thumbs up/down, copy, fork, and
 * relative-timestamp row rendered under a completed assistant turn.
 *
 * Locks:
 *   - Feedback toggle: tapping a thumb calls `setFeedback`; tapping the
 *     SAME thumb again calls `clearFeedback` instead (toggle-off, not a
 *     second `setFeedback('up')`).
 *   - Fork: tapping the fork button calls `forkFromMessage` with the
 *     message id.
 *   - Disabled state: `canActOnMessage: false` (e.g. an optimistic
 *     `temp-*` id) disables feedback/fork so taps are no-ops.
 *   - Degrades gracefully with no `TurnFooterProvider` mounted — copy
 *     still renders, feedback/fork buttons render disabled.
 *   - Relative time renders via `formatRelativeTime`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act, fireEvent, render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import type { MessageFeedbackThumbs } from "../TurnFooterContext"

// The base `react-native` mock renders `testID` as a non-standard
// `data-rn-shim` attribute (see that file's header — it's a deliberate
// passthrough so unrelated transitive deps don't crash at module load).
// `getByTestId` needs a real `data-testid`, so — same as
// `ChatInput.integration.test.tsx` — layer a small Host override that
// maps `testID` -> `data-testid` on top of the full mock surface instead
// of replacing it outright.
const Host = React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  { accessibilityLabel, children, disabled, onPress, testID, ...props },
  ref,
) {
  return React.createElement(
    "button",
    {
      ...props,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      disabled,
      onClick: disabled ? undefined : onPress,
      ref,
    },
    children as React.ReactNode,
  )
})

mock.module("react-native", () => createReactNativeMock({ Pressable: Host }))

// expo-clipboard triggers native module resolution (`requireNativeModule`)
// which the global preload stubs to `{}` — real `setStringAsync` would be
// `undefined` there. Stub it directly so the copy button's happy path is
// under test too, matching the per-file `mock.module` pattern documented
// in `test/testing-library.ts`.
const setStringAsync = mock(async (_text: string) => true)
mock.module("expo-clipboard", () => ({ setStringAsync }))

// `@shogo/shared-ui` is a separate workspace package — its own `import
// "react-native"` can resolve to a different physical node_modules copy
// than the one the global preload's bare-specifier `mock.module` catches
// (see `test/testing-library.ts`'s header comment), which then fails to
// parse the real Flow-typed `react-native/index.js`. Stub the one export
// TurnFooter actually uses instead of pulling in the whole barrel — same
// fix as `ChatInput.integration.test.tsx`.
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

// All mocks above MUST be registered before `TurnFooter`'s module graph
// is evaluated — a static top-level `import` would be hoisted ahead of
// the `mock.module` calls (same ESM-hoisting pitfall documented in
// `test/dom-setup.ts`), so pull it in dynamically instead.
const { TurnFooter } = await import("../TurnFooter")
const { TurnFooterProvider } = await import("../TurnFooterContext")

function makeCtx(overrides: {
  feedback?: Record<string, MessageFeedbackThumbs>
  setFeedback?: ReturnType<typeof mock>
  clearFeedback?: ReturnType<typeof mock>
  forkFromMessage?: ReturnType<typeof mock>
  canActOnMessage?: (messageId: string) => boolean
} = {}) {
  return {
    feedback: overrides.feedback ?? {},
    setFeedback: overrides.setFeedback ?? mock(async () => {}),
    clearFeedback: overrides.clearFeedback ?? mock(async () => {}),
    forkFromMessage: overrides.forkFromMessage ?? mock(async () => {}),
    canActOnMessage: overrides.canActOnMessage ?? (() => true),
  }
}

beforeEach(() => {
  setStringAsync.mockClear()
})

describe("TurnFooter", () => {
  test("copy button copies the turn text to the clipboard", async () => {
    render(<TurnFooter messageId="m1" text="hello world" completedAt={undefined} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-footer-copy"))
    })

    expect(setStringAsync).toHaveBeenCalledWith("hello world")
  })

  test("tapping thumbs-up calls setFeedback('up') when no reaction exists yet", () => {
    const ctx = makeCtx()
    render(
      <TurnFooterProvider {...ctx}>
        <TurnFooter messageId="m1" text="hi" completedAt={undefined} />
      </TurnFooterProvider>,
    )

    fireEvent.click(screen.getByTestId("turn-footer-thumb-up"))

    expect(ctx.setFeedback).toHaveBeenCalledWith("m1", "up")
    expect(ctx.clearFeedback).not.toHaveBeenCalled()
  })

  test("tapping the ALREADY-ACTIVE thumb calls clearFeedback instead of setFeedback again (toggle-off)", () => {
    const ctx = makeCtx({ feedback: { m1: "up" } })
    render(
      <TurnFooterProvider {...ctx}>
        <TurnFooter messageId="m1" text="hi" completedAt={undefined} />
      </TurnFooterProvider>,
    )

    fireEvent.click(screen.getByTestId("turn-footer-thumb-up"))

    expect(ctx.clearFeedback).toHaveBeenCalledWith("m1")
    expect(ctx.setFeedback).not.toHaveBeenCalled()
  })

  test("tapping thumbs-down while thumbs-up is active flips via setFeedback('down')", () => {
    const ctx = makeCtx({ feedback: { m1: "up" } })
    render(
      <TurnFooterProvider {...ctx}>
        <TurnFooter messageId="m1" text="hi" completedAt={undefined} />
      </TurnFooterProvider>,
    )

    fireEvent.click(screen.getByTestId("turn-footer-thumb-down"))

    expect(ctx.setFeedback).toHaveBeenCalledWith("m1", "down")
  })

  test("tapping fork calls forkFromMessage with the message id", async () => {
    const ctx = makeCtx()
    render(
      <TurnFooterProvider {...ctx}>
        <TurnFooter messageId="m1" text="hi" completedAt={undefined} />
      </TurnFooterProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-footer-fork"))
    })

    expect(ctx.forkFromMessage).toHaveBeenCalledWith("m1")
  })

  test("feedback/fork are no-ops when canActOnMessage returns false (optimistic id)", () => {
    const ctx = makeCtx({ canActOnMessage: () => false })
    render(
      <TurnFooterProvider {...ctx}>
        <TurnFooter messageId="temp-123" text="hi" completedAt={undefined} />
      </TurnFooterProvider>,
    )

    fireEvent.click(screen.getByTestId("turn-footer-thumb-up"))
    fireEvent.click(screen.getByTestId("turn-footer-thumb-down"))
    fireEvent.click(screen.getByTestId("turn-footer-fork"))

    expect(ctx.setFeedback).not.toHaveBeenCalled()
    expect(ctx.clearFeedback).not.toHaveBeenCalled()
    expect(ctx.forkFromMessage).not.toHaveBeenCalled()
  })

  test("degrades gracefully with no provider mounted: copy works, feedback/fork are inert", () => {
    render(<TurnFooter messageId="m1" text="hi" completedAt={undefined} />)

    // None of these should throw despite there being no context.
    fireEvent.click(screen.getByTestId("turn-footer-thumb-up"))
    fireEvent.click(screen.getByTestId("turn-footer-thumb-down"))
    fireEvent.click(screen.getByTestId("turn-footer-fork"))

    expect(screen.getByTestId("turn-footer-copy")).toBeTruthy()
  })

  test("renders the relative-time label from completedAt", () => {
    const twoMinutesAgo = Date.now() - 2 * 60_000
    render(<TurnFooter messageId="m1" text="hi" completedAt={twoMinutesAgo} />)

    expect(screen.getByText("2m ago")).toBeTruthy()
  })

  test("renders no relative-time label when completedAt is undefined", () => {
    render(<TurnFooter messageId="m1" text="hi" completedAt={undefined} />)

    expect(screen.queryByText(/ago$/)).toBeNull()
  })
})
