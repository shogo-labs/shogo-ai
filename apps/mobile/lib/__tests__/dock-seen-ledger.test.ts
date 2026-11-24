// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The device-side half of SHO-535: a chat reopened after a reload (web or
 * desktop) must not replay rows it already watched retire, so the ledger is
 * mirrored to AsyncStorage. Also covers the promise the panel leans on — a
 * ledger that cannot be read or written falls back to today's behaviour and
 * never hides a row.
 */

import { beforeEach, describe, expect, jest, mock, test } from "bun:test"

const STORAGE_KEY = "shogo:dock-seen-rows"
const backing = new Map<string, string>()
let failing = false

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (failing) throw new Error("storage unavailable")
      return backing.get(k) ?? null
    },
    setItem: async (k: string, v: string) => {
      if (failing) throw new Error("storage unavailable")
      backing.set(k, v)
    },
    removeItem: async (k: string) => {
      backing.delete(k)
    },
  },
}))

const ledgerStore = await import("../dock-seen-ledger")
const { DOCK_SEEN_RETENTION_MS } = await import(
  "../../components/chat/dock/finished-rows"
)

beforeEach(() => {
  backing.clear()
  failing = false
  ledgerStore.__resetDockSeenLedgerStorageForTests()
})

describe("dock seen ledger", () => {
  test("a row retired before the reload is still remembered after it", async () => {
    backing.set(STORAGE_KEY, JSON.stringify({ "chat-1": { t_a: Date.now() - 1_000 } }))
    await ledgerStore.hydrateDockSeenLedger()

    expect(ledgerStore.wasDockRowShown("chat-1", "t_a")).toBe(true)
    expect(ledgerStore.wasDockRowShown("chat-1", "t_b")).toBe(false)
    expect(ledgerStore.wasDockRowShown("chat-2", "t_a")).toBe(false)
  })

  test("entries past the runtime's retention are forgotten on load", async () => {
    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        stale: { t_old: Date.now() - DOCK_SEEN_RETENTION_MS - 1 },
        fresh: { t_new: Date.now() - 1_000 },
      }),
    )
    await ledgerStore.hydrateDockSeenLedger()

    expect(ledgerStore.wasDockRowShown("stale", "t_old")).toBe(false)
    expect(ledgerStore.wasDockRowShown("fresh", "t_new")).toBe(true)
  })

  test("corrupt storage hides nothing and does not throw", async () => {
    backing.set(STORAGE_KEY, "{not json")
    await ledgerStore.hydrateDockSeenLedger()
    expect(ledgerStore.wasDockRowShown("chat-1", "t_a")).toBe(false)

    backing.set(STORAGE_KEY, JSON.stringify(["not", "a", "ledger"]))
    ledgerStore.__resetDockSeenLedgerStorageForTests()
    await ledgerStore.hydrateDockSeenLedger()
    expect(ledgerStore.wasDockRowShown("chat-1", "t_a")).toBe(false)
  })

  test("a storage that cannot be read falls back to replaying, never hiding", async () => {
    backing.set(STORAGE_KEY, JSON.stringify({ "chat-1": { t_a: Date.now() } }))
    failing = true
    await ledgerStore.hydrateDockSeenLedger()
    expect(ledgerStore.wasDockRowShown("chat-1", "t_a")).toBe(false)

    // Marking still works in memory for this run.
    ledgerStore.markDockRowShown("chat-1", "t_b")
    expect(ledgerStore.wasDockRowShown("chat-1", "t_b")).toBe(true)
  })

  test("a mark is written to storage once, after the debounce", async () => {
    jest.useFakeTimers()
    await ledgerStore.hydrateDockSeenLedger()

    ledgerStore.markDockRowShown("chat-1", "t_a", Date.now())
    ledgerStore.markDockRowShown("chat-1", "t_b", Date.now())
    expect(backing.get(STORAGE_KEY)).toBeUndefined()

    jest.advanceTimersByTime(1_000)
    await Promise.resolve()
    const saved = JSON.parse(backing.get(STORAGE_KEY)!)
    expect(Object.keys(saved["chat-1"]).sort()).toEqual(["t_a", "t_b"])

    jest.useRealTimers()
  })

  test("a row with no chat is never written", async () => {
    jest.useFakeTimers()
    await ledgerStore.hydrateDockSeenLedger()
    ledgerStore.markDockRowShown(null, "t_a", Date.now())
    jest.advanceTimersByTime(1_000)
    await Promise.resolve()
    expect(backing.get(STORAGE_KEY)).toBeUndefined()
    jest.useRealTimers()
  })

  test("a later mark does not restart the debounce", async () => {
    jest.useFakeTimers()
    await ledgerStore.hydrateDockSeenLedger()
    ledgerStore.markDockRowShown("chat-1", "t_a", Date.now())
    jest.advanceTimersByTime(100)
    ledgerStore.markDockRowShown("chat-1", "t_b", Date.now())
    // Both rows land in the single write the first mark scheduled.
    jest.advanceTimersByTime(400)
    await Promise.resolve()
    const saved = JSON.parse(backing.get(STORAGE_KEY)!)
    expect(Object.keys(saved["chat-1"]).sort()).toEqual(["t_a", "t_b"])
    jest.useRealTimers()
  })
})
