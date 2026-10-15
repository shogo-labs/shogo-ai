// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { useThrottledWhileStreaming } from "../use-throttled-while-streaming"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("useThrottledWhileStreaming", () => {
  test("while streaming, a new value is never applied inside the same commit (no synchronous setState in the effect)", async () => {
    let renders = 0
    const { result, rerender } = renderHook(
      ({ value }) => {
        renders++
        return useThrottledWhileStreaming(value, true, 20)
      },
      { initialProps: { value: "a" } },
    )
    // Long past the interval: the old implementation applied "b" synchronously here.
    await act(() => sleep(40))
    const before = renders
    rerender({ value: "b" })
    expect(result.current).toBe("a")
    expect(renders).toBe(before + 1)
    await act(() => sleep(5))
    expect(result.current).toBe("b")
  })

  test("coalesces values that arrive within one interval into a single update with the latest", async () => {
    let renders = 0
    const { result, rerender } = renderHook(
      ({ value }) => {
        renders++
        return useThrottledWhileStreaming(value, true, 30)
      },
      { initialProps: { value: 0 } },
    )
    const start = renders
    for (let i = 1; i <= 10; i++) rerender({ value: i })
    expect(result.current).toBe(0)
    await act(() => sleep(60))
    expect(result.current).toBe(10)
    // 10 prop renders + exactly one throttled update.
    expect(renders - start).toBe(11)
  })

  test("stream end flushes the latest value immediately and cancels the pending timer", async () => {
    const { result, rerender } = renderHook(
      ({ value, streaming }) => useThrottledWhileStreaming(value, streaming, 1_000),
      { initialProps: { value: "a", streaming: true } },
    )
    rerender({ value: "b", streaming: true })
    expect(result.current).toBe("a")
    rerender({ value: "c", streaming: false })
    expect(result.current).toBe("c")
  })
})
