// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { extractPlanFilepath } from "../plan-tool"

describe("extractPlanFilepath", () => {
  test("extracts a path from a runtime text result", () => {
    expect(
      extractPlanFilepath({
        content: [
          {
            type: "text",
            text: 'Plan "Launch plan" created and saved to .shogo/plans/launch-plan_ab12.plan.md',
          },
        ],
      }),
    ).toBe(".shogo/plans/launch-plan_ab12.plan.md")
  })

  test("extracts a path from an update result string", () => {
    expect(
      extractPlanFilepath('Plan "Launch plan" updated at .shogo/plans/launch-plan_ab12.plan.md'),
    ).toBe(".shogo/plans/launch-plan_ab12.plan.md")
  })

  test("accepts a direct filepath result", () => {
    expect(
      extractPlanFilepath({ filepath: ".shogo/plans/launch-plan_ab12.plan.md" }),
    ).toBe(".shogo/plans/launch-plan_ab12.plan.md")
  })

  test("returns undefined when no plan path is present", () => {
    expect(extractPlanFilepath("Plan is still being written")).toBeUndefined()
  })
})
