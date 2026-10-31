// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 AC 7 — ids sent in the current page session must become the
 * persisted `ChatMessage.id`s, or `truncate-from` 404s ("Message not found")
 * and the edit silently rolls back.
 */

import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { planIdAdoptions } from "../persisted-message-ids"
import { OPTIMISTIC_ECHO_ID } from "../optimistic-echo"

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage
const assistant = (id: string, text = "ok"): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage

describe("planIdAdoptions", () => {
  test("swaps a nanoid bubble for the persisted row id", () => {
    const plan = planIdAdoptions(
      [user("etaFabWQxbFogiOw", "alpha one"), assistant("a1")],
      [{ rowId: "cmrow123", text: "alpha one" }],
      new Set(),
    )
    expect(plan.swaps).toEqual([{ from: "etaFabWQxbFogiOw", to: "cmrow123" }])
    expect(plan.remaining).toEqual([])
  })

  test("keeps the entry pending until its bubble exists", () => {
    const plan = planIdAdoptions(
      [user("older", "alpha one")],
      [{ rowId: "cmrow123", text: "beta two" }],
      new Set(),
    )
    expect(plan.swaps).toEqual([])
    expect(plan.remaining).toEqual([{ rowId: "cmrow123", text: "beta two" }])
  })

  test("skips the painted echo — it stands in for a bubble that isn't there", () => {
    const plan = planIdAdoptions(
      [user(OPTIMISTIC_ECHO_ID, "alpha one")],
      [{ rowId: "cmrow123", text: "alpha one" }],
      new Set(),
    )
    expect(plan.swaps).toEqual([])
    expect(plan.remaining).toHaveLength(1)
  })

  test("never rewrites a bubble that already carries a row id", () => {
    const plan = planIdAdoptions(
      [user("cmrow123", "alpha one"), user("nanoid-2", "alpha one")],
      [{ rowId: "cmrow999", text: "alpha one" }],
      new Set(["cmrow999"]),
    )
    // cmrow999 is already adopted, so nothing may point at it again; the
    // newest unmatched bubble is the pending one.
    expect(plan.swaps).toEqual([{ from: "nanoid-2", to: "cmrow999" }])
  })

  test("a repeated send maps to its own row, newest bubble first", () => {
    const plan = planIdAdoptions(
      [user("old-continue", "continue"), assistant("a1"), user("new-continue", "continue")],
      [{ rowId: "cmrow-new", text: "continue" }],
      new Set(["cmrow-old"]),
    )
    expect(plan.swaps).toEqual([{ from: "new-continue", to: "cmrow-new" }])
  })

  test("claims one bubble per entry, so two in-flight sends can't collide", () => {
    const plan = planIdAdoptions(
      [user("n1", "one"), user("n2", "two")],
      [
        { rowId: "row-one", text: "one" },
        { rowId: "row-two", text: "two" },
      ],
      new Set(),
    )
    expect(plan.swaps).toEqual([
      { from: "n1", to: "row-one" },
      { from: "n2", to: "row-two" },
    ])
  })
})
