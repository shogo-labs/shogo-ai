// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createNativePhoneReactNativeMock } from "../../../../test/native-phone-sheet-mock"

mock.module("react-native", () => createNativePhoneReactNativeMock())

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return {
    CheckCircle2: Icon,
    ClipboardList: Icon,
    ChevronRight: Icon,
  }
})

mock.module(resolve(import.meta.dir, "../../../../lib/native-phone-layout"), () => ({
  useIsNativePhoneLayout: () => true,
  NATIVE_PHONE_DOCK_COMPOSER_GAP: 12,
}))

mock.module(resolve(import.meta.dir, "../../../../lib/phone-density"), () => ({
  PHONE_DENSITY: {
    icon: { xs: 16, sm: 20, md: 22, lg: 24 },
    text: { caption: "text-sm", body: "text-lg", title: "text-xl" },
    rowMin: "min-h-12",
    hitSize: "h-12 w-12",
  },
  COMPACT_DENSITY: {
    icon: { xs: 10, sm: 12, md: 14, lg: 16 },
    text: { caption: "text-[10px]", body: "text-sm", title: "text-sm" },
  },
}))

const { PlanReferenceCard } = await import("../PlanReferenceCard")

const PLAN = {
  name: "Coding Practice Plan",
  overview: "Practice good coding habits",
  plan: "Read CONTRIBUTING.md first.",
  filepath: ".shogo/plans/coding.plan.md",
  todos: [],
}

describe("PlanReferenceCard native summary", () => {
  test("shows a created summary and opens the Plans panel", () => {
    const onViewPlan = mock(() => {})

    render(
      <PlanReferenceCard
        plan={PLAN}
        isConfirmed={false}
        isUpdate={false}
        onViewPlan={onViewPlan}
      />,
    )

    expect(screen.getByText("Created plan")).toBeTruthy()
    expect(screen.getByText("Practice good coding habits")).toBeTruthy()

    fireEvent.click(
      screen.getByRole("button", {
        name: "Created plan: Coding Practice Plan. View plan.",
      }),
    )
    expect(onViewPlan).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("native-plan-preview-sheet")).toBeNull()
  })

  test("uses the updated past-tense label", () => {
    render(
      <PlanReferenceCard
        plan={PLAN}
        isConfirmed={false}
        isUpdate
        onViewPlan={() => {}}
      />,
    )

    expect(screen.getByText("Updated plan")).toBeTruthy()
    expect(screen.queryByText("Updating plan")).toBeNull()
  })

  test("composer Build starts the plan without opening a preview sheet", () => {
    const onBuild = mock(() => {})

    render(
      <PlanReferenceCard
        variant="composer"
        plan={PLAN}
        isConfirmed={false}
        isUpdate={false}
        onBuild={onBuild}
        onViewPlan={() => {}}
        selectedModel="claude-haiku-4-5-20251001"
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Build plan" }))
    expect(screen.queryByTestId("native-plan-preview-sheet")).toBeNull()
    expect(onBuild).toHaveBeenCalledTimes(1)
    expect(onBuild.mock.calls[0]?.[0]).toEqual(PLAN)
    expect(onBuild.mock.calls[0]?.[1]).toBe("claude-haiku-4-5-20251001")
  })
})
