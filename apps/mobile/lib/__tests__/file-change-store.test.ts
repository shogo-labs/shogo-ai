// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `createFileChangeStore` — `getAll()` used to
 * `.map()` a brand-new array on every call regardless of whether any data
 * had changed, which broke memoization in every consumer (`ChangesDockPanel`
 * chief among them) and contributed to a production crash. See
 * `chat-dock-store.test.ts` for the other half of that story.
 */
import { describe, expect, test } from "bun:test"
import { createFileChangeStore } from "../file-change-store"

describe("createFileChangeStore getAll", () => {
  test("returns a stable array reference across calls when nothing changed", () => {
    const store = createFileChangeStore()
    store.registerChange("tool-1", "src/a.ts", "write")

    const first = store.getAll()
    const second = store.getAll()

    expect(first).toBe(second)
  })

  test("returns a new array reference after a real change", () => {
    const store = createFileChangeStore()
    store.registerChange("tool-1", "src/a.ts", "write")
    const first = store.getAll()

    store.registerChange("tool-2", "src/b.ts", "edit")
    const second = store.getAll()

    expect(second).not.toBe(first)
    expect(second).toHaveLength(2)
  })

  test("de-dupes repeated registrations for the same tool call + path + kind", () => {
    const store = createFileChangeStore()
    store.registerChange("tool-1", "src/a.ts", "write")
    store.registerChange("tool-1", "src/a.ts", "write")
    store.registerChange("tool-1", "src/a.ts", "write")

    expect(store.getAll()).toHaveLength(1)
    expect(store.getVersion()).toBe(1)
  })

  test("clear resets state and invalidates the cached snapshot", () => {
    const store = createFileChangeStore()
    store.registerChange("tool-1", "src/a.ts", "write")
    store.clear()

    expect(store.getAll()).toHaveLength(0)
  })
})
