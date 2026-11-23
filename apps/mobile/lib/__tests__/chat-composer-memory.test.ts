// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `chat-composer-memory.ts` — per-chat model pick + unsent draft (SHO-261).
 * Drives the pure core with an in-memory store and a manual scheduler.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))

import {
  ComposerMemory,
  CHAT_COMPOSER_INDEX_KEY,
  MAX_DRAFT_CHARS,
  MAX_REMEMBERED_CHATS,
  MAX_RECORD_AGE_MS,
  composerMemoryKey,
  homeComposerMemoryKey,
  sanitizeRecord,
  resolveChatModel,
  resolvePickerModel,
  lastUserModelStamp,
  type ComposerMemoryStorage,
} from "../chat-composer-memory"

function memoryStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  const storage: ComposerMemoryStorage = {
    getItem: async (k) => store.get(k) ?? null,
    setItem: async (k, v) => {
      store.set(k, v)
    },
    removeItem: async (k) => {
      store.delete(k)
    },
  }
  return { store, storage }
}

interface Scheduled {
  fn: () => void
  ms: number
  cancelled: boolean
}

function manualScheduler() {
  const scheduled: Scheduled[] = []
  return {
    scheduled,
    schedule: (fn: () => void, ms: number) => {
      const entry: Scheduled = { fn, ms, cancelled: false }
      scheduled.push(entry)
      return entry
    },
    cancel: (handle: unknown) => {
      ;(handle as Scheduled).cancelled = true
    },
    async runAll() {
      for (const entry of scheduled) {
        if (!entry.cancelled) entry.fn()
      }
    },
  }
}

const KEY = composerMemoryKey("session-a")

describe("keys", () => {
  test("chat and home keys share the prefix but never collide", () => {
    expect(composerMemoryKey("abc")).toBe("shogo:chat-composer:abc")
    expect(homeComposerMemoryKey("ws1")).toBe("shogo:chat-composer:home:ws1")
  })
})

describe("draft round-trip", () => {
  test("a debounced draft is written and reads back", async () => {
    const { store, storage } = memoryStorage()
    const scheduler = manualScheduler()
    let clock = 1000
    const memory = new ComposerMemory(storage, {
      now: () => clock,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })

    memory.setDraft(KEY, "hello draft", [])
    // Not written yet — the write is debounced.
    expect(store.has(KEY)).toBe(false)
    expect(memory.peek(KEY)?.draft?.text).toBe("hello draft")

    await scheduler.runAll()
    await Bun.sleep(0)
    expect(store.has(KEY)).toBe(true)
    expect(JSON.parse(store.get(KEY)!).draft.text).toBe("hello draft")

    clock = 2000
    const fresh = new ComposerMemory(storage, { now: () => clock })
    expect((await fresh.load(KEY))?.draft?.text).toBe("hello draft")
  })

  test("references are persisted alongside the text", async () => {
    const { store, storage } = memoryStorage()
    const memory = new ComposerMemory(storage, { debounceMs: 0 })
    memory.setDraft(KEY, "look at this", [
      { type: "file", path: "src/a.ts", name: "a.ts" },
    ])
    await Bun.sleep(5)
    const saved = JSON.parse(store.get(KEY)!)
    expect(saved.draft.references).toEqual([
      { type: "file", path: "src/a.ts", name: "a.ts" },
    ])
  })

  test("flush writes a still-debounced draft immediately", async () => {
    const { store, storage } = memoryStorage()
    const scheduler = manualScheduler()
    const memory = new ComposerMemory(storage, {
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    })
    memory.setDraft(KEY, "typed but not sent", [])
    expect(store.has(KEY)).toBe(false)
    memory.flush(KEY)
    await Bun.sleep(0)
    expect(store.has(KEY)).toBe(true)
    expect(scheduler.scheduled[0].cancelled).toBe(true)
  })
})

describe("clearing", () => {
  test("an empty draft removes the draft field but keeps the model", async () => {
    const { store, storage } = memoryStorage()
    const memory = new ComposerMemory(storage, { debounceMs: 0 })
    memory.setModel(KEY, "claude-sonnet-4-6")
    memory.setDraft(KEY, "hi", [])
    await Bun.sleep(5)
    expect(JSON.parse(store.get(KEY)!).draft.text).toBe("hi")

    memory.setDraft(KEY, "", [])
    await Bun.sleep(5)
    const saved = JSON.parse(store.get(KEY)!)
    expect(saved.draft).toBeUndefined()
    expect(saved.model).toBe("claude-sonnet-4-6")
  })

  test("a record with nothing left is removed from storage", async () => {
    const { store, storage } = memoryStorage()
    const memory = new ComposerMemory(storage, { debounceMs: 0 })
    memory.setDraft(KEY, "bye", [])
    await Bun.sleep(5)
    expect(store.has(KEY)).toBe(true)

    memory.clearDraft(KEY)
    await Bun.sleep(5)
    expect(store.has(KEY)).toBe(false)
    expect(memory.peek(KEY)).toBeNull()
  })
})

describe("hygiene", () => {
  test("an oversize draft is dropped instead of persisted", async () => {
    const { store, storage } = memoryStorage()
    const memory = new ComposerMemory(storage, { debounceMs: 0 })
    memory.setModel(KEY, "claude-sonnet-4-6")
    memory.setDraft(KEY, "x".repeat(MAX_DRAFT_CHARS + 1), [])
    await Bun.sleep(5)
    const saved = JSON.parse(store.get(KEY)!)
    expect(saved.draft).toBeUndefined()
    expect(saved.model).toBe("claude-sonnet-4-6")
  })

  test("records older than 30 days are pruned on load", async () => {
    const now = Date.now()
    const oldKey = composerMemoryKey("old")
    const { store, storage } = memoryStorage({
      [oldKey]: JSON.stringify({
        draft: { text: "stale", references: [] },
        updatedAt: now - MAX_RECORD_AGE_MS - 1000,
      }),
      [CHAT_COMPOSER_INDEX_KEY]: JSON.stringify([
        { key: oldKey, updatedAt: now - MAX_RECORD_AGE_MS - 1000 },
      ]),
    })
    const memory = new ComposerMemory(storage, { now: () => now })
    expect(await memory.load(oldKey)).toBeNull()
    expect(store.has(oldKey)).toBe(false)
  })

  test("the index keeps at most 200 chats, evicting the oldest", async () => {
    const { store, storage } = memoryStorage()
    let clock = 1000
    const memory = new ComposerMemory(storage, {
      debounceMs: 0,
      now: () => clock++,
    })
    for (let i = 0; i < MAX_REMEMBERED_CHATS + 5; i++) {
      memory.setDraft(composerMemoryKey(`chat-${i}`), `draft ${i}`, [])
    }
    await Bun.sleep(10)
    const index = JSON.parse(store.get(CHAT_COMPOSER_INDEX_KEY)!)
    expect(index.length).toBe(MAX_REMEMBERED_CHATS)
    // The five oldest were evicted from storage too.
    expect(store.has(composerMemoryKey("chat-0"))).toBe(false)
    expect(store.has(composerMemoryKey("chat-4"))).toBe(false)
    expect(store.has(composerMemoryKey("chat-5"))).toBe(true)
  })

  test("load() re-reads storage even when a sync peek cached nothing", async () => {
    const key = composerMemoryKey("peeked-null")
    const { storage } = memoryStorage({
      [key]: JSON.stringify({
        draft: { text: "on disk", references: [] },
        updatedAt: 500,
      }),
    })
    // No readSync: peek cannot see the value and caches null.
    const memory = new ComposerMemory(storage, {})
    expect(memory.peek(key)).toBeNull()
    expect((await memory.load(key))?.draft?.text).toBe("on disk")
  })

  test("load() never goes backwards over a newer cached write", async () => {
    const key = composerMemoryKey("newer-cache")
    const { storage } = memoryStorage({
      [key]: JSON.stringify({
        draft: { text: "old on disk", references: [] },
        updatedAt: 100,
      }),
    })
    let clock = 900
    const memory = new ComposerMemory(storage, {
      now: () => clock++,
      schedule: () => 0,
      cancel: () => {},
    })
    memory.setDraft(key, "typed now", [])
    expect((await memory.load(key))?.draft?.text).toBe("typed now")
  })

  test("sanitizeRecord tolerates garbage", () => {
    expect(sanitizeRecord(null)).toBeNull()
    expect(sanitizeRecord("nope")).toBeNull()
    expect(sanitizeRecord({ draft: { text: "", references: [] } })).toBeNull()
    expect(sanitizeRecord({ model: "" })).toBeNull()
  })
})

describe("which model a chat shows", () => {
  test("a remembered pick wins over an older stamp", () => {
    expect(
      resolveChatModel({
        record: { model: "model-x", modelAt: 200, updatedAt: 200 },
        lastStampedModel: "model-y",
        lastStampedAt: 100,
      }),
    ).toBe("model-x")
  })

  test("a newer stamp wins over the pick (sent from another device)", () => {
    expect(
      resolveChatModel({
        record: { model: "model-x", modelAt: 100, updatedAt: 100 },
        lastStampedModel: "model-y",
        lastStampedAt: 200,
      }),
    ).toBe("model-y")
  })

  test("no pick falls back to the stamp, then to null", () => {
    expect(
      resolveChatModel({
        record: null,
        lastStampedModel: "model-y",
        lastStampedAt: 10,
      }),
    ).toBe("model-y")
    expect(
      resolveChatModel({
        record: null,
        lastStampedModel: null,
        lastStampedAt: 0,
      }),
    ).toBeNull()
  })
})

describe("what the shared picker shows after a reload (SHO-497)", () => {
  const DEFAULT = "sonnet-5"

  test("a chat's own model outranks a preference read that lands after it", () => {
    // The order that failed in the browser: the project reloads, the open chat
    // reports the pick it has in the device cache, and only then does the
    // last-used preference finish loading (the read re-runs when the catalog
    // arrives). Re-applying the preference there is what showed Sonnet — the
    // model last picked in *another* chat — instead of this chat's Opus.
    expect(
      resolvePickerModel({
        chatModel: "opus-uuid",
        preference: "sonnet-uuid",
        defaultModel: DEFAULT,
      }),
    ).toEqual({ model: "opus-uuid", fromChat: true })
  })

  test("with no chat claim the preference seeds the picker", () => {
    expect(
      resolvePickerModel({
        chatModel: null,
        preference: "sonnet-uuid",
        defaultModel: DEFAULT,
      }),
    ).toEqual({ model: "sonnet-uuid", fromChat: false })
  })

  test("with neither, the default seeds it", () => {
    expect(
      resolvePickerModel({ chatModel: null, preference: null, defaultModel: DEFAULT }),
    ).toEqual({ model: DEFAULT, fromChat: false })
  })

  test("an empty id is not a claim", () => {
    expect(
      resolvePickerModel({ chatModel: "", preference: "sonnet-uuid", defaultModel: DEFAULT }),
    ).toEqual({ model: "sonnet-uuid", fromChat: false })
  })
})

describe("which model stamp a chat remembers (SHO-497)", () => {
  test("an assistant stamp never becomes the chat's model", () => {
    // The reply is stamped with what the run used (Auto's tier, or a downgrade);
    // adopting it is what turned a picked Opus back into Auto after every send.
    expect(
      lastUserModelStamp([
        { role: "user", model: "opus-uuid", createdAt: 10 },
        { role: "assistant", model: "auto", createdAt: 11 },
      ]),
    ).toEqual({ model: "opus-uuid", createdAt: 10 })
  })

  test("a chat whose rows carry only assistant stamps remembers nothing", () => {
    expect(
      lastUserModelStamp([
        { role: "assistant", model: "auto", createdAt: 20 },
        { role: "assistant", model: "claude-sonnet-4-6", createdAt: 21 },
      ]),
    ).toBeNull()
  })

  test("the legacy `advanced` sentinel is never a pick", () => {
    expect(
      lastUserModelStamp([
        { role: "user", model: "advanced", createdAt: 5 },
        { role: "assistant", model: "advanced", createdAt: 6 },
      ]),
    ).toBeNull()
    // … and it does not outrank a real pick either.
    expect(
      lastUserModelStamp([
        { role: "user", model: "opus-uuid", createdAt: 5 },
        { role: "assistant", model: "advanced", createdAt: 99 },
      ]),
    ).toEqual({ model: "opus-uuid", createdAt: 5 })
  })

  test("the newest user stamp wins, so another device's send still lands", () => {
    expect(
      lastUserModelStamp([
        { role: "user", model: "opus-uuid", createdAt: 10 },
        { role: "user", model: "sonnet-uuid", createdAt: 30 },
        { role: "assistant", model: "auto", createdAt: 31 },
      ]),
    ).toEqual({ model: "sonnet-uuid", createdAt: 30 })
  })

  test("a blank, missing or malformed stamp is ignored", () => {
    expect(lastUserModelStamp(null)).toBeNull()
    expect(lastUserModelStamp([])).toBeNull()
    expect(
      lastUserModelStamp([
        { role: "user", model: "   ", createdAt: 1 },
        { role: "user", model: 42, createdAt: 2 },
        { role: "user", createdAt: 3 },
      ]),
    ).toBeNull()
  })
})
