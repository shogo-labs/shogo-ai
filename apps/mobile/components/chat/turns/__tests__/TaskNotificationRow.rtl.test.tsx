// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A finished background task in the transcript is a way in, not a dead end:
 * pressing it opens that task's thread in the side window when the chat offers
 * one (SHO-27), and falls back to the inline log when it does not.
 */

import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import { ChatContextProvider, type OpenTaskHint } from "../../ChatContext"
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

const { TaskNotificationRow } = await import("../TaskNotificationRow")

function notification(title = "@Ops reply", detail?: string) {
  return {
    taskIds: ["t_reply001"],
    updates: [{ taskId: "t_reply001", title, outcome: "completed", ...(detail ? { detail } : {}) }],
  } as any
}

function withChat(openTaskThread: ((taskId: string, hint?: OpenTaskHint) => void) | undefined, children: any) {
  return createElement(ChatContextProvider, { value: { openTaskThread } as any }, children)
}

describe("TaskNotificationRow", () => {
  test("pressing the row asks the chat to open the task's thread", () => {
    const opened: Array<[string, OpenTaskHint | undefined]> = []
    const view = render(
      withChat((taskId, hint) => { opened.push([taskId, hint]) }, createElement(TaskNotificationRow, { notification: notification() })),
    )
    fireEvent.click(view.getByRole("button", { name: /@Ops reply/ }))
    expect(opened).toHaveLength(1)
    expect(opened[0]![0]).toBe("t_reply001")
    expect(opened[0]![1]).toMatchObject({ title: "@Ops reply" })
  })

  test("without a side window it still shows the log inline", () => {
    const view = render(createElement(TaskNotificationRow, { notification: notification("@Ops reply", "Refund issued.") }))
    expect(view.queryByText(/Refund issued/)).toBeNull()
    fireEvent.click(view.getByText("Log"))
    expect(view.getByText(/Refund issued/)).toBeTruthy()
    fireEvent.click(view.getByText("Hide"))
    expect(view.queryByText(/Refund issued/)).toBeNull()
  })

  test("a row with no detail is still openable when the chat has a side window", () => {
    const opened: string[] = []
    const view = render(
      withChat((taskId) => { opened.push(taskId) }, createElement(TaskNotificationRow, { notification: notification("bun test") })),
    )
    fireEvent.click(view.getByRole("button", { name: /bun test/ }))
    expect(opened).toEqual(["t_reply001"])
  })
})
