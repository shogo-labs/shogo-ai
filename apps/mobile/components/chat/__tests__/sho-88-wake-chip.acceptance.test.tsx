// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-88 acceptance, one level above the chip's own unit test: a
 * `task_notification` row arriving from the server must reach the composer as a
 * waiting chip, never as a queued message a person typed, and it must not turn
 * into a user bubble when the server takes it.
 */

import { describe, expect, mock, test } from "bun:test"
import { act, fireEvent, render, screen } from "@testing-library/react"
import * as React from "react"
import { observable, runInAction } from "mobx"
import { observer } from "mobx-react-lite"
import { createReactNativeMock } from "../../../test/react-native-mock"

type Row = {
  id: string
  sessionId: string
  position: number
  status: string
  content: string
  createdAt: number
  updatedAt: number
  parts?: string
  body?: string
  error?: string
}

const collection = observable({
  all: [] as Row[],
  loadAll: async () => {},
  delete: async () => {},
  update: async () => {},
  create: async () => ({}) as Row,
})

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) => (
      <button {...props} aria-label={accessibilityLabel} onClick={onPress} role={accessibilityRole} type="button">
        {children}
      </button>
    ),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("@shogo/shared-app/domain", () => ({
  useSDKDomains: () => ({ studioChat: { chatQueuedMessageCollection: collection } }),
}))
mock.module("mobx-state-tree", () => ({ getEnv: () => ({ http: { post: async () => ({ data: { ok: true } }) } }) }))

const { useServerMessageQueue } = await import("../useServerMessageQueue")
const { chatQueuedMessages, waitingTaskWakes, WaitingWakes } = await import("../dock/panels/QueueDockPanel")

const turns: Array<{ id: string; text: string } | undefined> = []
let queueApi: ReturnType<typeof useServerMessageQueue> | null = null

const Probe = observer(function Probe() {
  const queue = useServerMessageQueue({
    sessionId: "s1",
    enabled: true,
    isStreaming: false,
    onTurnAvailable: (message) =>
      turns.push(message ? { id: message.id, text: (message.parts[0] as { text: string }).text } : undefined),
  })
  queueApi = queue
  return null
})

const typedRow = (id: string, position: number, content: string): Row => ({
  id, sessionId: "s1", position, status: "pending", content, createdAt: position, updatedAt: position,
  body: JSON.stringify({ text: content }),
})

/** The row the dispatcher leaves behind when a wake is paused. */
const pausedWakeRow = (id: string, position: number, content: string): Row => ({
  id, sessionId: "s1", position, status: "failed", content, createdAt: position, updatedAt: position,
  error: "Paused: background tasks finished several times in a row without anyone writing. Send a message to continue.",
  parts: JSON.stringify([{ type: "text", text: content }, { type: "data-task-notification", data: { taskIds: ["t_ab12"] } }]),
  body: JSON.stringify({ text: content, taskNotification: { taskIds: ["t_ab12"], paused: true } }),
})

function reset() {
  turns.length = 0
  act(() => runInAction(() => { collection.all.splice(0, collection.all.length) }))
}

describe("SHO-88 · a paused wake reaches the composer as a chip", () => {
  test("the server row maps to a task wake, and the dock treats it as a waiting chip", () => {
    reset()
    render(<Probe />)
    act(() => runInAction(() => {
      collection.all.push(
        typedRow("q1", 0, "please rebase the branch"),
        pausedWakeRow("w1", 1, "[Task update] SHO-88 Sim kernel (t_ab12) completed."),
      )
    }))

    const queued = queueApi!.queuedMessages
    const wake = queued.find((m) => m.id === "w1")
    expect(wake).toMatchObject({ kind: "task_wake", paused: true })
    // The typed message is untouched by the mapping.
    expect(queued.find((m) => m.id === "q1")?.kind).toBeUndefined()

    // One chip, and the wake is not a row in the queue list.
    expect(waitingTaskWakes(queued).map((m) => m.id)).toEqual(["w1"])
    expect(chatQueuedMessages(queued).map((m) => m.id)).toEqual(["q1"])

    const resume = mock((id: string) => id)
    render(<WaitingWakes wakes={waitingTaskWakes(queued)} onResume={resume} />)
    expect(screen.getByText("1 background update waiting")).toBeInTheDocument()
    expect(screen.getByText(/Sim kernel/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume background updates" }))
    expect(resume).toHaveBeenCalledWith("w1")
  })

  test("a wake leaving the queue does not become a user bubble", () => {
    reset()
    render(<Probe />)
    act(() => runInAction(() => { collection.all.push(pausedWakeRow("w1", 0, "[Task update] x")) }))
    act(() => runInAction(() => { collection.all.splice(0, 1) })) // the server handed it over
    expect(turns).toEqual([])
  })
})
