// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A queued `task_notification` is the agent's own update, not something a person
 * typed: it never renders as a queued chat message. While a wake pause holds it
 * back it shows as one "N updates waiting" chip with a Resume, and the tasks
 * behind it read "waiting" in the dock rather than finished-and-unseen (SHO-88).
 */

import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) => (
      <button
        {...props}
        aria-label={accessibilityLabel}
        onClick={onPress}
        role={accessibilityRole}
        type="button"
      >
        {children}
      </button>
    ),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

const { chatQueuedMessages, waitingTaskWakes, WaitingWakes } = await import("../dock/panels/QueueDockPanel")
type QueuedMessage = import("../ChatInput").QueuedMessage

const wake = (id: string, firstLine: string, paused = true): QueuedMessage => ({
  id,
  content: `[Task update] ${firstLine} (t_${id}) completed.\nLast output: moved to QA & Review (review)`,
  kind: "task_wake",
  paused,
})

const typed: QueuedMessage = { id: "q1", content: "please rebase the branch" }

describe("waiting background updates", () => {
  test("a task wake is not a queued message, and only a paused one is waiting", () => {
    const queued = [typed, wake("a1", "SHO-88 Sim kernel"), wake("b2", "@Ops reply", false)]
    expect(waitingTaskWakes(queued).map((m) => m.id)).toEqual(["a1"])
    // Delivered-or-not, it is the agent's own update: never a message a person
    // typed, so never a row in the queue list.
    expect(chatQueuedMessages(queued).map((m) => m.id)).toEqual(["q1"])
  })

  test("the chip counts the updates and names them", () => {
    render(<WaitingWakes wakes={[wake("a1", "SHO-88 Sim kernel"), wake("b2", "@Ops reply")]} onResume={() => {}} />)
    expect(screen.getByText("2 background updates waiting")).toBeInTheDocument()
    expect(screen.getByText(/SHO-88 Sim kernel/)).toBeInTheDocument()
  })

  test("Resume hands back the newest paused wake, so the server can un-pause the run", () => {
    const resume = mock((id: string) => id)
    render(<WaitingWakes wakes={[wake("a1", "SHO-88 Sim kernel"), wake("b2", "@Ops reply")]} onResume={resume} />)
    fireEvent.click(screen.getByRole("button", { name: "Resume background updates" }))
    expect(resume).toHaveBeenCalledWith("b2")
  })
})
