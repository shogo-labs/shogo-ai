// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, mock } from "bun:test"

const HOME = { OR: [{ homeRegion: "us-ashburn-1" }, { homeRegion: null }] }

const state = {
  homeSessionIds: new Set<string>(),
  claims: 0,
  persisted: 0,
  requests: 0,
  countWheres: [] as any[],
  findManyWheres: [] as any[],
  resetWheres: [] as any[],
}

const mockPrisma = {
  chatSession: {
    count: async ({ where }: any) => {
      state.countWheres.push(where)
      return state.homeSessionIds.has(where.id) ? 1 : 0
    },
    findUnique: async ({ where }: any) => ({
      id: where.id,
      contextType: "project",
      contextId: "project-1",
      workspaceId: null,
      activeTurnId: null,
      activeTurnHeartbeatAt: null,
    }),
    update: async () => ({}),
  },
  chatQueuedMessage: {
    findFirst: async ({ where }: any) => ({
      id: `queued-${where.sessionId}`,
      sessionId: where.sessionId,
      userId: "user-1",
      content: "queued prompt",
      parts: null,
      body: "{}",
    }),
    updateMany: async ({ where }: any) => {
      if (where.status === "dispatching" && where.updatedAt) {
        state.resetWheres.push(where)
        return { count: 0 }
      }
      state.claims++
      return { count: 1 }
    },
    delete: async () => ({}),
    findMany: async ({ where }: any) => {
      state.findManyWheres.push(where)
      return [{ sessionId: "home-session" }]
    },
  },
  chatMessage: {
    upsert: async ({ create }: any) => {
      state.persisted++
      return create
    },
  },
}

mock.module("../../lib/prisma", () => ({ prisma: mockPrisma }))
mock.module("../../lib/region", () => ({
  homeRegionWorkspaceWhere: () => HOME,
}))
mock.module("../../lib/runtime", () => ({
  getRuntimeManager: () => ({}),
}))
mock.module("../../routes/project-chat", () => ({
  projectChatRoutes: () => ({
    fetch: async () => {
      state.requests++
      return new Response(null, { status: 200 })
    },
  }),
}))

const { dispatchNext, dispatchPendingSessions, resetStuckDispatching } = await import(
  "../chat-queue-dispatcher.service"
)

const HOME_SESSION = { OR: [{ project: { workspace: HOME } }, { workspace: HOME }] }

describe("chat queue dispatcher in multi-region mode", () => {
  beforeEach(() => {
    state.homeSessionIds = new Set(["home-session"])
    state.claims = 0
    state.persisted = 0
    state.requests = 0
    state.countWheres = []
    state.findManyWheres = []
    state.resetWheres = []
  })

  it("does not claim, persist, or start a turn for a peer-homed session", async () => {
    expect(await dispatchNext("peer-session")).toBe(false)
    expect(state.countWheres[0]).toEqual({ id: "peer-session", ...HOME_SESSION })
    expect(state.claims).toBe(0)
    expect(state.persisted).toBe(0)
    expect(state.requests).toBe(0)
  })

  it("dispatches a session homed in this region", async () => {
    expect(await dispatchNext("home-session")).toBe(true)
    expect(state.claims).toBe(1)
    expect(state.persisted).toBe(1)
    expect(state.requests).toBe(1)
  })

  it("drains and resets only rows whose session is homed in this region", async () => {
    await resetStuckDispatching()
    expect(state.resetWheres[0].session).toEqual(HOME_SESSION)

    expect(await dispatchPendingSessions()).toBe(1)
    expect(state.findManyWheres[0]).toEqual({ status: "pending", session: HOME_SESSION })
  })
})
