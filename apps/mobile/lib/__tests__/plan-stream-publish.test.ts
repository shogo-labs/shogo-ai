// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { planToPublishToStream, shouldListInMemoryPlan } from "../plan-stream-publish"

describe("planToPublishToStream", () => {
  test("keeps the dock plan after streaming ends so Plans is not empty", () => {
    const pending = { name: "Solo Backpacker" }
    expect(
      planToPublishToStream({
        derivedStreamingPlan: null,
        isStreaming: false,
        pendingPlan: pending,
        confirmedPlan: null,
      }),
    ).toBe(pending)
  })

  test("prefers the live stream snapshot while tokens are still arriving", () => {
    const derived = { name: "partial" }
    const pending = { name: "stale" }
    expect(
      planToPublishToStream({
        derivedStreamingPlan: derived,
        isStreaming: true,
        pendingPlan: pending,
        confirmedPlan: null,
      }),
    ).toBe(derived)
  })
})

describe("shouldListInMemoryPlan", () => {
  test("lists an unsaved in-memory plan", () => {
    expect(shouldListInMemoryPlan({ name: "Trip" } as { filepath?: string }, [])).toBe(true)
  })

  test("hides the in-memory row once the file is in the persisted list", () => {
    expect(
      shouldListInMemoryPlan({ filepath: ".shogo/plans/solo.plan.md" }, ["solo.plan.md"]),
    ).toBe(false)
  })

  test("still lists a plan whose path is not a saved .plan.md file", () => {
    expect(shouldListInMemoryPlan({ filepath: "not-a-plan" }, ["solo.plan.md"])).toBe(true)
  })
})
