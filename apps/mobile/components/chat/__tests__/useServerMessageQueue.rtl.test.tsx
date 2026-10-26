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
  update: async (id: string, changes: Partial<Row>) => {
    runInAction(() => {
      const row = collection.all.find((r) => r.id === id)
      if (row) Object.assign(row, changes, { updatedAt: Date.now() })
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
let postResponse: { data?: any } = { data: { ok: true } }
/** Wakes waiting behind this session, as `/api/agent-wakes` lists them. */
let wakeList: any[] = []
const wakeCalls: string[] = []
const wakeDeletes: string[] = []
let sendWakeFailure: Error | null = null
/** When set, the Send-now POST hangs on it so a test can look at the in-flight dock. */
let sendWakeHold: Promise<void> | null = null
mock.module("mobx-state-tree", () => ({
  getEnv: () => ({
    http: {
      post: async (url: string) => {
        if (url.startsWith("/api/agent-wakes/") && url.endsWith("/send-now")) {
          wakeCalls.push(url)
          if (sendWakeHold) await sendWakeHold
          if (sendWakeFailure) throw sendWakeFailure
          return { data: { ok: true } }
        }
        return postResponse
      },
      get: async (url: string) => {
        wakeCalls.push(url)
        return { data: { wakes: wakeList } }
      },
      delete: async (url: string) => {
        wakeDeletes.push(url)
        return { data: { ok: true } }
      },
    },
  }),
}))

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
  postResponse = { data: { ok: true } }
  wakeList = []
  wakeCalls.length = 0
  wakeDeletes.length = 0
  sendWakeFailure = null
  sendWakeHold = null
  act(() => runInAction(() => { collection.all.splice(0, collection.all.length) }))
}

const dockText = (view: ReturnType<typeof render>) =>
  view.queryAllByRole("listitem").map((li) => li.textContent)

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

  test("only the dispatched head is pending — a queued row is dock-only", () => {
    reset()
    // A turn is streaming, so the hook holds the dispatch until the stream
    // closes. While both rows are still queued nothing belongs to the
    // transcript; once the server takes q1 it is painted from the dispatch
    // until the panel attaches, so its bubble never blinks out.
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    expect(pendingIds).toEqual([])

    act(() => runInAction(() => { collection.all.splice(0, 1) })) // the server took q1
    expect(turns).toEqual([]) // not attached yet — the previous stream is open
    expect(pendingIds).toEqual(["q1"])

    view.rerender(<Probe isStreaming={false} />)
    expect(turns).toEqual([{ id: "q1", text: "first" }])
    // q1 is the panel's now; q2 is still queued, so it is still dock-only.
    expect(pendingIds).toEqual([])
  })

  test("deleting, editing and reordering queued rows never puts them in the transcript", async () => {
    reset()
    render(<Probe isStreaming={false} />)
    act(() => runInAction(() => {
      collection.all.push(row("q1", 0, "first"), row("q2", 1, "second"), row("q3", 2, "third"))
    }))
    expect(pendingIds).toEqual([])

    await act(async () => { await queueApi!.reorder("q3", "up") })
    expect(pendingIds).toEqual([])

    await act(async () => { await queueApi!.update("q2", { content: "second, edited" }) })
    expect(pendingIds).toEqual([])

    await act(async () => { await queueApi!.remove("q1") })
    expect(pendingIds).toEqual([])
    expect(turns).toEqual([])
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

  /**
   * "Send now" is a POST the server answers before it has dispatched anything:
   * it stops the turn and fires `dispatchNext` without awaiting it, so the row
   * is still on the queue when the click's own reload lands. The dock has to
   * drop it on the click, and the row still has to reach the transcript exactly
   * once when the server does take it.
   */
  test("send now takes the row out of the dock before the server dispatches it", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    expect(dockText(view)).toEqual(["first", "second"])

    await act(async () => { await queueApi!.sendNow("q2") })
    expect(dockText(view)).toEqual(["first"])

    // Neither the click's reload nor the next poll has seen the delete yet.
    await act(async () => { await queueApi!.reload() })
    expect(dockText(view)).toEqual(["first"])
  })

  test("a row sent now reaches the transcript once and never returns to the dock", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    await act(async () => { await queueApi!.sendNow("q2") })
    expect(dockText(view)).toEqual(["first"])

    // The server started the turn and deleted the row while the previous
    // stream was still open.
    act(() => runInAction(() => { collection.all.splice(1, 1) }))
    expect(dockText(view)).toEqual(["first"])
    expect(pendingIds).toEqual(["q2"])

    view.rerender(<Probe isStreaming={false} />)
    expect(turns).toEqual([{ id: "q2", text: "second" }])
    expect(pendingIds).toEqual([])
    expect(dockText(view)).toEqual(["first"])

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(turns).toEqual([{ id: "q2", text: "second" }])
    expect(dockText(view)).toEqual(["first"])
  })

  test("a send now the server refuses puts the row back in the dock", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    postResponse = { data: { ok: false, error: { message: "Could not stop the turn" } } }

    let failure: unknown
    await act(async () => {
      try {
        await queueApi!.sendNow("q2")
      } catch (error) {
        failure = error
      }
    })
    expect(String(failure)).toContain("Could not stop the turn")
    expect(dockText(view)).toEqual(["first", "second"])

    // Nothing was sent, so nothing may be reported as its turn either.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(turns).toEqual([])
    expect(pendingIds).toEqual([])
  })

  test("a row whose dispatch fails comes back to the dock with its error", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    await act(async () => { await queueApi!.sendNow("q2") })
    expect(dockText(view)).toEqual(["first"])

    act(() => runInAction(() => {
      const failed = collection.all[1]!
      failed.status = "failed"
      failed.error = "Model refused"
      failed.updatedAt += 1
    }))
    expect(dockText(view)).toEqual(["first", "second"])
    expect(queueApi!.queuedMessages.find((m) => m.id === "q2")?.error).toBe("Model refused")
  })

  test("a row this window queued and then sent now reports one turn", async () => {
    reset()
    const view = render(<Probe isStreaming={false} />)
    await act(async () => {
      await queueApi!.enqueue({ content: "mine", body: { text: "mine" } })
    })
    await act(async () => { await queueApi!.sendNow("srv-1") })
    expect(dockText(view)).toEqual([])

    act(() => runInAction(() => { collection.all.splice(0, 1) }))
    expect(turns).toEqual([{ id: "srv-1", text: "mine" }])

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(turns).toEqual([{ id: "srv-1", text: "mine" }])
  })

  /**
   * SHO-205: the route dispatches the clicked row inside the POST, so a click
   * that could not start is answered with the reason (a failed dispatch is an
   * error answer, which is what the client throws). The row goes back in the
   * dock carrying that reason — the message is never hidden with no turn and no
   * explanation.
   */
  test("a failed answer puts the row back in the dock", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    postResponse = {
      data: {
        ok: false,
        status: "failed",
        error: { code: "dispatch_failed", message: "The runtime refused this message" },
        data: { id: "q2", status: "failed" },
      },
    }

    let failure: unknown
    await act(async () => {
      try {
        await queueApi!.sendNow("q2")
      } catch (error) {
        failure = error
      }
    })
    expect(String(failure)).toContain("The runtime refused this message")
    expect(dockText(view)).toEqual(["first", "second"])
    expect(turns).toEqual([])
    expect(pendingIds).toEqual([])
  })

  /**
   * The other half of SHO-205's client rule: a row the answer never claimed is
   * not rescued by counting polls. The click's own answer is the only thing
   * that reports a dispatch, so a `pending` row no longer means "three polls
   * and it is a refusal" — only the hide's safety timeout brings it back.
   */
  test("a row still pending is not put back by counting polls", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    await act(async () => { await queueApi!.sendNow("q2") })
    expect(dockText(view)).toEqual(["first"])

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5200)) })
    expect(dockText(view)).toEqual(["first"])
    expect(turns).toEqual([])
    expect(pendingIds).toEqual([])
    view.unmount()
  }, 15_000)

  test("a dispatch that claims the row is left alone while it runs", async () => {
    reset()
    const view = render(<Probe isStreaming />)
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "first"), row("q2", 1, "second")) }))
    await act(async () => { await queueApi!.sendNow("q2") })

    // `dispatching` is the server having taken it: slow is not refused.
    act(() => runInAction(() => { collection.all[1]!.status = "dispatching" }))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5200)) })
    expect(queueApi!.queuedMessages.map((m) => m.id)).toEqual(["q1"])
    view.unmount()
  }, 15_000)
})

/**
 * A team-chat message queued behind this session's turn is not a
 * `ChatQueuedMessage` row: `AgentWake` is its one queue, read from its own
 * route. The dock shows it after the session's own rows and presses the wake
 * routes, not the chat queue's.
 */
describe("team-chat wakes waiting behind this session", () => {
  const wake = (overrides: Record<string, unknown> = {}) => ({
    id: "w1",
    status: "pending",
    sendNowAt: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    conversationId: "c-eng",
    threadRootId: null,
    channelName: "eng",
    author: { name: "Ana Lopez" },
    text: "can you look at this?",
    ...overrides,
  })
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

  test("a queued team-chat message joins the dock after the session's own rows", async () => {
    reset()
    wakeList = [wake()]
    const view = render(<Probe isStreaming />)
    await settle()

    expect(wakeCalls).toContain("/api/agent-wakes?sessionId=s1")
    act(() => runInAction(() => { collection.all.push(row("q1", 0, "typed here")) }))

    // Typed here first, then the channel's message: the order the agent wakes them in.
    expect(queueApi!.queuedMessages.map((m) => [m.id, m.kind ?? "message"])).toEqual([
      ["q1", "message"],
      ["w1", "agent_wake"],
    ])
    expect(queueApi!.queuedMessages[1]!.source).toBe("#eng · Ana Lopez")
    expect(dockText(view)).toEqual(["typed here", "can you look at this?"])
  })

  test("Send now posts to the wake route and hides the row until the drain claims it", async () => {
    reset()
    wakeList = [wake()]
    render(<Probe isStreaming />)
    await settle()
    expect(queueApi!.queuedMessages.map((m) => m.id)).toEqual(["w1"])

    await act(async () => { await queueApi!.sendWakeNow("w1") })

    expect(wakeCalls).toContain("/api/agent-wakes/w1/send-now")
    // The server has not taken it off the list yet, so the hide is the click's,
    // not the next poll's.
    expect(queueApi!.queuedMessages).toEqual([])
  })

  test("a Send now the drain never claims brings the wake back to the dock", async () => {
    reset()
    wakeList = [wake()]
    render(<Probe isStreaming />)
    await settle()
    await act(async () => { await queueApi!.sendWakeNow("w1") })
    expect(queueApi!.queuedMessages).toEqual([])

    // The reply in front of it was stopped and nothing claims the wake: it is
    // still `pending` on every poll, so it has to be sendable again.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5200)) })
    expect(queueApi!.queuedMessages.map((m) => m.id)).toEqual(["w1"])
  }, 15_000)

  /**
   * SHO-198, the other side of the wait: a wake the drain *does* claim is a turn
   * now, not a queued message. It must not be put back in the dock by the same
   * counter that rescues one nobody claimed — that would send the agent the same
   * thread message twice.
   */
  test("a wake the drain claims leaves the dock and is never put back", async () => {
    reset()
    wakeList = [wake()]
    render(<Probe isStreaming />)
    await settle()
    await act(async () => { await queueApi!.sendWakeNow("w1") })
    expect(queueApi!.queuedMessages).toEqual([])

    // Claimed: the wake is gone from the pending list, so the dock's next polls
    // find nothing to wait for.
    wakeList = []
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5200)) })
    expect(queueApi!.queuedMessages).toEqual([])
    expect(pendingIds).toEqual([])
  }, 15_000)

  test("Send now keeps the row on screen until the server answers", async () => {
    reset()
    wakeList = [wake()]
    render(<Probe isStreaming />)
    await settle()

    // The POST is in flight: the row must still be the person's queued message,
    // or a refusal would land on an unmounted row and show nothing.
    let release!: () => void
    sendWakeHold = new Promise<void>((resolve) => { release = resolve })
    let pending!: Promise<void>
    act(() => { pending = queueApi!.sendWakeNow("w1") })
    expect(queueApi!.queuedMessages.map((m) => m.id)).toEqual(["w1"])

    await act(async () => { release(); await pending })
    // Taken by the server: now it goes off the dock.
    expect(queueApi!.queuedMessages).toEqual([])
  })

  test("a refused Send now raises and puts the row back", async () => {
    reset()
    wakeList = [wake()]
    render(<Probe isStreaming />)
    await settle()
    sendWakeFailure = new Error("Request failed with status code 409")

    let failure: unknown
    await act(async () => {
      try {
        await queueApi!.sendWakeNow("w1")
      } catch (error) {
        failure = error
      }
    })
    expect(String(failure)).toContain("409")
    expect(queueApi!.queuedMessages.map((m) => m.id)).toEqual(["w1"])
  })

  test("removing a wake deletes it by id and the queue reloads without it", async () => {
    reset()
    wakeList = [wake()]
    render(<Probe isStreaming />)
    await settle()

    await act(async () => { await queueApi!.removeWake("w1") })
    expect(wakeDeletes).toEqual(["/api/agent-wakes/w1"])

    wakeList = []
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)) })
    expect(queueApi!.queuedMessages).toEqual([])
  })
})

/**
 * QA round 1: the wake poll used to run on every open session, forever, with
 * nothing queued — ~40 GETs a minute and a DB query each. A wake only exists
 * while a reply is running in the thread, so the poll now runs only while the
 * session is streaming or a wake is actually waiting.
 */
describe("the wake poll idles", () => {
  const wakeCallCount = () =>
    wakeCalls.filter((url) => url.startsWith("/api/agent-wakes?")).length

  test("an idle session asks once on mount and then not again", async () => {
    reset()
    render(<Probe isStreaming={false} />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(wakeCallCount()).toBe(1)

    // Two poll intervals go by with nothing queued and nothing streaming.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3200)) })
    expect(wakeCallCount()).toBe(1)
  })

  test("it polls while the session is streaming", async () => {
    reset()
    render(<Probe isStreaming />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const afterMount = wakeCallCount()

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(wakeCallCount()).toBeGreaterThan(afterMount)
  })

  test("it polls while a wake is waiting, and stops once the list is empty", async () => {
    reset()
    wakeList = [{ id: "w1", status: "pending", sendNowAt: null, createdAt: new Date().toISOString(), conversationId: "c-eng", threadRootId: null, channelName: "eng", author: { name: "Ana Lopez" }, text: "look at this" }]
    render(<Probe isStreaming={false} />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const withWake = wakeCallCount()

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(wakeCallCount()).toBeGreaterThan(withWake)

    wakeList = []
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    const afterDrain = wakeCallCount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)) })
    expect(wakeCallCount()).toBe(afterDrain)
  }, 15_000)
})
