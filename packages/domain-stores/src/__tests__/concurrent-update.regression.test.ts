// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for Sentry REACT-3A / REACT-43: "Error: Update already in
 * progress" surfacing as an UNHANDLED promise rejection from the generated
 * collection `update` flow (culprit
 * `flow$argument_0(packages/domain-stores/src/project.collection)` and the same
 * flow in `chat-session.collection`).
 *
 * Root cause: `update` threw `new Error("Update already in progress")` when a
 * second update for the same id started while the first was still in flight.
 * Optimistic-UI callers fire these writes without awaiting/catching the
 * returned promise (e.g. a rename that double-fires from a rapid re-render or a
 * PATCH retry), so the throw became an unhandled rejection that reached
 * `onunhandledrejection` and Sentry.
 *
 * `delete` never had this problem because it no-ops on concurrency
 * (`if (pendingDeletes.has(id)) return`). The fix makes `update` symmetric:
 * a concurrent update coalesces to a no-op that returns the current node,
 * letting the in-flight PATCH win instead of throwing.
 */
import { test, expect } from "bun:test"
import { isAlive } from "mobx-state-tree"
import { ProjectCollection } from "../project.collection"
import { ChatSessionCollection } from "../chat-session.collection"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeProjectCollection(patchImpl: () => Promise<unknown>) {
  const env = {
    http: {
      get: async () => ({ data: { ok: true } }),
      post: async () => ({ data: { ok: true } }),
      patch: patchImpl,
      delete: async () => ({ data: { ok: true } }),
    },
  }
  return ProjectCollection.create(
    { items: { p1: { id: "p1", name: "Project", workspaceId: "w1", updatedAt: 1 } as never } },
    env as never,
  )
}

test("concurrent update() does NOT throw/reject — it coalesces to a no-op", async () => {
  const patch = deferred<unknown>()
  const collection = makeProjectCollection(() => patch.promise)
  const existing = collection.items.get("p1")!

  // First update suspends at the awaited PATCH with pendingUpdates.set(p1).
  const first = collection.update("p1", { name: "first" })

  // Second update for the SAME id while the first is in flight. Pre-fix this
  // synchronously threw inside the flow → the returned promise rejected with
  // "Update already in progress"; unawaited by optimistic callers, that became
  // an unhandled rejection in production.
  const second = collection.update("p1", { name: "second" })

  // Must resolve (no rejection), returning the still-live current node.
  const secondResult = await second
  expect(secondResult).toBeDefined()
  expect(isAlive(existing)).toBe(true)

  // Let the in-flight PATCH complete so the first update settles cleanly.
  patch.resolve({
    data: { ok: true, data: { id: "p1", name: "first", workspaceId: "w1", updatedAt: 2 } },
  })
  await first
})

test("chat-session collection has the same coalescing behavior", async () => {
  const patch = deferred<unknown>()
  const env = {
    http: {
      get: async () => ({ data: { ok: true } }),
      post: async () => ({ data: { ok: true } }),
      patch: () => patch.promise,
      delete: async () => ({ data: { ok: true } }),
    },
  }
  const collection = ChatSessionCollection.create(
    { items: { s1: { id: "s1", inferredName: "session", contextType: "general" } as never } },
    env as never,
  )

  const first = collection.update("s1", { inferredName: "a" })
  const second = collection.update("s1", { inferredName: "b" })

  await expect(second).resolves.toBeDefined()

  patch.resolve({ data: { ok: true, data: { id: "s1", inferredName: "a", contextType: "general" } } })
  await first
})
