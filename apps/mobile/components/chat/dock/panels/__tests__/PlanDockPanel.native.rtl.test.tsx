// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../../test/react-native-mock"

const dockCalls: Array<unknown> = []

mock.module("react-native", () => createReactNativeMock({ Platform: { OS: "ios" } }))

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module(resolve(import.meta.dir, "../../../../../lib/native-phone-layout"), () => ({
  useIsNativePhoneLayout: () => true,
}))

mock.module(resolve(import.meta.dir, "../../useDockPanel"), () => ({
  useDockPanel: (descriptor: unknown) => {
    dockCalls.push(descriptor)
  },
}))

mock.module(resolve(import.meta.dir, "../../../PlanCard"), () => ({
  PlanCard: () => createElement("div", null, "PlanCard"),
}))

const { PlanDockPanel } = await import("../PlanDockPanel")

describe("PlanDockPanel native phone", () => {
  test("does not register the expanded dock Plan card", () => {
    dockCalls.length = 0
    render(
      <PlanDockPanel
        pendingPlan={{
          name: "Tokyo 36-Hour Layover",
          overview: "",
          plan: "Itinerary",
          todos: [],
        }}
        confirmedPlan={null}
        onBuild={() => {}}
      />,
    )
    expect(dockCalls.at(-1)).toBeNull()
  })
})
