// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The queue collection mutates `all` in place. The hook must surface rows
 * added after the first render (enqueue, poll, reload) — a memo keyed only on
 * the collection identity kept the dock empty until the session changed.
 */
import { describe, expect, mock, test } from "bun:test"
import { act, render } from "@testing-library/react"
import * as React from "react"
import { observable, runInAction } from "mobx"
import { observer } from "mobx-react-lite"

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
  delete: async (id: string) => {
    runInAction(() => {
      const index = collection.all.findIndex((r) => r.id === id)
      if (index !== -1) collection.all.splice(index, 1)
    })
  },
})

mock.module("@shogo/shared-app/domain", () => ({
  useSDKDomains: () => ({ studioChat: { chatQueuedMessageCollection: collection } }),
}))
mock.module("mobx-state-tree", () => ({ getEnv: () => ({ http: { post: async () => ({ data: { ok: true } }) } }) }))

const { useServerMessageQueue } = await import("../useServerMessageQueue")

const turns: Array<{ id: string; text: string } | undefined> = []
let queueApi: ReturnType<typeof useServerMessageQueue> | null = null

const Probe = observer(function Probe({ isStreaming = true }: { isStreaming?: boolean }) {
  const queue = useServerMessageQueue({
    sessionId: "s1",
    enabled: true,
    isStreaming,
    onTurnAvailable: (message) =>
      turns.push(message ? { id: message.id, text: (message.parts[0] as { text: string }).text } : undefined),
  })
  queueApi = queue
  return <ul>{queue.queuedMessages.map((m) => <li key={m.id}>{m.content}</li>)}</ul>
})

function row(id: string, position: number, content: string, sessionId = "s1"): Row {
  return { id, sessionId, position, status: "pending", content, createdAt: position, updatedAt: position }
}

function reset() {
  turns.length = 0
  act(() => runInAction(() => { collection.all.splice(0, collection.all.length) }))
}

describe("useServerMessageQueue", () => {
  test("shows rows added after mount and follows reorders", () => {
    const view = render(<Probe />)
    expect(view.queryAllByRole("listitem")).toHaveLength(0)

    act(() => runInAction(() => {
      collection.all.push(row("a", 0, "first"), row("b", 1, "second"), row("x", 0, "other session", "s2"))
    }))
    expect(view.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["first", "second"])

    act(() => runInAction(() => {
      collection.all[0]!.position = 1
      collection.all[1]!.position = 0
    }))
    expect(view.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["second", "first"])
  })

  test("tells the window which message the server started when the head leaves the queue", () => {
    reset()
    render(<Probe isStreaming={false} />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    expect(turns).toEqual([])

    act(() => runInAction(() => { collection.all.splice(0, 1) })) // the server took q1
    expect(turns).toEqual([{ id: "q1", text: "first" }])

    act(() => runInAction(() => { collection.all.splice(0, 1) })) // then q2
    expect(turns).toEqual([{ id: "q1", text: "first" }, { id: "q2", text: "second" }])
  })

  test("send now on a later row the server takes before the reload still starts the turn", () => {
    reset()
    render(<Probe isStreaming={false} />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))

    // The server moved q2 to the front, dispatched and deleted it before the
    // client saw the new order.
    act(() => runInAction(() => { collection.all.splice(1, 1) }))
    expect(turns).toEqual([{ id: "q2", text: "second" }])
  })

  test("a row the user deletes is not a turn starting", async () => {
    reset()
    render(<Probe isStreaming={false} />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))

    await act(async () => { await queueApi!.remove("q2") })
    await act(async () => { await queueApi!.remove("q1") })
    expect(turns).toEqual([])
  })

  test("a turn taken while the previous stream is still open is reported once it closes", () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))

    act(() => runInAction(() => { collection.all.splice(1, 1) }))
    expect(turns).toEqual([])

    view.rerender(<Probe isStreaming={false} />)
    expect(turns).toEqual([{ id: "q2", text: "second" }])

    view.rerender(<Probe isStreaming />)
    view.rerender(<Probe isStreaming={false} />)
    expect(turns).toEqual([{ id: "q2", text: "second" }])
  })

  test("swapping an optimistic row for the saved one is not a turn starting", () => {
    reset()
    render(<Probe />)
    act(() => runInAction(() => { collection.all.push(row("temp-123", 0, "hi")) }))
    act(() => runInAction(() => { collection.all.splice(0, 1, row("real-1", 0, "hi")) }))
    expect(turns).toEqual([])
  })
})
