// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Boards follow the workspace in view (SHO-108).
 *
 * `workBoardsApi()` used to build a bare `createHttpClient()`, which carries no
 * remote interceptor: every board, card, move, comment and thread read Shogo
 * Cloud even while one of a paired computer's own workspaces was open. It now
 * resolves the domain client — the interceptor's one insert point — so the same
 * calls answer from that machine.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { shouldRouteToRemote } from "../../../../packages/shared-app/src/services/remote-http-interceptor"

const calls: string[] = []

function record<T>(method: string) {
  return async (path: string) => {
    calls.push(`${method} ${path}`)
    return { data: {} as T }
  }
}

const recordingClient = {
  get: record("GET"),
  post: record("POST"),
  patch: record("PATCH"),
  put: record("PUT"),
  delete: record("DELETE"),
  request: record("REQUEST"),
}

mock.module("@shogo/shared-app/domain", () => ({
  getSDKHttpClient: () => recordingClient,
}))

// The bare client is what "reads the cloud" looked like. If the api builds one
// the test fails loudly instead of silently passing on cloud data.
mock.module(resolve(import.meta.dir, "..", "api"), () => ({
  API_URL: "http://localhost:3000",
  createHttpClient: () => {
    throw new Error("workBoardsApi() must use the domain client, not a bare createHttpClient()")
  },
}))

const { workBoardsApi } = await import("../work-boards-api")

/** Every path the api sends, minus the method. */
function paths(): string[] {
  return calls.map((call) => call.split(" ")[1])
}

beforeEach(() => {
  calls.length = 0
})

describe("SHO-108 — work boards read the workspace in view", () => {
  test("the board list and a board's view use the domain client", async () => {
    const api = workBoardsApi()
    await api.list("ws-cloud")
    await api.view("b1")

    expect(paths()).toEqual(["/api/workspaces/ws-cloud/boards?", "/api/boards/b1?"])
  })

  test("a card, its move, comments, history, follow and archive use the domain client", async () => {
    const api = workBoardsApi()
    await api.get("i1")
    await api.move("i1", { column: "Done" })
    await api.comment("i1", "landed")
    await api.history("i1", { filter: "all" })
    await api.follow("i1", true)
    await api.archiveItem("i1", true)

    expect(paths()).toEqual([
      "/api/work-items/i1",
      "/api/work-items/i1/move",
      "/api/work-items/i1/comments",
      "/api/work-items/i1/history?filter=all",
      "/api/work-items/i1/follow",
      "/api/work-items/i1/archive",
    ])
  })

  test("a card made from a message uses the domain client", async () => {
    const api = workBoardsApi()
    await api.cardFromMessage("m1", { boardId: "b1" })

    expect(paths()).toEqual(["/api/conversation-messages/m1/card"])
  })

  test("every one of those paths is machine-owned while a machine workspace is open", () => {
    const machine = { machineWorkspaceId: "lw-main" }
    for (const path of [
      "/api/boards/b1",
      "/api/boards/b1/items",
      "/api/work-items/i1",
      "/api/work-items/i1/move",
      "/api/work-items/i1/comments",
      "/api/work-items/i1/history",
      "/api/work-items/i1/follow",
      "/api/conversation-messages/m1/card",
      "/api/workspaces/ws-cloud/boards",
    ]) {
      expect(shouldRouteToRemote(path, machine)).toBe(true)
    }
  })
})
