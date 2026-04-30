// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { shouldSuggestPlanMode } from "../plan-mode-suggestion"

describe("shouldSuggestPlanMode", () => {
  test("detects explicit planning and implementation prompts", () => {
    expect(
      shouldSuggestPlanMode("Plan the migration from the old auth flow to the new API.")
    ).toBe(true)
    expect(
      shouldSuggestPlanMode("Implement support for deployment workflows across the mobile and API apps.")
    ).toBe(true)
  })

  test("detects broad multi-file risky work", () => {
    expect(
      shouldSuggestPlanMode("Update the database schema and backend API across multiple files.")
    ).toBe(true)
  })

  test("detects multi-step risky implementation requests", () => {
    expect(
      shouldSuggestPlanMode("Refactor the auth workflow end-to-end before changing the mobile app.")
    ).toBe(true)
    expect(
      shouldSuggestPlanMode("Design a step by step rollout for the Kubernetes deployment migration.")
    ).toBe(true)
  })

  test("does not suggest for small commands or simple questions", () => {
    expect(shouldSuggestPlanMode("list files")).toBe(false)
    expect(shouldSuggestPlanMode("What is the current auth configuration?")).toBe(false)
    expect(shouldSuggestPlanMode("How does this component render messages?")).toBe(false)
  })

  test("does not suggest for direct architecture questions or negated plans", () => {
    expect(
      shouldSuggestPlanMode("How does our mobile architecture handle chat session routing?")
    ).toBe(false)
    expect(shouldSuggestPlanMode("How do I update the Prisma schema?")).toBe(false)
    expect(shouldSuggestPlanMode("Can you explain how to implement auth?")).toBe(false)
    expect(
      shouldSuggestPlanMode("I do not want a plan, just explain the API workflow.")
    ).toBe(false)
    expect(
      shouldSuggestPlanMode("Don't switch to Plan mode for this auth workflow update.")
    ).toBe(false)
    expect(shouldSuggestPlanMode("What is Plan mode?")).toBe(false)
  })

  test("keeps boundary and command-shaped prompts conservative", () => {
    expect(shouldSuggestPlanMode("Implement auth")).toBe(false)
    expect(shouldSuggestPlanMode("Implement the login button styling")).toBe(false)
    expect(shouldSuggestPlanMode("Change the mobile login button color")).toBe(false)
    expect(shouldSuggestPlanMode("run the database migration")).toBe(false)
    expect(
      shouldSuggestPlanMode("run a step by step rollout plan for the database migration workflow")
    ).toBe(true)
  })

  test("suggests for broad work with complexity signals", () => {
    expect(
      shouldSuggestPlanMode(
        "Enhance the Plan mode suggestion UI and cross verify it against Cursor behavior."
      )
    ).toBe(true)
    expect(
      shouldSuggestPlanMode(
        "Can you plan the migration from the old auth flow to the new API?"
      )
    ).toBe(true)
  })

  test("does not suggest only because an implementation prompt is long", () => {
    expect(
      shouldSuggestPlanMode(
        "Implement this straightforward copy tweak in the settings screen so the empty state describes how to add a teammate, keeps the current layout, and preserves the existing button behavior."
      )
    ).toBe(false)
    expect(
      shouldSuggestPlanMode(
        "Fix the chat input so the submit button stays aligned while typing a longer message, without changing the surrounding composer behavior or touching unrelated files."
      )
    ).toBe(false)
  })
})
