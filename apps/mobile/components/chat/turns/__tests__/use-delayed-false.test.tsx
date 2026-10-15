// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { useDelayedFalse } from "../use-delayed-false"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("useDelayedFalse", () => {
  test("re-rendering with an unchanged value schedules no state update", () => {
    let renders = 0
    const { rerender } = renderHook(
      ({ value }) => {
        renders++
        return useDelayedFalse(value, 50)
      },
      { initialProps: { value: true } },
    )
    const start = renders
    for (let i = 0; i < 20; i++) rerender({ value: true })
    expect(renders - start).toBe(20)
  })

  test("rising edge is immediate, falling edge waits delayMs", async () => {
    const { result, rerender } = renderHook(({ value }) => useDelayedFalse(value, 30), {
      initialProps: { value: false },
    })
    rerender({ value: true })
    expect(result.current).toBe(true)
    rerender({ value: false })
    expect(result.current).toBe(true)
    await act(() => sleep(50))
    expect(result.current).toBe(false)
  })

  test("a rising edge during the delay cancels the fall", async () => {
    const { result, rerender } = renderHook(({ value }) => useDelayedFalse(value, 30), {
      initialProps: { value: true },
    })
    rerender({ value: false })
    rerender({ value: true })
    await act(() => sleep(50))
    expect(result.current).toBe(true)
  })
})
