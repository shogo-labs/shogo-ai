// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          onClick: onPress,
          role: accessibilityRole,
        },
        children,
      ),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return {
    CheckCircle2: Icon,
    ClipboardList: Icon,
    ChevronRight: Icon,
    X: Icon,
  }
})

mock.module(resolve(import.meta.dir, "../../../../lib/native-phone-layout"), () => ({
  useIsNativePhoneLayout: () => true,
  NATIVE_PHONE_SHEET_BODY_RATIO: 0.62,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO: 0.78,
  NATIVE_PHONE_DOCK_COMPOSER_GAP: 12,
}))

mock.module(resolve(import.meta.dir, "../../../../lib/phone-density"), () => ({
  PHONE_DENSITY: {
    icon: { xs: 16, sm: 20, md: 22, lg: 24 },
    text: { body: "text-lg", title: "text-xl" },
    rowMin: "min-h-12",
    hitSize: "h-12 w-12",
  },
  COMPACT_DENSITY: {
    icon: { xs: 10, sm: 12, md: 14 },
  },
}))

mock.module(resolve(import.meta.dir, "../../../../lib/visible-models"), () => ({
  resolveShortName: (id: string) => (id.includes("haiku") ? "Haiku" : id),
}))

mock.module(resolve(import.meta.dir, "../../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheetCloseButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { "aria-label": "Close", onClick: onPress }, "Close"),
  NativePhoneSheet: ({
    visible,
    title,
    footer,
    headerLeft,
    children,
  }: {
    visible: boolean
    title?: string
    footer?: ReactNode
    headerLeft?: ReactNode
    children: ReactNode
  }) =>
    visible
      ? createElement(
          "div",
          { "data-testid": "plan-sheet" },
          headerLeft,
          createElement("h1", null, title),
          children,
          footer,
        )
      : null,
}))

mock.module(resolve(import.meta.dir, "../../MarkdownText"), () => ({
  MarkdownText: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}))

mock.module(resolve(import.meta.dir, "../../ModelPickerMenu"), () => ({
  ComposerModelPicker: ({
    label,
    hideCostLabels,
    triggerAccessibilityLabel,
  }: {
    label: string
    hideCostLabels?: boolean
    triggerAccessibilityLabel?: string
  }) =>
    createElement(
      "button",
      { "aria-label": triggerAccessibilityLabel },
      label,
      hideCostLabels ? null : createElement("span", null, "Cheaper"),
    ),
}))

const { PlanReferenceCard } = await import("../PlanReferenceCard")

const PLAN = {
  name: "Coding Practice Plan",
  overview: "Practice good coding habits",
  plan: "Read CONTRIBUTING.md first.",
  filepath: ".shogo/plans/coding.plan.md",
  todos: [],
}

describe("PlanReferenceCard native sheet", () => {
  test("opens a bottom sheet with model, View plan, and Build", () => {
    const onBuild = mock(() => {})
    const onViewPlan = mock(() => {})

    render(
      <PlanReferenceCard
        plan={PLAN}
        isConfirmed={false}
        isUpdate={false}
        onBuild={onBuild}
        onViewPlan={onViewPlan}
        selectedModel="claude-haiku-4-5-20251001"
        isPro
      />,
    )

    expect(screen.getByText("Plan Ready")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Plan Ready: Coding Practice Plan" }))

    expect(screen.getByTestId("plan-sheet")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
    expect(screen.getByText("Plan")).toBeTruthy()
    expect(screen.getAllByText("Coding Practice Plan").length).toBeGreaterThan(1)
    expect(screen.getByText("Haiku")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Choose model to build this plan/ })).toBeTruthy()
    expect(screen.queryByText("Cheaper")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "View plan in Plans" }))
    expect(onViewPlan).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("plan-sheet")).toBeNull()
  })

  test("sheet Build starts the plan with the selected model", () => {
    const onBuild = mock(() => {})

    render(
      <PlanReferenceCard
        plan={PLAN}
        isConfirmed={false}
        isUpdate={false}
        onBuild={onBuild}
        onViewPlan={() => {}}
        selectedModel="claude-haiku-4-5-20251001"
        isPro
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Plan Ready: Coding Practice Plan" }))
    const buildButtons = screen.getAllByRole("button", { name: "Build plan" })
    fireEvent.click(buildButtons[buildButtons.length - 1]!)

    expect(onBuild).toHaveBeenCalledTimes(1)
    expect(onBuild.mock.calls[0]?.[0]).toEqual(PLAN)
    expect(onBuild.mock.calls[0]?.[1]).toBe("claude-haiku-4-5-20251001")
  })

  test("composer variant is the oval above the input, not the dock card", () => {
    render(
      <PlanReferenceCard
        variant="composer"
        plan={PLAN}
        isConfirmed={false}
        isUpdate={false}
        onBuild={() => {}}
        selectedModel="claude-haiku-4-5-20251001"
        isPro
      />,
    )

    const oval = screen.getByRole("button", { name: /Plan Ready: Coding Practice Plan/ })
    expect(oval.parentElement?.className).toContain("rounded-full")
  })

  test("oval Build starts the plan without opening the sheet", () => {
    const onBuild = mock(() => {})

    render(
      <PlanReferenceCard
        variant="composer"
        plan={PLAN}
        isConfirmed={false}
        isUpdate={false}
        onBuild={onBuild}
        selectedModel="claude-haiku-4-5-20251001"
        isPro
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Build plan" }))
    expect(screen.queryByTestId("plan-sheet")).toBeNull()
    expect(onBuild).toHaveBeenCalledTimes(1)
    expect(onBuild.mock.calls[0]?.[0]).toEqual(PLAN)
    expect(onBuild.mock.calls[0]?.[1]).toBe("claude-haiku-4-5-20251001")
  })
})
