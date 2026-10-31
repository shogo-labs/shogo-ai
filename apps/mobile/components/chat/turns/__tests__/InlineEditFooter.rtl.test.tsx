// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 — the in-place editor's footer: no modal, the revert choice and
 * the "what happens on send" label are visible right under the draft.
 */

import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, disabled, ...props }: any) =>
      createElement("button", { ...props, disabled, onClick: onPress }, children),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

const { InlineEditFooter } = await import("../InlineEditFooter")

function renderFooter(overrides: Partial<Parameters<typeof InlineEditFooter>[0]> = {}) {
  const calls = { send: 0, cancel: 0, revert: [] as boolean[] }
  const props = {
    submitLabel: "Revert & resend",
    hint: "Esc to cancel · ⏎ to send",
    canSend: true,
    onCancel: () => {
      calls.cancel += 1
    },
    onSend: () => {
      calls.send += 1
    },
    revert: {
      checked: true,
      label: "Revert files to before this message",
      hint: "Checkpoint from 3 minutes ago · 4 files changed",
      onChange: (next: boolean) => {
        calls.revert.push(next)
      },
    },
    ...overrides,
  }
  const view = render(createElement(InlineEditFooter, props as any))
  return { view, calls }
}

describe("InlineEditFooter", () => {
  test("shows Cancel, the labelled send and the keyboard hint", () => {
    const { view } = renderFooter()
    expect(view.getByText("Cancel")).toBeTruthy()
    expect(view.getByText("Revert & resend")).toBeTruthy()
    expect(view.getByText("Esc to cancel · ⏎ to send")).toBeTruthy()
  })

  test("Cancel and Send call their handlers", () => {
    const { view, calls } = renderFooter()
    fireEvent.click(view.getByText("Cancel"))
    fireEvent.click(view.getByText("Revert & resend"))
    expect(calls.cancel).toBe(1)
    expect(calls.send).toBe(1)
  })

  test("the revert choice is a visible, checked checkbox with its checkpoint hint", () => {
    const { view, calls } = renderFooter()
    const checkbox = view.getByRole("checkbox") as HTMLElement
    expect(checkbox.getAttribute("aria-checked")).toBe("true")
    expect(view.getByText(/Checkpoint from 3 minutes ago/)).toBeTruthy()
    fireEvent.click(checkbox)
    expect(calls.revert).toEqual([false])
  })

  test("an API error is shown inline, not swallowed", () => {
    const { view } = renderFooter({ error: "truncate-from failed (500)" })
    expect(view.getByRole("alert").textContent).toContain("truncate-from failed (500)")
  })

  test("Send is disabled while there is nothing to send", () => {
    const { view, calls } = renderFooter({ canSend: false })
    const button = view.getByRole("button", { name: "Revert & resend" })
    fireEvent.click(button)
    expect(calls.send).toBe(0)
  })

  test("no revert control is rendered when there is no checkpoint", () => {
    const { view } = renderFooter({
      revert: null,
      submitLabel: "Resend",
    })
    expect(view.queryByRole("checkbox")).toBeNull()
    expect(view.getByText("Resend")).toBeTruthy()
  })
})
