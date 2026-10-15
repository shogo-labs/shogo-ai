// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ReadableStream as WebReadableStream, TransformStream as WebTransformStream } from "node:stream/web"
import { act, renderHook, waitFor } from "@testing-library/react"
import { usePacedChat } from "../use-paced-chat"

const preloadTransformStream = globalThis.TransformStream
beforeAll(() => {
  globalThis.TransformStream = WebTransformStream as typeof TransformStream
})
afterAll(() => {
  globalThis.TransformStream = preloadTransformStream
})

function textTransport(text: string, onSend?: () => void) {
  return {
    async sendMessages() {
      onSend?.()
      return new WebReadableStream({
        start(c) {
          c.enqueue({ type: "start", messageId: "a1" })
          c.enqueue({ type: "text-start", id: "x" })
          c.enqueue({ type: "text-delta", id: "x", delta: text })
          c.enqueue({ type: "text-end", id: "x" })
          c.enqueue({ type: "finish" })
          c.close()
        },
      }) as unknown as ReadableStream<any>
    },
    async reconnectToStream() {
      return null
    },
  }
}

const lastText = (messages: any[]) =>
  messages[messages.length - 1]?.parts?.find((p: any) => p.type === "text")?.text

describe("usePacedChat", () => {
  test("streams through the latest transport and ends with the full message at ready", async () => {
    const { result } = renderHook(() => usePacedChat({ id: "s1", transport: textTransport("hello") as any }))
    await act(async () => {
      await result.current.sendMessage({ text: "go" })
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(lastText(result.current.messages)).toBe("hello")
  })

  test("a new transport does not recreate the chat or drop messages", async () => {
    let sends = 0
    const t1 = textTransport("one", () => sends++)
    const t2 = textTransport("two", () => sends++)
    const { result, rerender } = renderHook(({ transport }) => usePacedChat({ id: "s1", transport: transport as any }), {
      initialProps: { transport: t1 },
    })
    await act(async () => {
      await result.current.sendMessage({ text: "first" })
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    rerender({ transport: t2 })
    expect(result.current.messages.length).toBe(2)
    await act(async () => {
      await result.current.sendMessage({ text: "second" })
    })
    await waitFor(() => expect(lastText(result.current.messages)).toBe("two"))
    expect(result.current.messages.length).toBe(4)
    expect(sends).toBe(2)
  })

  test("a different non-null id recreates the chat; dropping to undefined keeps it", async () => {
    const { result, rerender } = renderHook(({ id }) => usePacedChat({ id, transport: textTransport("x") as any }), {
      initialProps: { id: "s1" as string | undefined },
    })
    expect(result.current.id).toBe("s1")
    rerender({ id: undefined })
    expect(result.current.id).toBe("s1")
    rerender({ id: "s2" })
    expect(result.current.id).toBe("s2")
  })

  test("callbacks always see the latest closure", async () => {
    const seen: string[] = []
    const { result, rerender } = renderHook(
      ({ tag }) =>
        usePacedChat({
          id: "s1",
          transport: textTransport("x") as any,
          onFinish: () => {
            seen.push(tag)
          },
        }),
      { initialProps: { tag: "old" } },
    )
    rerender({ tag: "new" })
    await act(async () => {
      await result.current.sendMessage({ text: "go" })
    })
    await waitFor(() => expect(seen).toEqual(["new"]))
  })
})
