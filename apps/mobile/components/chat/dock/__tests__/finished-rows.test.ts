// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { RunningProcess } from "../../../ProcessPanel"
import {
  DOCK_FINISHED_LINGER_MS,
  DOCK_FINISHED_MIN_VISIBLE_MS,
  finishLingerDelayMs,
  isFinishedProcess,
  processKey,
  visibleLingerDelayMs,
} from "../finished-rows"

function task(overrides: Partial<RunningProcess> = {}): RunningProcess {
  return {
    runId: "t_1",
    id: "t_1",
    command: "bun dev",
    startedAt: 0,
    status: "running",
    ...overrides,
  } as RunningProcess
}

describe("finished-rows", () => {
  test("a task is identified by its task id, falling back to the run", () => {
    expect(processKey(task({ id: "t_9", runId: "r_9" }))).toBe("t_9")
    expect(processKey(task({ id: undefined, runId: "r_9" }))).toBe("r_9")
  })

  test("finished means a finish time or a terminal status — not a stale row", () => {
    expect(isFinishedProcess(task())).toBe(false)
    expect(isFinishedProcess(task({ stale: true }))).toBe(false)
    expect(isFinishedProcess(task({ status: "completed" }))).toBe(true)
    expect(isFinishedProcess(task({ status: "failed" }))).toBe(true)
    expect(isFinishedProcess(task({ status: "cancelled" }))).toBe(true)
    expect(isFinishedProcess(task({ finishedAt: 1_000 }))).toBe(true)
  })

  test("the linger counts from the moment the task settled", () => {
    const now = 1_000_000
    expect(finishLingerDelayMs(task({ status: "completed", finishedAt: now }), now)).toBe(
      DOCK_FINISHED_LINGER_MS,
    )
    expect(
      finishLingerDelayMs(task({ status: "completed", finishedAt: now - 1_500 }), now),
    ).toBe(DOCK_FINISHED_LINGER_MS - 1_500)
  })

  test("a row that settled longer ago than the linger leaves immediately", () => {
    const now = 1_000_000
    expect(
      finishLingerDelayMs(task({ status: "completed", finishedAt: now - 60_000 }), now),
    ).toBe(0)
    // A clock skew that puts finishedAt in the future must not park the row forever.
    expect(
      finishLingerDelayMs(task({ status: "completed", finishedAt: now + 60_000 }), now),
    ).toBe(DOCK_FINISHED_LINGER_MS)
  })

  describe("visibleLingerDelayMs", () => {
    const settledLongAgo = task({ status: "completed", finishedAt: 940_000 })

    test("a row that was on screen when it settled keeps the full linger", () => {
      const now = 1_000_000
      const justSettled = task({ status: "completed", finishedAt: now })
      // Seen settled the moment it settled: the finish anchor decides.
      expect(visibleLingerDelayMs(justSettled, now, now)).toBe(DOCK_FINISHED_LINGER_MS)
      // Seen 1 s after it settled: 3 s of server linger is still longer than the floor.
      expect(
        visibleLingerDelayMs(task({ status: "completed", finishedAt: now - 1_000 }), now, now - 1_000),
      ).toBe(DOCK_FINISHED_LINGER_MS - 1_000)
    })

    test("a row the poll delivers late still gets a readable window", () => {
      // Settled a minute ago, first rendered now: without the floor this is 0
      // and the row blinks out before anyone reads the outcome.
      const now = 1_000_000
      expect(visibleLingerDelayMs(settledLongAgo, now, now)).toBe(DOCK_FINISHED_MIN_VISIBLE_MS)
      expect(visibleLingerDelayMs(settledLongAgo, now + 1_000, now)).toBe(500)
    })

    test("first sight only ever extends the window, never shortens it", () => {
      const now = 1_000_000
      const justSettled = task({ status: "completed", finishedAt: now })
      expect(visibleLingerDelayMs(justSettled, now, now - 30_000)).toBe(DOCK_FINISHED_LINGER_MS)
    })

    test("a row past both anchors leaves immediately, and the delay never exceeds the linger", () => {
      const now = 1_000_000
      expect(visibleLingerDelayMs(settledLongAgo, now, now - 60_000)).toBe(0)
      // Clock skew putting finishedAt in the future is capped at the linger.
      expect(
        visibleLingerDelayMs(task({ status: "completed", finishedAt: now + 60_000 }), now, now),
      ).toBe(DOCK_FINISHED_LINGER_MS)
    })
  })
})
