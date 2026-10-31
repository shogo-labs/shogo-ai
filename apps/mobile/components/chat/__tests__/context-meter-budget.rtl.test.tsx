// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-168 acceptance 4 — a session at the summarize threshold reads ~100% in
 * the ring, not ~19%.
 *
 * The frame values are the ones `packages/agent-runtime/src/__tests__/context-meter-budget.test.ts`
 * reads off a real 1M-window turn: `data-context-usage` at ~190k with
 * `contextWindowTokens: 200000` (the summarize budget). The same numerator
 * against the model's 1M window is the pre-fix reading, kept here so a
 * regression back to the model window is visible in the component itself.
 */
import { describe, expect, test } from "bun:test"
import { render } from "@testing-library/react"
import * as React from "react"

const { ContextTracker } = await import("../ContextTracker")
const { ContextBreakdownPanel } = await import("../ContextBreakdownPanel")

/** What the gateway reports at the point summarization fires (AGENT_AUTOCOMPACT_TOKENS).
 * The live cap moved to 235k in SHO-259; these are literal frame values, and the
 * assertions below are about the component's arithmetic, not the current budget. */
const SUMMARIZE_BUDGET = 200_000
/** The model's catalog window (haiku-5-5 / opus-5-5) — info only since SHO-168. */
const MODEL_WINDOW = 1_000_000
/** `estimateTokens` of the seeded session in the runtime test, to the token. */
const ESTIMATE_AT_THRESHOLD = 190_002

describe("SHO-168 context meter rendering", () => {
  test("AC4: the pill reads ~95% of the summarize budget", () => {
    const { getByLabelText } = render(
      <ContextTracker inputTokens={ESTIMATE_AT_THRESHOLD} contextWindowTokens={SUMMARIZE_BUDGET} />,
    )
    const label = getByLabelText(/context used/).getAttribute("aria-label")!
    const pct = Number.parseFloat(label)
    expect(pct).toBeGreaterThan(90)
    expect(pct).toBeLessThanOrEqual(100)
    expect(label).toContain("190.0K / 200K context used")
  })

  test("AC4: the same frame against the model window is the pre-fix ~19%", () => {
    const { getByLabelText } = render(
      <ContextTracker inputTokens={ESTIMATE_AT_THRESHOLD} contextWindowTokens={MODEL_WINDOW} />,
    )
    const label = getByLabelText(/context used/).getAttribute("aria-label")!
    expect(Number.parseFloat(label)).toBeLessThan(30)
    expect(label).toContain("/ 1M context used")
  })

  test("the dock panel divides by the same budget", () => {
    const budget = render(
      <ContextBreakdownPanel
        breakdown={{ categories: [], grandEstTokens: 190_002 }}
        inputTokens={190_002}
        contextWindowTokens={SUMMARIZE_BUDGET}
      />,
    )
    expect(budget.getByText("95% Full")).toBeTruthy()
    expect(budget.getByText(/190\.0K \/ 200K Tokens/)).toBeTruthy()
    budget.unmount()

    const windowed = render(
      <ContextBreakdownPanel
        breakdown={{ categories: [], grandEstTokens: 190_002 }}
        inputTokens={190_002}
        contextWindowTokens={MODEL_WINDOW}
      />,
    )
    expect(windowed.getByText("19% Full")).toBeTruthy()
    expect(windowed.getByText(/190\.0K \/ 1M Tokens/)).toBeTruthy()
  })
})
