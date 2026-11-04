// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-287: merging a delta of saved rows into the transcript on screen.
 *
 * The bug: the merge sorted everything by `createdAt || 0`, and every message
 * the AI SDK builds locally sorts to index 0 — so the live reply jumped above
 * the first prompt and stayed there.
 */
import { describe, expect, test } from "bun:test"
import { mergeTranscriptRows, sortTranscriptRows } from "../transcript-merge"

type M = {
  id?: string
  role?: "user" | "assistant"
  createdAt?: number
  parts?: unknown
  content?: string
}

const user = (id: string, at?: number): M => ({
  id,
  role: "user",
  createdAt: at,
  content: id,
})

const reply = (id: string, at?: number): M => ({
  id,
  role: "assistant",
  createdAt: at,
  parts: [{ type: "text", text: id }],
})

const ids = (rows: M[]) => rows.map((row) => row.id)

describe("mergeTranscriptRows", () => {
  test("a live reply is replaced in place by the saved row for its turn", () => {
    // Screen: the prompt, then the streaming bubble (no createdAt, and its id
    // is an SDK nanoid the server never wrote).
    const live = [
      user("u1", 1000),
      {
        id: "sdk-nanoid",
        role: "assistant",
        parts: [
          { type: "data-turn-start", data: { turnId: "turn-1", startedAt: 1001 } },
          { type: "text", text: "hello" },
        ],
      } as M,
    ]
    const delta = [
      user("u1", 1000),
      {
        ...reply("a1", 1002),
        parts: [
          { type: "data-turn-timing", data: { turnId: "turn-1", startedAt: 1001, completedAt: 1002 } },
          { type: "text", text: "hello" },
        ],
      },
    ]

    expect(ids(mergeTranscriptRows(live, delta))).toEqual(["u1", "a1"])
  })

  test("a message with no createdAt never sorts above an earlier prompt", () => {
    const live = [user("u1", 1000), user("u2", 1005), reply("live", undefined)]
    const merged = mergeTranscriptRows(live, [reply("a2", 1006)])
    expect(ids(merged)).toEqual(["u1", "u2", "live", "a2"])
    expect(merged[merged.length - 1].id).toBe("a2")
  })

  test("the merge only ever reports one reply per prompt (chained queued turns)", () => {
    const live = [user("uA", 1000), reply("aA", 1001), user("uB", 1002), reply("aB", 1003), user("uC", 1004)]
    const merged = mergeTranscriptRows(live, [
      user("uA", 1000),
      reply("aA", 1001),
      user("uB", 1002),
      reply("aB", 1003),
      user("uC", 1004),
      reply("aC", 1005),
    ])
    expect(ids(merged)).toEqual(["uA", "aA", "uB", "aB", "uC", "aC"])
  })

  test("a saved row this screen has never seen lands in its own turn, not at the end of an older one", () => {
    const live = [user("u1", 1000), reply("a1", 1001), user("u2", 3000)]
    const merged = mergeTranscriptRows(live, [reply("a2", 3001)])
    expect(ids(merged)).toEqual(["u1", "a1", "u2", "a2"])
  })

  test("a delta row replaces the on-screen copy in the position it holds", () => {
    const live = [user("u1", 1000), reply("a1", 1001)]
    const newer = { ...reply("a1", 1001), content: "final" }
    const merged = mergeTranscriptRows(live, [newer])
    expect(ids(merged)).toEqual(["u1", "a1"])
    expect(merged[1].content).toBe("final")
  })

  test("an empty delta leaves the screen exactly as it was", () => {
    const live = [user("u1", 1000), reply("live", undefined)]
    expect(mergeTranscriptRows(live, [])).toBe(live)
  })

  /**
   * SHO-306. A turn key is a scan of the message's parts, and the merge asked
   * for it once per row × per message on screen — quadratic on a long turn, and
   * a synchronous block on the reopen path. Each message is asked once now.
   */
  test("asks for a message's turn key once per merge, not once per row", () => {
    const screen: M[] = []
    for (let i = 0; i < 50; i += 1) {
      screen.push(user(`u${i}`, 1000 + i * 10))
      screen.push(reply(`a${i}`, 1005 + i * 10))
    }
    const rows: M[] = []
    for (let i = 0; i < 50; i += 1) {
      rows.push({ ...user(`u${i}`, 1000 + i * 10), content: "edited" })
    }

    const asked = new Map<M, number>()
    mergeTranscriptRows(screen, rows, (message) => {
      if (!message) return null
      asked.set(message as M, (asked.get(message as M) ?? 0) + 1)
      return `turn:${(message as M).id}`
    })

    const repeated = [...asked.entries()].filter(([, count]) => count > 1)
    expect(
      repeated.map(([message, count]) => `${(message as M).id} asked ${count}x`),
    ).toEqual([])
  })
})

describe("sortTranscriptRows", () => {
  test("orders saved rows oldest first", () => {
    const rows = [reply("a2", 300), user("u1", 100), reply("a1", 200)]
    expect(ids(sortTranscriptRows(rows))).toEqual(["u1", "a1", "a2"])
  })

  test("keeps a message without a timestamp at the end instead of the top", () => {
    const rows = [reply("live", undefined), user("u1", 100), reply("a1", 200)]
    expect(ids(sortTranscriptRows(rows))).toEqual(["u1", "a1", "live"])
  })
})
