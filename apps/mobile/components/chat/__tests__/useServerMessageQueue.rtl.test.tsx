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
})

mock.module("@shogo/shared-app/domain", () => ({
  useSDKDomains: () => ({ studioChat: { chatQueuedMessageCollection: collection } }),
}))
mock.module("mobx-state-tree", () => ({ getEnv: () => ({ http: { post: async () => ({ data: { ok: true } }) } }) }))

const { useServerMessageQueue } = await import("../useServerMessageQueue")

const Probe = observer(function Probe() {
  const queue = useServerMessageQueue({ sessionId: "s1", enabled: true, isStreaming: true })
  return <ul>{queue.queuedMessages.map((m) => <li key={m.id}>{m.content}</li>)}</ul>
})

function row(id: string, position: number, content: string, sessionId = "s1"): Row {
  return { id, sessionId, position, status: "pending", content, createdAt: position, updatedAt: position }
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
})
