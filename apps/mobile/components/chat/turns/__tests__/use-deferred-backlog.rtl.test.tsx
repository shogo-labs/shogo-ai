// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { BACKLOG_WINDOW, useDeferredBacklog } from "../use-deferred-backlog"

afterEach(cleanup)

describe("useDeferredBacklog", () => {
  test("a long work log arriving at once renders its tail first, then everything", async () => {
    const { result, rerender } = renderHook(({ length }) => useDeferredBacklog(length, true), {
      initialProps: { length: 0 },
    })
    expect(result.current).toBe(0)

    rerender({ length: 300 })
    expect(result.current).toBe(300 - BACKLOG_WINDOW)

    await waitFor(() => expect(result.current).toBe(0))
    rerender({ length: 301 })
    expect(result.current).toBe(0)
  })

  test("a work log growing a step at a time is never windowed", () => {
    const { result, rerender } = renderHook(({ length }) => useDeferredBacklog(length, true), {
      initialProps: { length: 1 },
    })
    for (let length = 2; length <= 60; length++) {
      act(() => rerender({ length }))
      expect(result.current).toBe(0)
    }
  })

  test("a finished turn renders in full", () => {
    const { result } = renderHook(() => useDeferredBacklog(300, false))
    expect(result.current).toBe(0)
  })
})
