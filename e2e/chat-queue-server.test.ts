// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Server-side chat queue E2E coverage.
 *
 * This intentionally uses the real SQLite Prisma client, generated CRUD
 * routes, queue hooks, and action routes. The active-turn fixture prevents
 * the afterCreate hook from starting a real model so the test is deterministic;
 * execution after turn completion is covered by the dispatcher integration
 * tests and the production turn-finally hooks.
 *
 * Run:
 *   SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db \
 *     bun test e2e/chat-queue-server.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Hono } from "hono"

process.env.SHOGO_LOCAL_MODE = "true"
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "file:./shogo.db"

const { prisma } = await import("../apps/api/src/lib/prisma")
const { chatQueuedMessageHooks } = await import(
  "../apps/api/src/generated/chat-queued-message.hooks"
)
const {
  createChatQueuedMessageRoutes,
  setPrisma: setPrismaChatQueuedMessage,
  setChatQueuedMessageHooks,
} = await import("../apps/api/src/generated/chat-queued-message.routes")
const { chatQueuedMessageActionsRoutes } = await import(
  "../apps/api/src/routes/chat-queued-message-actions"
)

const app = new Hono()
app.use("*", async (c, next) => {
  const authenticated = c.req.header("x-test-unauthenticated") !== "true"
  c.set("auth" as any, {
    isAuthenticated: authenticated,
    userId: authenticated ? c.req.header("x-test-user-id") : undefined,
    tunnelAuthenticated: false,
  })
  await next()
})

setPrismaChatQueuedMessage(prisma as any)
setChatQueuedMessageHooks(chatQueuedMessageHooks)
app.route("/api/chat-queued-messages", chatQueuedMessageActionsRoutes())
app.route("/api/chat-queued-messages", createChatQueuedMessageRoutes())

function request(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  userId?: string,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(userId ? { "x-test-user-id": userId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let workspaceId = ""
let userId = ""
let foreignUserId = ""
let memberId = ""
let projectId = ""
let sessionId = ""
let queueIds: string[] = []

describe("server-side chat queue", () => {
  beforeAll(async () => {
    const workspace = await prisma.workspace.findFirst()
    if (!workspace) throw new Error("No local workspace exists")
    workspaceId = workspace.id
    const stamp = Date.now()

    const user = await prisma.user.create({
      data: {
        email: `queue-e2e-${stamp}@test.local`,
        name: "Queue E2E User",
        role: "user",
      },
    })
    userId = user.id
    const member = await prisma.member.create({
      data: { userId, workspaceId, role: "member" },
    })
    memberId = member.id

    const foreignUser = await prisma.user.create({
      data: {
        email: `queue-e2e-foreign-${stamp}@test.local`,
        name: "Queue E2E Foreign User",
        role: "user",
      },
    })
    foreignUserId = foreignUser.id

    const project = await prisma.project.create({
      data: {
        name: `Queue E2E Project ${stamp}`,
        description: "Queue E2E fixture",
        workspaceId,
        createdBy: userId,
        tier: "starter",
        status: "draft",
        accessLevel: "anyone",
      },
    })
    projectId = project.id
    const session = await prisma.chatSession.create({
      data: {
        inferredName: "Queue E2E Session",
        contextType: "project",
        contextId: projectId,
        activeTurnId: `fixture-${stamp}`,
        activeTurnHeartbeatAt: new Date(),
        activeTurnStartedAt: new Date(),
      },
    })
    sessionId = session.id
  })

  afterAll(async () => {
    await prisma.chatQueuedMessage.deleteMany({ where: { sessionId } }).catch(() => {})
    await prisma.chatSession.delete({ where: { id: sessionId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
    await prisma.member.delete({ where: { id: memberId } }).catch(() => {})
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
    await prisma.user.delete({ where: { id: foreignUserId } }).catch(() => {})
  })

  it("persists, orders, edits, and deletes queued messages", async () => {
    const create = async (content: string) =>
      app.fetch(
        request(
          "/api/chat-queued-messages",
          "POST",
          {
            sessionId,
            userId: "attacker-controlled-value",
            position: -100,
            status: "failed",
            content,
            parts: JSON.stringify([{ type: "text", text: content }]),
            body: JSON.stringify({
              text: content,
              agentMode: "auto",
              interactionMode: "agent",
            }),
          },
          userId,
        ),
      )

    const firstResponse = await create("first")
    const secondResponse = await create("second")
    expect(firstResponse.status).toBe(201)
    expect(secondResponse.status).toBe(201)
    const first = (await firstResponse.json() as any).data
    const second = (await secondResponse.json() as any).data
    queueIds = [first.id, second.id]
    expect(first.userId).toBe(userId)
    expect(first.status).toBe("pending")
    expect(first.position).toBe(0)

    // A fresh request sees the same rows, which is the reload/device boundary
    // that the former module-level React cache could not survive.
    const listed = await app.fetch(
      request(`/api/chat-queued-messages?sessionId=${sessionId}`, "GET", undefined, userId),
    )
    expect(listed.status).toBe(200)
    expect((await listed.json() as any).items.map((row: any) => row.content)).toEqual([
      "first",
      "second",
    ])

    const edited = await app.fetch(
      request(`/api/chat-queued-messages/${first.id}`, "PATCH", { content: "edited" }, userId),
    )
    expect(edited.status).toBe(200)

    const reordered = await app.fetch(
      request(`/api/chat-queued-messages/${second.id}/reorder`, "POST", { direction: "up" }, userId),
    )
    expect(reordered.status).toBe(200)
    const reorderedList = await app.fetch(
      request(`/api/chat-queued-messages?sessionId=${sessionId}`, "GET", undefined, userId),
    )
    expect((await reorderedList.json() as any).items.map((row: any) => row.content)).toEqual([
      "second",
      "edited",
    ])

    const deleted = await app.fetch(
      request(`/api/chat-queued-messages/${first.id}`, "DELETE", undefined, userId),
    )
    expect(deleted.status).toBe(200)
    expect(await prisma.chatQueuedMessage.count({ where: { sessionId } })).toBe(1)
  })

  it("rejects foreign access and edits while dispatching", async () => {
    const row = await prisma.chatQueuedMessage.create({
      data: {
        sessionId,
        userId,
        position: 20,
        status: "dispatching",
        content: "busy",
        body: JSON.stringify({ text: "busy" }),
      },
    })
    queueIds.push(row.id)

    const foreignList = await app.fetch(
      request(`/api/chat-queued-messages?sessionId=${sessionId}`, "GET", undefined, foreignUserId),
    )
    // Generated CRUD routes normalize hook rejections to 400; the response
    // still carries the forbidden error code.
    expect(foreignList.status).toBe(403)
    expect((await foreignList.json() as any).error.code).toBe("forbidden")

    const busyPatch = await app.fetch(
      request(`/api/chat-queued-messages/${row.id}`, "PATCH", { content: "changed" }, userId),
    )
    expect(busyPatch.status).toBe(400)
    expect((await busyPatch.json() as any).error.code).toBe("busy")
  })
})
