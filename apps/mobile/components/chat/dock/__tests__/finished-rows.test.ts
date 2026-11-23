// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import type { RunningProcess } from "../../../ProcessPanel"
import {
  DOCK_FINISHED_LINGER_MS,
  DOCK_FINISHED_MIN_VISIBLE_MS,
  DOCK_SEEN_MAX_KEYS_PER_SESSION,
  DOCK_SEEN_MAX_SESSIONS,
  DOCK_SEEN_RETENTION_MS,
  finishLingerDelayMs,
  isFinishedProcess,
  markSeenRow,
  processKey,
  pruneSeenLedger,
  visibleLingerDelayMs,
  wasSeenRow,
  type DockSeenLedger,
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

  describe("the seen ledger", () => {
    const NOW = 10_000_000

    test("a retired row is remembered per chat, and nothing else is", () => {
      const ledger = markSeenRow({}, "chat-1", "t_done", NOW)
      expect(wasSeenRow(ledger, "chat-1", "t_done", NOW)).toBe(true)
      expect(wasSeenRow(ledger, "chat-1", "t_other", NOW)).toBe(false)
      // Same task id in another chat was never watched there.
      expect(wasSeenRow(ledger, "chat-2", "t_done", NOW)).toBe(false)
      expect(wasSeenRow(ledger, null, "t_done", NOW)).toBe(false)
    })

    test("a row with no chat to remember it in is neither read nor written", () => {
      const ledger = markSeenRow({}, null, "t_done", NOW)
      expect(ledger).toEqual({})
      expect(wasSeenRow(ledger, null, "t_done", NOW)).toBe(false)
    })

    test("the first stamp wins, so a re-sent row cannot extend its own memory", () => {
      const first = markSeenRow({}, "chat-1", "t_done", NOW)
      const again = markSeenRow(first, "chat-1", "t_done", NOW + 5_000)
      expect(again).toBe(first)
      expect(again["chat-1"]!["t_done"]).toBe(NOW)
      // Just inside the retention it is still remembered, past it is not.
      expect(wasSeenRow(again, "chat-1", "t_done", NOW + DOCK_SEEN_RETENTION_MS - 1)).toBe(true)
      expect(wasSeenRow(again, "chat-1", "t_done", NOW + DOCK_SEEN_RETENTION_MS)).toBe(false)
    })

    test("entries older than the runtime's retention are dropped", () => {
      const ledger: DockSeenLedger = {
        old: { t_old: NOW - DOCK_SEEN_RETENTION_MS - 1 },
        fresh: { t_new: NOW - 1_000 },
      }
      const pruned = pruneSeenLedger(ledger, NOW)
      expect(pruned.old).toBeUndefined()
      expect(pruned.fresh).toEqual({ t_new: NOW - 1_000 })
    })

    test("nothing to prune keeps the same object, so no write is scheduled", () => {
      const ledger = markSeenRow({}, "chat-1", "t_done", NOW)
      expect(pruneSeenLedger(ledger, NOW)).toBe(ledger)
    })

    test("a chat keeps its newest keys once past the per-session cap", () => {
      let ledger: DockSeenLedger = {}
      for (let i = 0; i < DOCK_SEEN_MAX_KEYS_PER_SESSION + 5; i++) {
        ledger = markSeenRow(ledger, "chat-1", `t_${i}`, NOW - (DOCK_SEEN_MAX_KEYS_PER_SESSION + 5 - i))
      }
      const keys = Object.keys(ledger["chat-1"]!)
      expect(keys).toHaveLength(DOCK_SEEN_MAX_KEYS_PER_SESSION)
      // The newest retired ones survive; the oldest were forgotten.
      expect(keys).toContain(`t_${DOCK_SEEN_MAX_KEYS_PER_SESSION + 4}`)
      expect(keys).not.toContain("t_0")
    })

    test("the ledger keeps the most recently active chats once past the session cap", () => {
      let ledger: DockSeenLedger = {}
      for (let i = 0; i < DOCK_SEEN_MAX_SESSIONS + 3; i++) {
        ledger = markSeenRow(ledger, `chat-${i}`, "t_done", NOW - (DOCK_SEEN_MAX_SESSIONS + 3 - i))
      }
      const sessions = Object.keys(ledger)
      expect(sessions).toHaveLength(DOCK_SEEN_MAX_SESSIONS)
      expect(sessions).toContain(`chat-${DOCK_SEEN_MAX_SESSIONS + 2}`)
      expect(sessions).not.toContain("chat-0")
    })

    test("corrupt entries are dropped instead of hidden forever", () => {
      const corrupt = {
        chat: { bad: "yesterday", worse: null, nan: Number.NaN, good: NOW },
      } as unknown as DockSeenLedger
      const pruned = pruneSeenLedger(corrupt, NOW)
      expect(pruned.chat).toEqual({ good: NOW })
      expect(wasSeenRow(corrupt, "chat", "bad", NOW)).toBe(false)
      expect(wasSeenRow({ chat: null } as unknown as DockSeenLedger, "chat", "good", NOW)).toBe(false)
    })
  })
})
