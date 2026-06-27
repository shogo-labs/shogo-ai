// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for the MST "use-after-detach" crash in the generated
 * collection `update` flow.
 *
 * Root cause: `update` captured `existing = self.items.get(id)` BEFORE awaiting
 * the PATCH, then called `applySnapshot(existing, …)` AFTER. If the node was
 * removed/destroyed while the request was in flight (navigation, a collection
 * reset, or a concurrent delete during a chat stream-error teardown), the
 * snapshot was applied to a dead node — throwing
 *   "Cannot read properties of undefined (reading 'mergeCache')"  (Sentry REACT-39)
 * and leaving an orphaned node that observers kept reading
 *   "…object that is no longer part of a state tree"
 * which fed the "Maximum update depth exceeded" render loop (Sentry REACT-3C).
 *
 * The fix re-resolves the node from the map after the await and bails if it is
 * detached or replaced. We exercise that here against ChatSessionCollection
 * (the collection REACT-39 was reported on); the flow is identical across all
 * generated collections.
 */
import { test, expect } from "bun:test"
import { applySnapshot, getSnapshot, isAlive, unprotect } from "mobx-state-tree"
import { ChatSessionCollection } from "../chat-session.collection"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const baseItem = { id: "s1", inferredName: "session", contextType: "general" as const }

function makeCollection(patchImpl: () => Promise<unknown>) {
  const env = {
    http: {
      get: async () => ({ data: { ok: true } }),
      post: async () => ({ data: { ok: true } }),
      patch: patchImpl,
      delete: async () => ({ data: { ok: true } }),
    },
  }
  return ChatSessionCollection.create({ items: { s1: { ...baseItem } } }, env as never)
}

test("update() resolves without crashing when the node is detached mid-PATCH", async () => {
  const patch = deferred<unknown>()
  const collection = makeCollection(() => patch.promise)
  const existing = collection.items.get("s1")!

  // Start the optimistic update — the flow runs synchronously up to the
  // awaited PATCH, then suspends with `existing` captured.
  const updating = collection.update("s1", { name: "renamed" })
  expect(isAlive(existing)).toBe(true)

  // Simulate a teardown racing the in-flight request: the node is removed
  // from the tree (navigation / reset / concurrent delete), detaching it.
  unprotect(collection)
  collection.items.delete("s1")
  expect(isAlive(existing)).toBe(false)

  // Server responds after detachment. Pre-fix this reached
  // `applySnapshot(<dead node>, …)` and threw the mergeCache TypeError.
  patch.resolve({ data: { ok: true, data: { ...baseItem, name: "renamed" } } })

  // Must NOT throw, and must report the node is gone (undefined).
  const result = await updating
  expect(result).toBeUndefined()
})

test("applySnapshot on a detached node throws (documents the pre-fix failure mode)", () => {
  const collection = makeCollection(async () => ({ data: { ok: true, data: baseItem } }))
  const existing = collection.items.get("s1")!
  const snapshot = getSnapshot(existing)

  unprotect(collection)
  collection.items.delete("s1")
  expect(isAlive(existing)).toBe(false)

  // This is exactly the unguarded call the `update` flow used to make.
  expect(() => applySnapshot(existing, snapshot)).toThrow()
})
