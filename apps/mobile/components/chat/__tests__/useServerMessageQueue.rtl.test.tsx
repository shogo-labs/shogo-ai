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

let serverSeq = 0
let dispatchedBeforeObserved = false

const collection = observable({
  all: [] as Row[],
  loadAll: async () => {},
  delete: async (id: string) => {
    runInAction(() => {
      const index = collection.all.findIndex((r) => r.id === id)
      if (index !== -1) collection.all.splice(index, 1)
    })
  },
  create: async (input: Partial<Row>) => {
    const created: Row = {
      id: `srv-${++serverSeq}`,
      sessionId: String(input.sessionId),
      position: collection.all.length,
      status: "pending",
      content: String(input.content ?? ""),
      parts: input.parts,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    // `dispatchedBeforeObserved` models the row the server takes and deletes
    // before any render ever carried it.
    if (!dispatchedBeforeObserved) {
      runInAction(() => { collection.all.push(created) })
    }
    return created
  },
})

mock.module("@shogo/shared-app/domain", () => ({
  useSDKDomains: () => ({ studioChat: { chatQueuedMessageCollection: collection } }),
}))
mock.module("mobx-state-tree", () => ({ getEnv: () => ({ http: { post: async () => ({ data: { ok: true } }) } }) }))

const { useServerMessageQueue } = await import("../useServerMessageQueue")

const turns: Array<{ id: string; text: string } | undefined> = []
let queueApi: ReturnType<typeof useServerMessageQueue> | null = null
let pendingIds: string[] = []

const Probe = observer(function Probe({ isStreaming = true }: { isStreaming?: boolean }) {
  const queue = useServerMessageQueue({
    sessionId: "s1",
    enabled: true,
    isStreaming,
    onTurnAvailable: (message) =>
      turns.push(message ? { id: message.id, text: (message.parts[0] as { text: string }).text } : undefined),
  })
  queueApi = queue
  pendingIds = queue.pendingUserMessages.map((m) => m.id)
  return <ul>{queue.queuedMessages.map((m) => <li key={m.id}>{m.content}</li>)}</ul>
})

function row(id: string, position: number, content: string, sessionId = "s1"): Row {
  return { id, sessionId, position, status: "pending", content, createdAt: position, updatedAt: position }
}

function reset() {
  turns.length = 0
  pendingIds = []
  dispatchedBeforeObserved = false
  serverSeq = 0
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

  test("a dispatched head keeps its bubble until the panel can attach it", () => {
    reset()
    // A turn is streaming, so the hook holds the dispatch until the stream
    // closes: the row is already gone from the queue, and the transcript must
    // not lose the bubble in that gap.
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    expect(pendingIds).toEqual(["q1", "q2"])

    act(() => runInAction(() => { collection.all.splice(0, 1) })) // the server took q1
    expect(turns).toEqual([]) // not attached yet — the previous stream is open
    expect(pendingIds).toEqual(["q1", "q2"])

    view.rerender(<Probe isStreaming={false} />)
    expect(turns).toEqual([{ id: "q1", text: "first" }])
    // q1 is the panel's now; the one still queued keeps its bubble.
    expect(pendingIds).toEqual(["q2"])
  })

  test("a row the user deletes is not a turn starting", async () => {
    reset()
    render(<Probe isStreaming={false} />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))

    await act(async () => { await queueApi!.remove("q2") })
    await act(async () => { await queueApi!.remove("q1") })
    expect(turns).toEqual([])
  })

  test("deleting a row this window enqueued is not a turn starting", async () => {
    reset()
    render(<Probe isStreaming={false} />)

    await act(async () => {
      await queueApi!.enqueue({ content: "queued", body: { text: "queued" } })
    })
    expect(turns).toEqual([])

    // The trash button and "edit queued message" both call `remove`, which
    // deletes the row — the same disappearance as a dispatch.
    const id = collection.all[0]!.id
    await act(async () => { await queueApi!.remove(id) })
    expect(turns).toEqual([])

    // And it must not be reported later by the poll either.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
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

  test("a row dispatched between two polls still reports its user message", async () => {
    reset()
    // The row is created and taken by the server before any render carries it:
    // the disappeared-row diff never sees it, so the enqueue's own id must.
    dispatchedBeforeObserved = true
    render(<Probe isStreaming={false} />)

    await act(async () => {
      await queueApi!.enqueue({ content: "sent after stop", body: { text: "sent after stop" } })
    })
    expect(turns).toEqual([])

    // The hook keeps looking while a row of its own is unaccounted for.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(turns).toEqual([{ id: "srv-1", text: "sent after stop" }])
  })

  test("a row that disappears after being seen still reports once", async () => {
    reset()
    render(<Probe isStreaming={false} />)

    await act(async () => {
      await queueApi!.enqueue({ content: "queued", body: { text: "queued" } })
    })
    expect(turns).toEqual([])

    // The server takes it: the same turn must not be reported a second time by
    // the enqueue-side check.
    act(() => runInAction(() => { collection.all.splice(0, 1) }))
    expect(turns).toEqual([{ id: "srv-1", text: "queued" }])

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(turns).toEqual([{ id: "srv-1", text: "queued" }])
  })
})
