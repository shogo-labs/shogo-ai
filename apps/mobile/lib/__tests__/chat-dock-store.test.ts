// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `createChatDockStore`'s `registerPanel` — a
 * missing "did anything observable actually change" guard here let a
 * component re-registering the same panel on every render (e.g.
 * `ChangesDockPanel` before it cached its file list) notify subscribers
 * unconditionally. Combined with `ChatPanel` resubscribing to this store's
 * version to keep `dockHeight` current, that produced an unbroken
 * `render -> registerPanel -> notify -> render` cycle that crashed the
 * whole chat panel in production with React's "Maximum update depth
 * exceeded" (error #185).
 */
import { describe, expect, test } from "bun:test"
import { createChatDockStore, type DockPanelDescriptor } from "../chat-dock-store"
import { ClipboardList, Files } from "lucide-react-native"

function baseDescriptor(overrides: Partial<DockPanelDescriptor> = {}): DockPanelDescriptor {
  return {
    id: "changes",
    kind: "status",
    order: 30,
    title: "Changed files",
    icon: Files,
    summary: "1 file changed",
    render: () => null,
    ...overrides,
  }
}

describe("createChatDockStore registerPanel", () => {
  test("first registration notifies subscribers", () => {
    const store = createChatDockStore()
    let calls = 0
    store.subscribe(() => calls++)

    store.registerPanel(baseDescriptor())

    expect(calls).toBe(1)
    expect(store.isVisible("changes")).toBe(true)
  })

  test("re-registering with an observably-identical descriptor does not notify", () => {
    const store = createChatDockStore()
    store.registerPanel(baseDescriptor())

    let calls = 0
    store.subscribe(() => calls++)

    // Simulates a component re-rendering with a brand-new `render` closure
    // and a fresh object literal, but the same title/order/summary/etc —
    // exactly what happens when an owning component re-renders for reasons
    // unrelated to its own data (e.g. a sibling panel changed).
    store.registerPanel(baseDescriptor({ render: () => null }))

    expect(calls).toBe(0)
  })

  test("re-registering is idempotent across many redundant calls (no runaway notify loop)", () => {
    const store = createChatDockStore()
    store.registerPanel(baseDescriptor())

    let calls = 0
    store.subscribe(() => calls++)

    for (let i = 0; i < 100; i++) {
      store.registerPanel(baseDescriptor({ render: () => null }))
    }

    expect(calls).toBe(0)
  })

  test("changing the summary does notify subscribers", () => {
    const store = createChatDockStore()
    store.registerPanel(baseDescriptor({ summary: "1 file changed" }))

    let calls = 0
    store.subscribe(() => calls++)

    store.registerPanel(baseDescriptor({ summary: "2 files changed" }))

    expect(calls).toBe(1)
  })

  test("changing the chip's count does notify subscribers", () => {
    const store = createChatDockStore()
    store.registerPanel(baseDescriptor({ chip: { icon: Files, count: 1 } }))

    let calls = 0
    store.subscribe(() => calls++)

    store.registerPanel(baseDescriptor({ chip: { icon: Files, count: 2 } }))

    expect(calls).toBe(1)
  })

  test("switching kind between status and blocking does notify subscribers", () => {
    const store = createChatDockStore()
    store.registerPanel(baseDescriptor({ id: "plan", icon: ClipboardList, kind: "status" }))

    let calls = 0
    store.subscribe(() => calls++)

    store.registerPanel(baseDescriptor({ id: "plan", icon: ClipboardList, kind: "blocking" }))

    expect(calls).toBe(1)
  })

  test("the latest render closure is still used even when notify is skipped", () => {
    const store = createChatDockStore()
    store.registerPanel(baseDescriptor({ render: () => "first" }))
    store.registerPanel(baseDescriptor({ render: () => "second" }))

    const [panel] = store.getPanels("status")
    expect(panel?.render({ expanded: true })).toBe("second")
  })
})
