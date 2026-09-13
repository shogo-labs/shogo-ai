// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

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
        children
      ),
  })
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("../../../lib/visible-models", () => ({
  resolveShortName: (id: string) => {
    if (id.includes("haiku")) return "Haiku"
    if (id.includes("opus")) return "Opus"
    return id
  },
  resolveTier: (id: string) => {
    if (id.includes("haiku")) return "economy"
    if (id.includes("opus")) return "premium"
    return "standard"
  },
}))

mock.module("../../../lib/native-phone-layout", () => ({
  usePhoneLayout: () => true,
  useIsNativePhoneLayout: () => true,
}))

mock.module(resolve(import.meta.dir, "../MarkdownText"), () => ({
  MarkdownText: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}))

const pickerCalls: Array<{
  nativeSheet: boolean
  hideCostLabels?: boolean
  label: string
  labelSuffix?: string
  currentModelId: string
}> = []

mock.module(resolve(import.meta.dir, "../ModelPickerMenu"), () => ({
  ComposerModelPicker: ({
    label,
    labelSuffix,
    nativeSheet,
    hideCostLabels,
    triggerAccessibilityLabel,
    currentModelId,
    onSelect,
  }: {
    label: string
    labelSuffix?: string
    nativeSheet: boolean
    hideCostLabels?: boolean
    triggerAccessibilityLabel?: string
    currentModelId: string
    onSelect: (modelId: string) => void
  }) => {
    pickerCalls.push({ nativeSheet, hideCostLabels, label, labelSuffix, currentModelId })
    return createElement(
      "button",
      {
        "aria-label": triggerAccessibilityLabel,
        onClick: () => onSelect("claude-opus-4-7"),
      },
      label,
      labelSuffix ? createElement("span", null, labelSuffix) : null,
    )
  },
}))

const { PlanCard } = await import("../PlanCard")

const PLAN = {
  name: "Solo Backpacker SE Asia",
  overview: "Budget-friendly backpacker plan",
  plan: "Fly into Bangkok and travel south.",
  todos: [{ id: "1", content: "Book flights" }],
}

describe("PlanCard build model picker", () => {
  test("shows which model will build without cost labels, then sends that id", () => {
    pickerCalls.length = 0
    const onBuild = mock(() => {})

    render(<PlanCard plan={PLAN} selectedModel="claude-haiku-4-5-20251001" isPro onBuild={onBuild} />)

    expect(screen.getByRole("button", { name: "Build plan" })).toBeTruthy()
    expect(screen.getByText("Haiku")).toBeTruthy()
    expect(screen.queryByText("Cheaper")).toBeNull()
    expect(screen.queryByText("Higher cost")).toBeNull()
    expect(pickerCalls[0]?.nativeSheet).toBe(true)
    expect(pickerCalls[0]?.hideCostLabels).toBe(true)
    expect(pickerCalls[0]?.label).toBe("Haiku")
    expect(pickerCalls[0]?.labelSuffix).toBeUndefined()

    fireEvent.click(
      screen.getByRole("button", {
        name: /Choose model to build this plan/,
      }),
    )
    expect(screen.getByText("Opus")).toBeTruthy()
    expect(screen.queryByText("Higher cost")).toBeNull()
    expect(screen.queryByText("Higher cost than your current pick")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Build plan" }))
    expect(onBuild).toHaveBeenCalledTimes(1)
    expect(onBuild.mock.calls[0]?.[0]).toBe("claude-opus-4-7")
  })

  test("opens the Plans tab instead of expanding the dock preview", () => {
    const onOpenPlan = mock(() => {})
    const longPlan = `${PLAN.plan}\n${"details ".repeat(400)}`

    render(
      <PlanCard
        plan={{ ...PLAN, plan: longPlan, filepath: ".shogo/plans/solo.plan.md" }}
        selectedModel="claude-haiku-4-5-20251001"
        isPro
        onBuild={() => {}}
        onOpenPlan={onOpenPlan}
      />,
    )

    const viewPlan = screen.getByRole("button", { name: "View plan in Plans" })
    expect(viewPlan).toBeTruthy()
    expect(screen.queryByText("View Full Plan")).toBeNull()
    expect(screen.queryByText("Collapse Plan")).toBeNull()

    fireEvent.click(viewPlan)
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
  })
})
