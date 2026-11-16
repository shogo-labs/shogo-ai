// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `workspace-chats-cache.ts` (SHO-391): per-user/per-origin/per-workspace keys,
 * the synchronous mirror, one fetch shared by every caller, and clearing on
 * sign-out.
 */

import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

const store = new Map<string, string>()
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: async (k: string) => {
      store.delete(k)
    },
    getAllKeys: async () => [...store.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => store.delete(k))
    },
  },
}))

type Row = { id: string; name?: string }

let served: (workspaceId: string) => Promise<Row[]> = async () => [{ id: "chat-1", name: "One" }]
const listWorkspaceSessions = mock(async (_http: unknown, workspaceId: string) =>
  served(workspaceId),
)
mock.module(resolve(import.meta.dir, "../api"), () => ({
  api: { listWorkspaceSessions },
}))

let cache: typeof import("../workspace-chats-cache")
beforeAll(async () => {
  cache = await import("../workspace-chats-cache")
})

const http = {} as never

beforeEach(() => {
  listWorkspaceSessions.mockClear()
  served = async () => [{ id: "chat-1", name: "One" }]
})

afterEach(async () => {
  await cache.clearWorkspaceChatsCache()
  store.clear()
})

const flushWrites = () => new Promise((r) => setTimeout(r, 1_100))

describe("workspace chats cache key", () => {
  test("is scoped by user, origin and workspace — and refuses to be unscoped", () => {
    expect(cache.workspaceChatsKey("u1", "cloud", "w1")).toBe("u1:cloud:w1")
    // The same user on a paired computer is a different list.
    expect(cache.workspaceChatsKey("u1", "machine-7", "w1")).not.toBe(
      cache.workspaceChatsKey("u1", "cloud", "w1"),
    )
    expect(cache.workspaceChatsKey("u2", "cloud", "w1")).not.toBe(
      cache.workspaceChatsKey("u1", "cloud", "w1"),
    )
    expect(cache.workspaceChatsKey(null, "cloud", "w1")).toBeNull()
    expect(cache.workspaceChatsKey("u1", "cloud", null)).toBeNull()
  })
})

describe("workspace chats cache storage", () => {
  test("a write is readable synchronously, and survives a cold start", async () => {
    const key = "u1:cloud:w1"
    cache.writeWorkspaceChats(key, [{ id: "chat-1", name: "One" }])
    expect(cache.peekWorkspaceChats(key)?.map((row) => row.id)).toEqual(["chat-1"])

    await flushWrites()
    // A new JS session: the mirror is gone, the device still holds it.
    cache.resetWorkspaceChatsCacheState()
    expect(cache.peekWorkspaceChats(key)).toBeNull()
    expect((await cache.readWorkspaceChats(key))?.map((row) => row.id)).toEqual(["chat-1"])
    // …and that read repopulated the mirror, so the remount paints at once.
    expect(cache.peekWorkspaceChats(key)?.map((row) => row.id)).toEqual(["chat-1"])
  })

  test("one workspace's rows never answer for another's", async () => {
    cache.writeWorkspaceChats("u1:cloud:w1", [{ id: "chat-1" }])
    cache.writeWorkspaceChats("u1:cloud:w2", [{ id: "chat-9" }])
    await flushWrites()
    expect((await cache.readWorkspaceChats("u1:cloud:w2"))?.map((row) => row.id)).toEqual(["chat-9"])
    expect((await cache.readWorkspaceChats("u2:cloud:w1")) ?? null).toBeNull()
  })

  test("an empty list is dropped unless the caller says it is authoritative", async () => {
    const key = "u1:cloud:w1"
    cache.writeWorkspaceChats(key, [{ id: "chat-1" }])
    await flushWrites()
    // A failed load reaches here with []: the rows must stay.
    cache.writeWorkspaceChats(key, [])
    expect(cache.peekWorkspaceChats(key)?.map((row) => row.id)).toEqual(["chat-1"])
    // Every chat deleted for real: the empty answer is the truth.
    cache.writeWorkspaceChats(key, [], { allowEmpty: true })
    expect(cache.peekWorkspaceChats(key)).toEqual([])
  })

  test("keeps the last MAX_CACHED_WORKSPACES, newest used first", async () => {
    for (let i = 0; i < cache.MAX_CACHED_WORKSPACES + 2; i += 1) {
      cache.writeWorkspaceChats(`u1:cloud:w${i}`, [{ id: `chat-${i}` }])
    }
    await flushWrites()
    expect(cache.peekWorkspaceChats("u1:cloud:w0")).toBeNull()
    expect(await cache.readWorkspaceChats("u1:cloud:w1")).toBeNull()
    expect(
      await cache.readWorkspaceChats(`u1:cloud:w${cache.MAX_CACHED_WORKSPACES + 1}`),
    ).not.toBeNull()
  })

  test("sign-out clears every list and nothing else", async () => {
    cache.writeWorkspaceChats("u1:cloud:w1", [{ id: "chat-1" }])
    await flushWrites()
    store.set("unrelated", "keep")
    await cache.clearWorkspaceChatsCache()
    expect(cache.peekWorkspaceChats("u1:cloud:w1")).toBeNull()
    expect(await cache.readWorkspaceChats("u1:cloud:w1")).toBeNull()
    expect(store.get("unrelated")).toBe("keep")
  })
})

describe("workspace chats single-flight fetch", () => {
  test("three callers in the same moment spend one request and all get the rows", async () => {
    const key = "u1:cloud:w1"
    const answers = await Promise.all([
      cache.fetchWorkspaceChats(http, "w1", key),
      cache.fetchWorkspaceChats(http, "w1", key),
      cache.fetchWorkspaceChats(http, "w1", key),
    ])
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1)
    for (const rows of answers) expect(rows.map((row) => row.id)).toEqual(["chat-1"])
    // …and the answer is on the device, so the next mount paints it.
    expect(cache.peekWorkspaceChats(key)?.map((row) => row.id)).toEqual(["chat-1"])
  })

  test("a caller arriving just after one settled takes that answer", async () => {
    const key = "u1:cloud:w1"
    await cache.fetchWorkspaceChats(http, "w1", key)
    await cache.fetchWorkspaceChats(http, "w1", key)
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1)
  })

  test("`force` is a fresh network answer, but still joins a request in flight", async () => {
    const key = "u1:cloud:w1"
    await cache.fetchWorkspaceChats(http, "w1", key)
    await cache.fetchWorkspaceChats(http, "w1", key, { force: true })
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(2)

    // Two forced callers while one request is still open: one request.
    const rows = await Promise.all([
      cache.fetchWorkspaceChats(http, "w1", key, { force: true }),
      cache.fetchWorkspaceChats(http, "w1", key, { force: true }),
    ])
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(3)
    expect(rows[0]?.map((row) => row.id)).toEqual(["chat-1"])
  })

  test("a server that answers with nothing clears the cached rows", async () => {
    const key = "u1:cloud:w1"
    await cache.fetchWorkspaceChats(http, "w1", key)
    expect(cache.peekWorkspaceChats(key)).not.toBeNull()

    served = async () => []
    await cache.fetchWorkspaceChats(http, "w1", key, { force: true })
    expect(cache.peekWorkspaceChats(key)).toEqual([])
  })

  test("a failed fetch caches nothing and lets the next caller retry", async () => {
    const key = "u1:cloud:w1"
    served = async () => {
      throw new Error("offline")
    }
    await expect(cache.fetchWorkspaceChats(http, "w1", key)).rejects.toThrow("offline")
    expect(cache.peekWorkspaceChats(key)).toBeNull()

    served = async () => [{ id: "chat-2" }]
    const rows = await cache.fetchWorkspaceChats(http, "w1", key)
    expect(rows.map((row) => row.id)).toEqual(["chat-2"])
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(2)
  })

  test("an unscoped workspace still fetches, it just is not cached", async () => {
    const rows = await cache.fetchWorkspaceChats(http, "w1", null)
    expect(rows.map((row) => row.id)).toEqual(["chat-1"])
    expect(store.size).toBe(0)
  })
})
