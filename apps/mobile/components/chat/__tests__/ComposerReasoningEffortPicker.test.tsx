// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { createReactNativeMock } from "../../../test/react-native-mock"

const models = [
  {
    id: "gpt-6-sol",
    displayName: "GPT-6 Sol",
    reasoningEffort: "high",
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "hoshi-model",
    displayName: "Hoshi 2.0",
    reasoningEffort: "high",
    reasoningEfforts: [],
  },
]

function PressableShim({
  children,
  onPress,
  testID,
  accessibilityLabel,
  disabled,
  className,
}: any) {
  return createElement(
    "button",
    { type: "button", onClick: onPress, "data-testid": testID, "aria-label": accessibilityLabel, disabled, className },
    children,
  )
}

mock.module("react-native", () => createReactNativeMock({ Pressable: PressableShim }))
mock.module("lucide-react-native", () => ({
  Check: () => null,
  ChevronDown: () => null,
}))
mock.module("@/components/ui/popover", () => ({
  Popover: ({ isOpen, onOpen, trigger, children }: any) =>
    createElement("div", null, trigger({ onPress: onOpen }), isOpen ? children : null),
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: any) => createElement("div", null, children),
}))
mock.module("../../../lib/visible-models", () => ({
  useModelPickerList: () => models,
}))

const { ComposerReasoningEffortPicker } = await import("../ComposerReasoningEffortPicker")

describe("ComposerReasoningEffortPicker", () => {
  test("shows the selected model's choices and reports an effort selection", () => {
    const onSelect = mock(() => {})
    render(
      createElement(ComposerReasoningEffortPicker, {
        modelId: "gpt-6-sol",
        selectedEffort: "high",
        onSelect,
      }),
    )

    expect(screen.getByTestId("reasoning-effort-picker-trigger").textContent).toContain("High")
    fireEvent.click(screen.getByTestId("reasoning-effort-picker-trigger"))
    expect(screen.getByTestId("reasoning-effort-picker-default").textContent).toContain("Default")
    expect(screen.getByTestId("reasoning-effort-picker-xhigh").textContent).toContain("Xhigh")
    fireEvent.click(screen.getByTestId("reasoning-effort-picker-low"))
    expect(onSelect).toHaveBeenCalledWith("gpt-6-sol", "low")
  })

  test("is hidden for Auto and models without selectable efforts", () => {
    const onSelect = mock(() => {})
    const auto = render(
      createElement(ComposerReasoningEffortPicker, {
        modelId: AUTO_MODEL_ID,
        onSelect,
      }),
    )
    expect(screen.queryByTestId("reasoning-effort-picker-trigger")).toBeNull()
    auto.unmount()

    render(
      createElement(ComposerReasoningEffortPicker, {
        modelId: "hoshi-model",
        onSelect,
      }),
    )
    expect(screen.queryByTestId("reasoning-effort-picker-trigger")).toBeNull()
  })
})
