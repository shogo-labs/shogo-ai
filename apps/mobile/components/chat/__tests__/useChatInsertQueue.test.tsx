// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatPanel's side of "Add to Chat" (#1082): requests from the bus reach the
 * active panel's composer as insert requests (never as a draft restore that
 * would wipe what the user typed), expand a collapsed chat, and are not
 * consumed by inactive panels.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "web", select: (spec: any) => spec.web ?? spec.default } as any }),
)

const { useChatInsertQueue } = await import("../useChatInsertQueue")
const bus = await import("../../../lib/chat-insert-bus")

beforeEach(() => bus._resetChatInsertBusForTests())
afterEach(() => bus._resetChatInsertBusForTests())

describe("useChatInsertQueue", () => {
  test("the terminal's Add to Chat event becomes an insert request (appended, not a draft restore)", () => {
    const { result } = renderHook(() => useChatInsertQueue({ isActive: true, expand: () => {} }))
    act(() => {
      window.dispatchEvent(new CustomEvent(bus.TERMINAL_ADD_TO_CHAT_EVENT, { detail: { text: "npm ERR! missing script" } }))
    })
    expect(result.current.insertRequest).toMatchObject({ text: "npm ERR! missing script" })
  })

  test("requests queue in order and advance as the composer applies them", () => {
    const { result } = renderHook(() => useChatInsertQueue({ isActive: true, expand: () => {} }))
    act(() => {
      bus.requestChatInsert({ source: "ide-tree", references: [{ type: "file", path: "a.ts", name: "a.ts" }] })
      bus.requestChatInsert({ source: "ide-editor", text: "second" })
    })
    const first = result.current.insertRequest!
    expect(first.references?.[0]).toMatchObject({ path: "a.ts" })
    act(() => result.current.markApplied(first.nonce))
    expect(result.current.insertRequest).toMatchObject({ text: "second" })
    act(() => result.current.markApplied(result.current.insertRequest!.nonce))
    expect(result.current.insertRequest).toBeNull()
  })

  test("a collapsed chat expands on insert", () => {
    const expand = mock(() => {})
    renderHook(() => useChatInsertQueue({ isActive: true, expand }))
    act(() => bus.requestChatInsert({ source: "shogo-code", text: "x" }))
    expect(expand).toHaveBeenCalledTimes(1)
  })

  test("an inactive panel does not consume requests; they wait for the active one", () => {
    const inactive = renderHook(() => useChatInsertQueue({ isActive: false, expand: () => {} }))
    act(() => bus.requestChatInsert({ source: "ide-tree", text: "queued" }))
    expect(inactive.result.current.insertRequest).toBeNull()
    expect(bus.hasChatInsertSubscriber()).toBe(false)
    const active = renderHook(() => useChatInsertQueue({ isActive: true, expand: () => {} }))
    expect(active.result.current.insertRequest).toMatchObject({ text: "queued" })
  })

  test("becoming inactive unsubscribes", () => {
    const { rerender } = renderHook(({ isActive }) => useChatInsertQueue({ isActive, expand: () => {} }), {
      initialProps: { isActive: true },
    })
    expect(bus.hasChatInsertSubscriber()).toBe(true)
    rerender({ isActive: false })
    expect(bus.hasChatInsertSubscriber()).toBe(false)
  })

  test("applying a request calls its onApplied", () => {
    const onApplied = mock(() => {})
    const { result } = renderHook(() => useChatInsertQueue({ isActive: true, expand: () => {} }))
    act(() => {
      bus.requestChatInsert({ source: "shogo-code", text: "x", onApplied })
    })
    expect(onApplied).not.toHaveBeenCalled()
    act(() => result.current.markApplied(result.current.insertRequest!.nonce))
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  test("a panel that goes inactive stops showing its queue and hands it to the next active panel", () => {
    const { result, rerender } = renderHook(({ isActive }) => useChatInsertQueue({ isActive, expand: () => {} }), {
      initialProps: { isActive: true },
    })
    act(() => {
      bus.requestChatInsert({ source: "ide-tree", text: "one" })
      bus.requestChatInsert({ source: "ide-tree", text: "two" })
    })
    act(() => rerender({ isActive: false }))
    expect(result.current.insertRequest).toBeNull()
    const next = renderHook(() => useChatInsertQueue({ isActive: true, expand: () => {} }))
    expect(next.result.current.insertRequest).toMatchObject({ text: "one" })
    act(() => next.result.current.markApplied(next.result.current.insertRequest!.nonce))
    expect(next.result.current.insertRequest).toMatchObject({ text: "two" })
  })

  test("empty requests are ignored", () => {
    const expand = mock(() => {})
    const { result } = renderHook(() => useChatInsertQueue({ isActive: true, expand }))
    act(() => bus.requestChatInsert({ source: "terminal", text: "   ", references: [] }))
    expect(result.current.insertRequest).toBeNull()
    expect(expand).not.toHaveBeenCalled()
  })
})
