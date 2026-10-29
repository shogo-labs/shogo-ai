// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "web", select: (s: any) => s.web ?? s.default } as any }),
)

const { useIdeBridge, parseIdeReferences } = await import("../ideBridge")
const bus = await import("../../../lib/chat-insert-bus")

const posted: any[] = []
const originalPostMessage = window.parent.postMessage

beforeEach(() => {
  posted.length = 0
  bus._resetChatInsertBusForTests()
  ;(window.parent as any).postMessage = (message: unknown) => posted.push(message)
})
afterEach(() => {
  ;(window.parent as any).postMessage = originalPostMessage
  bus._resetChatInsertBusForTests()
})

function deliver(data: unknown, source: MessageEventSource | null = window.parent) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }))
  })
}

const acks = () => posted.filter((m) => m.type === "shogo.ide.referencesAck")

const selection = {
  type: "selection",
  path: "src/big.ts",
  name: "big.ts",
  startLine: 120,
  endLine: 140,
  text: "const x = 1",
  languageId: "typescript",
}

describe("useIdeBridge — Shogo Code Add to Chat", () => {
  test("addReferences becomes a shogo-code insert request, acknowledged once the composer applies it", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    deliver({ type: "shogo.ide.addReferences", batchId: "b1", references: [selection, { type: "file", path: "a.ts", name: "a.ts" }] })
    expect(seen).toHaveLength(1)
    expect(seen[0].source).toBe("shogo-code")
    expect(seen[0].references).toEqual([selection, { type: "file", path: "a.ts", name: "a.ts" }])
    expect(acks()).toEqual([])
    act(() => seen[0].onApplied())
    expect(acks()).toEqual([{ type: "shogo.ide.referencesAck", batchId: "b1" }])
  })

  test("a batch queued with no composer open is not acknowledged", () => {
    renderHook(() => useIdeBridge(true))
    deliver({ type: "shogo.ide.addReferences", batchId: "q1", references: [selection] })
    expect(bus.hasChatInsertSubscriber()).toBe(false)
    expect(acks()).toEqual([])
  })

  test("a re-sent batch (after reconnect) is inserted once; it is acked again only after it was applied", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    const msg = { type: "shogo.ide.addReferences", batchId: "b2", references: [selection] }
    deliver(msg)
    deliver(msg)
    expect(seen).toHaveLength(1)
    expect(acks()).toHaveLength(0)
    act(() => seen[0].onApplied())
    deliver(msg)
    expect(seen).toHaveLength(1)
    expect(acks()).toHaveLength(2)
  })

  test("messages from any window other than the embedding IDE are ignored", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    const other = { postMessage: () => {} } as unknown as MessageEventSource
    deliver({ type: "shogo.ide.addReferences", batchId: "x1", references: [selection] }, other)
    deliver({ type: "shogo.ide.addReferences", batchId: "x2", references: [selection] }, null)
    expect(seen).toEqual([])
  })

  test("malformed references are dropped", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    deliver({
      type: "shogo.ide.addReferences",
      batchId: "b3",
      references: [
        { type: "file", path: "", name: "x" },
        { type: "selection", path: "a.ts", name: "a.ts", startLine: 5, endLine: 2, text: "x" },
        { type: "selection", path: "a.ts", name: "a.ts", startLine: 1, endLine: 2, text: "  " },
        { type: "project", id: "p", name: "p", path: "p" },
        "nope",
        { type: "folder", path: "src", name: "src" },
      ],
    })
    expect(seen[0].references).toEqual([{ type: "folder", path: "src", name: "src" }])
  })

  test("an addReferences without a batchId is ignored", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(true))
    deliver({ type: "shogo.ide.addReferences", references: [selection] })
    expect(seen).toEqual([])
    expect(posted.some((m) => m.type === "shogo.ide.referencesAck")).toBe(false)
  })

  test("shogo.ide.context still parses activeFile / workspaceFolders / workspaceItems", () => {
    const { result } = renderHook(() => useIdeBridge(true))
    deliver({
      type: "shogo.ide.context",
      activeFile: { path: "src/a.ts", languageId: "typescript" },
      workspaceFolders: [{ name: "app", path: "" }],
      workspaceItems: [{ type: "file", path: "src/a.ts", name: "a.ts" }],
    })
    expect(result.current.isConnected).toBe(true)
    expect(result.current.context).toEqual({
      activeFile: { path: "src/a.ts", languageId: "typescript" },
      workspaceFolders: [{ name: "app", path: "" }],
      workspaceItems: [{ type: "file", path: "src/a.ts", name: "a.ts" }],
    })
  })

  test("disabled bridges ignore Shogo Code messages", () => {
    const seen: any[] = []
    bus.subscribeChatInsert((r) => seen.push(r))
    renderHook(() => useIdeBridge(false))
    deliver({ type: "shogo.ide.addReferences", batchId: "b4", references: [selection] })
    expect(seen).toEqual([])
  })
})

describe("parseIdeReferences", () => {
  test("keeps the optional selection fields", () => {
    expect(parseIdeReferences([{ ...selection, truncated: true }])).toEqual([{ ...selection, truncated: true }])
    expect(parseIdeReferences("x")).toEqual([])
  })
})
