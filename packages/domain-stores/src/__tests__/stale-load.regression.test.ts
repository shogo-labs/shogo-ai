// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for SHO-356: a list response that left before a local write
 * settled used to undo the write.
 *
 * The queue dock reloads every 1.5s while anything is queued. A DELETE or PATCH
 * that lands between the GET leaving and its response arriving was overwritten
 * by the older copy the server had already read — the deleted row came back,
 * and an optimistic edit reverted. `requestId` cannot catch this: the stale
 * response is still the *latest* load.
 *
 * The collection now remembers when each id's own write settled and refuses to
 * apply a response that predates it, while still letting a *later* load be
 * authoritative (no permanent tombstone).
 */
import { test, expect } from "bun:test"
import { ProjectCollection } from "../project.collection"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeCollection(handlers: {
  get: () => Promise<unknown>
  patch?: () => Promise<unknown>
  delete?: () => Promise<unknown>
}) {
  const env = {
    http: {
      get: handlers.get,
      post: async () => ({ data: { ok: true } }),
      patch: handlers.patch ?? (async () => ({ data: { ok: true } })),
      delete: handlers.delete ?? (async () => ({ data: { ok: true } })),
    },
  }
  return ProjectCollection.create(
    {
      items: {
        p1: { id: "p1", name: "Original", workspaceId: "w1", updatedAt: 1 } as never,
      },
    },
    env as never,
  )
}

test("a load that left before the delete landed does not resurrect the row", async () => {
  const list = deferred<unknown>()
  const collection = makeCollection({ get: () => list.promise })

  // The dock's poll leaves while the row is still queued.
  const loading = collection.loadAll()

  // The person deletes it, and that DELETE settles first.
  await collection.delete("p1")
  expect(collection.items.get("p1")).toBeUndefined()

  // The poll answers with the copy it read before the delete.
  list.resolve({
    data: {
      ok: true,
      items: [{ id: "p1", name: "Original", workspaceId: "w1", updatedAt: 1 }],
    },
  })
  await loading

  expect(collection.items.get("p1")).toBeUndefined()
})

test("a load that left before the edit landed does not revert it", async () => {
  const list = deferred<unknown>()
  const collection = makeCollection({
    get: () => list.promise,
    patch: async () => ({
      data: { ok: true, data: { id: "p1", name: "Edited", workspaceId: "w1", updatedAt: 2 } },
    }),
  })

  const loading = collection.loadAll()
  await collection.update("p1", { name: "Edited" })

  list.resolve({
    data: {
      ok: true,
      items: [{ id: "p1", name: "Original", workspaceId: "w1", updatedAt: 1 }],
    },
  })
  await loading

  expect(collection.items.get("p1")?.name).toBe("Edited")
})

test("a load that left before a create landed does not prune the new row", async () => {
  const list = deferred<unknown>()
  const env = {
    http: {
      get: () => list.promise,
      post: async () => ({
        data: {
          ok: true,
          data: { id: "p2", name: "New", workspaceId: "w1", updatedAt: 2 },
        },
      }),
      patch: async () => ({ data: { ok: true } }),
      delete: async () => ({ data: { ok: true } }),
    },
  }
  const created = ProjectCollection.create({ items: {} }, env as never)

  const loading = created.loadAll()
  await created.create({ name: "New", workspaceId: "w1" } as never)
  expect(created.items.get("p2")).toBeDefined()

  list.resolve({ data: { ok: true, items: [] } })
  await loading

  expect(created.items.get("p2")).toBeDefined()
})

test("a later load is still authoritative once the write has settled", async () => {
  let served = 0
  const collection = makeCollection({
    get: async () => {
      served += 1
      // First load: the row the stale poll saw. Second: the server's current copy.
      return served === 1
        ? {
            data: {
              ok: true,
              items: [{ id: "p1", name: "Original", workspaceId: "w1", updatedAt: 1 }],
            },
          }
        : {
            data: {
              ok: true,
              items: [{ id: "p1", name: "Renamed elsewhere", workspaceId: "w1", updatedAt: 3 }],
            },
          }
    },
    patch: async () => ({
      data: { ok: true, data: { id: "p1", name: "Edited", workspaceId: "w1", updatedAt: 2 } },
    }),
  })

  await collection.loadAll()
  await collection.update("p1", { name: "Edited" })
  expect(collection.items.get("p1")?.name).toBe("Edited")

  // A load issued after the edit settled belongs to nobody else: it lands.
  await collection.loadAll()
  expect(collection.items.get("p1")?.name).toBe("Renamed elsewhere")
})
