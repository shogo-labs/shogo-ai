// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * SHO-341: with several messages queued, Send now on one delivered more than one
 * of them. `activeTurnId` is only written once the runtime answers the internal
 * `/chat` POST, so the window between a claim and that write read as "idle" to
 * every other starter (drain tick, enqueue hook, turn-end drain, hand-off).
 *
 * The in-memory table keeps the real claim semantics (a conditional update on
 * `id + status`, one winner), and the mocked chat proxy holds its response so
 * the test sits inside the very window the bug lived in.
 */

type Row = {
  id: string
  sessionId: string
  userId: string
  content: string
  parts: string | null
  body: string
  kind: string | null
  status: "pending" | "dispatching" | "failed"
  position: number
  error: string | null
  createdAt: Date
  updatedAt: Date
}

const state = {
  rows: [] as Row[],
  activeTurnId: null as string | null,
  requests: [] as any[],
  persisted: [] as any[],
}

/** The chat proxy: a start is in flight until the test lets it answer. */
const proxy = {
  entered: 0,
  holding: false,
  releases: [] as Array<() => void>,
  async hold() {
    this.entered++
    if (!this.holding) return
    await new Promise<void>((resolve) => this.releases.push(resolve))
  },
  open() {
    this.holding = false
    for (const release of this.releases.splice(0)) release()
  },
  reset() {
    this.open()
    this.entered = 0
  },
}

async function untilEntered(count: number) {
  for (let attempt = 0; attempt < 200 && proxy.entered < count; attempt++) {
    await Bun.sleep(1)
  }
  if (proxy.entered < count) throw new Error(`expected ${count} dispatches, saw ${proxy.entered}`)
}

function row(id: string, position: number, createdAt: Date): Row {
  return {
    id,
    sessionId: "session-1",
    userId: "user-1",
    content: `prompt ${id}`,
    parts: JSON.stringify([{ type: "text", text: `prompt ${id}` }]),
    body: JSON.stringify({ agentMode: "auto", text: `prompt ${id}` }),
    kind: null,
    status: "pending",
    position,
    error: null,
    createdAt,
    updatedAt: createdAt,
  }
}

function matches(target: Row, where: any): boolean {
  if (!where) return true
  for (const [key, expected] of Object.entries(where)) {
    const actual = (target as any)[key]
    if (expected instanceof Date) {
      if (actual?.getTime?.() !== expected.getTime()) return false
      continue
    }
    if (expected && typeof expected === "object") {
      const filter = expected as any
      if (filter.in && !filter.in.includes(actual)) return false
      if (filter.notIn && filter.notIn.includes(actual)) return false
      if (filter.not !== undefined && actual === filter.not) return false
      if (filter.gte && !(actual >= filter.gte)) return false
      if (filter.lt && !(actual < filter.lt)) return false
    } else if (actual !== expected) {
      return false
    }
  }
  return true
}

const mockPrisma = {
  chatSession: {
    findUnique: async () => ({
      id: "session-1",
      contextType: "project",
      contextId: "project-1",
      workspaceId: null,
      activeTurnId: state.activeTurnId,
      activeTurnHeartbeatAt: null,
    }),
    findMany: async () => [{ id: "session-1", workspaceId: null, project: null }],
    count: async () => 1,
    update: async () => ({}),
  },
  workspace: { findMany: async () => [] },
  chatQueuedMessage: {
    findFirst: async ({ where }: any = {}) => {
      const hit = state.rows
        .filter((candidate) => matches(candidate, where))
        .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())[0]
      return hit ? { ...hit } : null
    },
    findMany: async ({ where }: any = {}) =>
      state.rows.filter((candidate) => matches(candidate, where)).map((candidate) => ({ ...candidate })),
    updateMany: async ({ where, data }: any) => {
      const hits = state.rows.filter((candidate) => matches(candidate, where))
      for (const hit of hits) Object.assign(hit, data, { updatedAt: new Date() })
      return { count: hits.length }
    },
    update: async ({ where, data }: any) => {
      const hit = state.rows.find((candidate) => candidate.id === where.id)
      if (hit) Object.assign(hit, data, { updatedAt: new Date() })
      return hit
    },
    delete: async ({ where }: any) => {
      state.rows = state.rows.filter((candidate) => !matches(candidate, where))
      return {}
    },
    deleteMany: async ({ where }: any = {}) => {
      const before = state.rows.length
      state.rows = state.rows.filter((candidate) => !matches(candidate, where))
      return { count: before - state.rows.length }
    },
  },
  chatMessage: {
    upsert: async ({ create }: any) => {
      state.persisted.push(create)
      return create
    },
    findMany: async () => [],
  },
}

mock.module("../../lib/prisma", () => ({ prisma: mockPrisma }))
mock.module("../../lib/runtime", () => ({ getRuntimeManager: () => ({}) }))
mock.module("../../routes/project-chat", () => ({
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      state.requests.push(JSON.parse(await request.text()))
      await proxy.hold()
      return new Response(null, { status: 200 })
    },
  }),
}))

const { dispatchNext, dispatchQueuedRow, resetStuckDispatching } = await import(
  "../chat-queue-dispatcher.service"
)

const started = () => state.requests.map((request) => request.messages[0].parts[0].text)
const queuedIds = () => state.rows.map((candidate) => candidate.id)

describe("one turn per session with several queued messages (SHO-341)", () => {
  beforeEach(() => {
    const t0 = new Date()
    state.rows = [row("q1", 0, t0), row("q2", 1, t0), row("q3", 2, t0)]
    state.activeTurnId = null
    state.requests = []
    state.persisted = []
    proxy.reset()
  })

  it("starts nothing while a claim is still dispatching, then moves on when it ends", async () => {
    proxy.holding = true

    const first = dispatchNext("session-1")
    await untilEntered(1)

    // The claim is in flight and `activeTurnId` is not written yet: this is the
    // window every other starter used to read as an idle session.
    expect(await dispatchNext("session-1")).toBe(false)
    expect(started()).toEqual(["prompt q1"])

    proxy.open()
    expect(await first).toBe(true)
    // The turn that ran ended without a marker left behind: the queue moves on,
    // one row at a time.
    expect(await dispatchNext("session-1")).toBe(true)
    expect(started()).toEqual(["prompt q1", "prompt q2"])
  })

  it("Send now on #2 starts exactly one turn, and #1/#3 stay queued in order", async () => {
    proxy.holding = true
    // The click promotes #2 to the head and stops the streaming turn, so the
    // session reads idle at the moment the claim is made.
    state.activeTurnId = null
    state.rows[1].position = -1

    const click = dispatchQueuedRow("session-1", "q2")
    await untilEntered(1)

    expect(await dispatchNext("session-1")).toBe(false)
    expect(await dispatchNext("session-1")).toBe(false)
    expect(started()).toEqual(["prompt q2"])

    proxy.open()
    expect(await click).toEqual({ started: true, rowId: "q2" })
    expect(queuedIds()).toEqual(["q1", "q3"])
    expect(state.rows.every((candidate) => candidate.status === "pending")).toBe(true)
  })

  it("Send now does not start beside a row another starter already claimed", async () => {
    proxy.holding = true

    const first = dispatchNext("session-1")
    await untilEntered(1)

    const outcome = await dispatchQueuedRow("session-1", "q3")
    expect(outcome.started).toBe(false)
    expect(started()).toEqual(["prompt q1"])
    expect(state.rows.find((candidate) => candidate.id === "q3")?.status).toBe("pending")

    proxy.open()
    expect(await first).toBe(true)
  })

  it("recovers a claim stuck past the cutoff instead of deadlocking the queue", async () => {
    state.rows[0].status = "dispatching"
    state.rows[0].updatedAt = new Date(Date.now() - 5 * 60 * 1000)

    await resetStuckDispatching()
    expect(await dispatchNext("session-1")).toBe(true)
    expect(started()).toEqual(["prompt q1"])
  })
})
