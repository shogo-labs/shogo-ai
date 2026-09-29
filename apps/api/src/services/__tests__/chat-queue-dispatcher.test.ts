// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, mock } from "bun:test"

const row = {
  id: "queued-1",
  sessionId: "session-1",
  userId: "user-1",
  content: "queued prompt",
  parts: JSON.stringify([{ type: "text", text: "queued prompt" }]),
  body: JSON.stringify({
    agentMode: "auto",
    interactionMode: "agent",
    text: "queued prompt",
  }),
  status: "pending",
  position: 0,
}

const state = {
  session: {
    id: "session-1",
    contextType: "project",
    contextId: "project-1",
    workspaceId: null,
  },
  row: { ...row },
  persisted: [] as unknown[],
  requests: [] as unknown[],
}

const mockPrisma = {
  chatSession: {
    findUnique: async () => ({
      ...state.session,
      activeTurnId: null,
      activeTurnHeartbeatAt: null,
    }),
    update: async () => state.session,
  },
  chatQueuedMessage: {
    findFirst: async () =>
      state.row.status === "pending" ? { ...state.row } : null,
    updateMany: async ({ data }: any) => {
      if (state.row.status !== "pending") return { count: 0 }
      state.row.status = data.status
      return { count: 1 }
    },
    delete: async () => {
      state.row.status = "deleted"
    },
    update: async () => state.row,
    findMany: async () => [],
  },
  chatMessage: {
    upsert: async ({ create }: any) => {
      state.persisted.push(create)
      return create
    },
  },
}

mock.module("../../lib/prisma", () => ({ prisma: mockPrisma }))
mock.module("../../lib/runtime", () => ({
  getRuntimeManager: () => ({}),
}))
mock.module("../../routes/project-chat", () => ({
  projectChatRoutes: () => ({
    fetch: async (request: Request) => {
      state.requests.push(JSON.parse(await request.text()))
      return new Response(null, { status: 200 })
    },
  }),
}))

const { dispatchNext } = await import("../chat-queue-dispatcher.service")

describe("chat queue dispatcher", () => {
  it("claims and dispatches one queued row, persisting the user message", async () => {
    state.row.status = "pending"
    state.persisted.length = 0
    state.requests.length = 0

    expect(await dispatchNext("session-1")).toBe(true)
    expect(state.persisted).toHaveLength(1)
    expect((state.persisted[0] as any).id).toBe("queued-1")
    expect(state.requests).toHaveLength(1)
    expect((state.requests[0] as any).messages[0].parts[0].text).toBe("queued prompt")
    expect((state.requests[0] as any).clientTurnId).toMatch(/^queue-queued-1-/)
  })

  it("lets the database claim prevent duplicate concurrent dispatches", async () => {
    state.row.status = "pending"
    state.persisted.length = 0
    state.requests.length = 0

    const results = await Promise.all([
      dispatchNext("session-1"),
      dispatchNext("session-1"),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(state.requests).toHaveLength(1)
  })
})
