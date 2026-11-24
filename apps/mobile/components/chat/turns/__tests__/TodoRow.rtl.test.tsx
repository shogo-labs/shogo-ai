// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-574. The stream's "Updated tasks" row is a quiet pointer to the dock's
 * Tasks panel: text only, no icon, and tappable on desktop/web to open that
 * panel (the phone keeps the checklist in the "Worked" sheet, so the row is
 * not tappable there).
 *
 * `lucide-react-native` is mocked to a sentinel so re-adding the old
 * `ListTodo` / `Loader2` icon fails this test instead of silently passing.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const phoneState = { current: false }
const openPanel = mock((_id: string) => {})

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ onPress, children, disabled, ...props }: any) =>
      createElement("button", { ...props, disabled, onClick: onPress }, children),
  }),
)

mock.module("lucide-react-native", () => {
  const sentinel = (name: string) => () =>
    createElement("svg", { "data-lucide": name })
  return {
    ListTodo: sentinel("list-todo"),
    Loader2: sentinel("loader-2"),
    ChevronRight: sentinel("chevron-right"),
    ChevronDown: sentinel("chevron-down"),
  }
})

mock.module("../../../../lib/native-phone-layout", () => ({
  useIsNativePhoneLayout: () => phoneState.current,
  usePhoneLayout: () => phoneState.current,
}))

mock.module("../../../../lib/chat-dock-store", () => ({
  useChatDockStore: () => ({ openPanel }),
}))

const { TodoRow } = await import("../TodoRow")

function todoTool(
  args: Record<string, unknown> = { todos: [{ content: "Ship it", status: "in_progress" }] },
  state: "success" | "streaming" = "success",
) {
  return {
    id: "tool-1",
    toolName: "todo_write",
    category: "other",
    state,
    args,
    timestamp: Date.now(),
  } as any
}

describe("TodoRow", () => {
  afterEach(() => {
    cleanup()
    phoneState.current = false
    openPanel.mockClear()
  })

  test("renders the checklist pointer with no icon", () => {
    const view = render(
      createElement(TodoRow, {
        tool: todoTool({
          todos: [
            { content: "One", status: "completed" },
            { content: "Two", status: "in_progress" },
          ],
        }),
      }),
    )
    const row = view.getByRole("button", { name: /Updated tasks/ })
    expect(row.textContent).toBe("Updated tasks · 1/2 complete · 1 active")
    expect(row.querySelector("[data-lucide]")).toBeNull()
    // Text is the row's only child — nothing reserves an icon slot.
    expect(row.children).toHaveLength(1)
  })

  test("the planning state is text only too", () => {
    const view = render(createElement(TodoRow, { tool: todoTool({}, "streaming") }))
    const row = view.getByRole("button", { name: /Planning tasks/ })
    expect(row.textContent).toBe("Planning tasks…")
    expect(row.querySelector("[data-lucide]")).toBeNull()
    expect(row.children).toHaveLength(1)
  })

  test("pressing it opens the dock's Tasks panel", () => {
    const view = render(createElement(TodoRow, { tool: todoTool() }))
    view.getByRole("button", { name: /Updated tasks/ }).click()
    expect(openPanel).toHaveBeenCalledWith("checklist")
  })

  test("on phone the row is not tappable (the checklist is in the Worked sheet)", () => {
    phoneState.current = true
    const view = render(createElement(TodoRow, { tool: todoTool() }))
    const row = view.getByText(/Updated tasks/).closest("button")!
    expect(row).toBeTruthy()
    expect((row as HTMLButtonElement).disabled).toBe(true)
    row.click()
    expect(openPanel).not.toHaveBeenCalled()
  })
})
