// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publish errors in the Publish dropdown. A `plan_not_allowed` 402 (the plan
 * check on open failed or went stale) used to show only the server message in
 * red; the dropdown now recognizes it and switches to its Upgrade state.
 */
// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { describe, expect, test } from "bun:test"
import { isPublishPlanError, publishErrorMessage } from "../publish-errors"

const planError = Object.assign(new Error("Publishing to a subdomain is available on Pro and higher plans. Upgrade to publish."), {
  details: { error: { code: "plan_not_allowed" } },
})

describe("isPublishPlanError", () => {
  test("recognizes the Pro-plan gate in either error envelope", () => {
    expect(isPublishPlanError(planError)).toBe(true)
    expect(isPublishPlanError({ details: { code: "plan_not_allowed" } })).toBe(true)
  })

  test("ignores other publish errors", () => {
    expect(isPublishPlanError({ details: { error: { code: "subdomain_taken" } } })).toBe(false)
    expect(isPublishPlanError(new Error("boom"))).toBe(false)
    expect(isPublishPlanError(null)).toBe(false)
  })
})

describe("publishErrorMessage", () => {
  test("keeps the existing copy for cloud and timeout codes", () => {
    expect(publishErrorMessage({ details: { error: { code: "cloud_signin_required" } } })).toBe(
      "Sign in to Shogo Cloud to publish from the desktop app.",
    )
    expect(publishErrorMessage({ name: "AbortError" })).toMatch(/taking longer than expected/)
    expect(publishErrorMessage(new Error("Subdomain is already in use"))).toBe("Subdomain is already in use")
  })
})
