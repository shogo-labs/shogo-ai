// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The session's queue dock holds two different queues: the messages typed here
 * (`ChatQueuedMessage`) and the team-chat messages waiting behind the reply
 * (`AgentWake`). The wakes get a row of their own — channel and author, then the
 * text — and they carry the wake routes, not the chat queue's (SHO-167).
 */

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { DockPanelDescriptor } from "../../../../../lib/chat-dock-store"
import { createReactNativeMock } from "../../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, children, onPress, disabled, ...props }: any) =>
      createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, disabled, onClick: () => onPress?.({ stopPropagation() {} }) },
        children,
      ),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

let descriptor: DockPanelDescriptor | null = null

mock.module(resolve(import.meta.dir, "../../useDockPanel"), () => ({
  useDockPanel: (d: DockPanelDescriptor | null) => {
    descriptor = d
  },
}))

const { QueueDockPanel } = await import("../QueueDockPanel")
type QueuedMessage = import("../../ChatInput").QueuedMessage

const wake = (id: string, text: string, channel = "eng"): QueuedMessage => ({
  id,
  content: text,
  kind: "agent_wake",
  source: `#${channel} · Ana Lopez`,
})

const typed: QueuedMessage = { id: "q1", content: "please rebase the branch" }

function panel(props: Partial<React.ComponentProps<typeof QueueDockPanel>>) {
  descriptor = null
  render(<QueueDockPanel queuedMessages={[]} {...props} />)
  return descriptor
}

function body() {
  const d = descriptor
  if (!d) throw new Error("no panel registered")
  return render(<>{d.render({ expanded: true })}</>)
}

describe("QueueDockPanel team-chat wakes", () => {
  test("a wake is a row of its own, counted with the queue", () => {
    const d = panel({ queuedMessages: [typed, wake("w1", "can you look at this?")] })
    expect(d?.summary).toBe("2 queued")

    const view = body()
    expect(view.getByText("#eng · Ana Lopez")).toBeInTheDocument()
    expect(view.getByText("can you look at this?")).toBeInTheDocument()
    expect(view.getByText("please rebase the branch")).toBeInTheDocument()
  })

  test("its buttons press the wake routes with the wake id", async () => {
    const sentNow: string[] = []
    const removed: string[] = []
    panel({
      queuedMessages: [wake("w1", "can you look at this?")],
      onSendAgentWakeNow: (id) => sentNow.push(id),
      onRemoveAgentWake: (id) => removed.push(id),
    })

    const view = body()
    fireEvent.click(view.getByRole("button", { name: "Send queued message now" }))
    await waitFor(() => expect(sentNow).toEqual(["w1"]))
    // Both buttons go quiet while the first press is in flight, so ✕ is a
    // separate press — the row never fires two wake actions at once.
    fireEvent.click(view.getByRole("button", { name: "Delete queued message" }))
    await waitFor(() => expect(removed).toEqual(["w1"]))
  })

  test("a refused Send now shows the server's reason on the row", async () => {
    const refused = Object.assign(new Error("Request failed with status code 409"), {
      response: { data: { error: { message: "That message is not waiting any more" } } },
    })
    panel({
      queuedMessages: [wake("w1", "can you look at this?")],
      onSendAgentWakeNow: async () => { throw refused },
    })

    const view = body()
    fireEvent.click(screen.getByRole("button", { name: "Send queued message now" }))
    await waitFor(() => expect(view.getByText("That message is not waiting any more")).toBeInTheDocument())
    // Still there to press: the wake was not started, so the row cannot hide.
    expect(view.getByText("can you look at this?")).toBeInTheDocument()
  })

  test("a wake with no actions wired renders its text and nothing to press", () => {
    panel({ queuedMessages: [wake("w1", "can you look at this?")] })

    const view = body()
    expect(view.getByText("can you look at this?")).toBeInTheDocument()
    expect(view.queryByRole("button", { name: "Send queued message now" })).toBeNull()
    expect(view.queryByRole("button", { name: "Delete queued message" })).toBeNull()
  })
})
