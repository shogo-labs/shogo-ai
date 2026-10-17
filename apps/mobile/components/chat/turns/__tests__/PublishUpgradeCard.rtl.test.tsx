// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A `publish` call refused by the Pro-plan gate (`plan_not_allowed`) used to
 * render as a plain tool row, leaving the user with only the agent's text.
 * It now renders a card with an Upgrade button that opens billing.
 */
// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const Host = React.forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  { accessibilityLabel, children, onPress, ...props },
  ref,
) {
  return React.createElement(
    "button",
    { ...props, "aria-label": accessibilityLabel, onClick: onPress, ref },
    children as React.ReactNode,
  )
})
mock.module("react-native", () => createReactNativeMock({ Pressable: Host }))
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("lucide-react-native", () => {
  const Icon = () => React.createElement("i")
  return { Globe: Icon }
})
const push = mock((_to: unknown) => {})
mock.module("expo-router", () => ({ useRouter: () => ({ push }) }))

const { PublishUpgradeCard, isPublishPlanGate } = await import("../PublishUpgradeCard")

const gated = {
  id: "p1",
  toolName: "publish",
  state: "success",
  args: { subdomain: "my-site" },
  result: {
    error: "Publishing to a subdomain requires a Pro (or higher) plan.",
    code: "plan_not_allowed",
  },
} as any

beforeEach(() => push.mockClear())
afterEach(cleanup)

describe("isPublishPlanGate", () => {
  test("matches a publish result refused by the plan gate, as an object or JSON text", () => {
    expect(isPublishPlanGate(gated)).toBe(true)
    expect(isPublishPlanGate({ ...gated, result: JSON.stringify(gated.result) })).toBe(true)
  })

  test("ignores other publish failures, successes, and other tools", () => {
    expect(isPublishPlanGate({ ...gated, result: { error: "taken", code: "subdomain_taken" } })).toBe(false)
    expect(isPublishPlanGate({ ...gated, result: { ok: true, url: "https://x.shogo.one" } })).toBe(false)
    expect(isPublishPlanGate({ ...gated, toolName: "share_file" })).toBe(false)
    expect(isPublishPlanGate({ ...gated, state: "streaming", result: undefined })).toBe(false)
  })
})

describe("PublishUpgradeCard", () => {
  test("explains the gate and opens billing from the Upgrade button", () => {
    render(React.createElement(PublishUpgradeCard, { tool: gated }))
    expect(screen.getByText("Publishing needs Pro")).toBeTruthy()
    expect(screen.getByText(/my-site\.shogo\.one/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro to publish" }))
    expect(push).toHaveBeenCalledWith("/(app)/billing")
  })
})
