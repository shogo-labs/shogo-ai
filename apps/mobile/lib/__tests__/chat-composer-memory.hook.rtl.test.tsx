// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useChatComposerMemory` — the React side of SHO-261: switching chats shows
 * that chat's own draft and model, and a submit-level clear empties it.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { mock } from "bun:test"

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
  },
}))

type Mod = typeof import("../chat-composer-memory")
let mod: Mod
beforeAll(async () => {
  mod = await import("../chat-composer-memory")
})

afterEach(cleanup)

describe("useChatComposerMemory", () => {
  test("no chat yet is never 'ready' with an empty record", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => mod.useChatComposerMemory(key),
      { initialProps: { key: null as string | null } },
    )
    expect(result.current.ready).toBe(false)
    expect(result.current.record).toBeNull()

    // The chat id arriving later must be what makes it ready.
    rerender({ key: mod.composerMemoryKey("rtl-late-chat") })
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  test("a chat entered after its id arrives still restores its draft", async () => {
    const key = mod.composerMemoryKey("rtl-late-draft")
    // Seed the device cache the way a previous run would have left it.
    const seed = new mod.ComposerMemory(
      {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => {
          store.set(k, v)
        },
        removeItem: async (k: string) => {
          store.delete(k)
        },
      },
      { debounceMs: 0 },
    )
    seed.setDraft(key, "restored after reload", [])
    await Bun.sleep(5)

    // A fresh page: no chat id on the first render (the route/store hydrates
    // it a tick later), which used to consume the one-shot restore with "".
    const { result, rerender } = renderHook(
      ({ k }: { k: string | null }) => mod.useChatComposerMemory(k),
      { initialProps: { k: null as string | null } },
    )
    expect(result.current.ready).toBe(false)

    rerender({ k: key })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.record?.draft?.text).toBe("restored after reload")
    expect(result.current.loadedKey).toBe(key)
  })

  test("each chat keeps its own draft across a switch", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => mod.useChatComposerMemory(key),
      { initialProps: { key: mod.composerMemoryKey("rtl-chat-a") } },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => result.current.saveDraft("hello draft", []))

    // Switch to chat B: its box is empty, never chat A's text.
    rerender({ key: mod.composerMemoryKey("rtl-chat-b") })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.record?.draft).toBeUndefined()

    act(() => result.current.saveDraft("b draft", []))

    // Back to A: A's own text is what comes back.
    rerender({ key: mod.composerMemoryKey("rtl-chat-a") })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.record?.draft?.text).toBe("hello draft")

    rerender({ key: mod.composerMemoryKey("rtl-chat-b") })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.record?.draft?.text).toBe("b draft")
  })

  test("a model pick is remembered per chat, not shared", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => mod.useChatComposerMemory(key),
      { initialProps: { key: mod.composerMemoryKey("rtl-model-a") } },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.saveModel("model-x"))

    rerender({ key: mod.composerMemoryKey("rtl-model-b") })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.record?.model).toBeUndefined()
    act(() => result.current.saveModel("model-y"))

    rerender({ key: mod.composerMemoryKey("rtl-model-a") })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.record?.model).toBe("model-x")
  })

  test("clearing after a submit leaves the box empty for good", async () => {
    const key = mod.composerMemoryKey("rtl-clear")
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => mod.useChatComposerMemory(k),
      { initialProps: { k: key } },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => result.current.saveDraft("queued text", []))
    act(() => result.current.clearDraft())
    expect(result.current.record?.draft).toBeUndefined()

    // A fresh mount (a reload) starts empty too.
    const remounted = renderHook(() => mod.useChatComposerMemory(key))
    await waitFor(() => expect(remounted.result.current.ready).toBe(true))
    expect(remounted.result.current.record?.draft).toBeUndefined()
    remounted.unmount()
    rerender({ k: key })
  })

  // SHO-314: the freeze. Typing re-rendered the whole 10k-line ChatPanel because
  // every keystroke put a new draft record in React state.
  test("typing 20 characters does not re-render the consumer at all", async () => {
    const key = mod.composerMemoryKey("rtl-typing")
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return mod.useChatComposerMemory(key)
    })
    await waitFor(() => expect(result.current.ready).toBe(true))
    const before = renders

    act(() => {
      for (let i = 1; i <= 20; i++) result.current.saveDraft("x".repeat(i), [])
    })

    expect(renders).toBe(before)
    expect(result.current.readDraft()?.text).toBe("x".repeat(20))
  })

  test("the hook keeps one object identity until the chat or its record changes", async () => {
    const key = mod.composerMemoryKey("rtl-stable")
    const { result, rerender } = renderHook(() => mod.useChatComposerMemory(key))
    await waitFor(() => expect(result.current.ready).toBe(true))
    const first = result.current

    // A parent re-render (a streaming message, a toolbar toggle) must hand the
    // same callbacks down, or every memoized child re-renders with it and every
    // effect that depends on them re-runs.
    rerender()
    expect(result.current).toBe(first)

    act(() => result.current.saveDraft("typed", []))
    expect(result.current).toBe(first)
    expect(result.current.saveDraft).toBe(first.saveDraft)
    expect(result.current.readDraft).toBe(first.readDraft)
  })
})
