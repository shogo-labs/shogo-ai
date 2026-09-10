// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
      ...props
    }: any) =>
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

const asyncStorageBacking = new Map<string, string>()
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => asyncStorageBacking.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      asyncStorageBacking.set(k, v)
    },
    removeItem: async (k: string) => {
      asyncStorageBacking.delete(k)
    },
  },
}))

mock.module(resolve(import.meta.dir, "../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheetCloseButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { "aria-label": "Close", onClick: onPress }, "Close"),
  NativePhoneSheet: ({
    visible,
    title,
    headerLeft,
    children,
    testID,
  }: {
    visible: boolean
    title?: string
    headerLeft?: ReactNode
    children: ReactNode
    testID?: string
  }) =>
    visible ? (
      <div data-testid={testID}>
        {headerLeft}
        <h1>{title}</h1>
        {children}
      </div>
    ) : null,
}))

const { NativeAskUserQuestionSheet } = await import("../NativeAskUserQuestionSheet")
const toolTypes = await import("../tools/types")

const pendingTool = {
  id: "call-sheet",
  toolName: "ask_user",
  category: toolTypes.getToolCategory("ask_user"),
  state: "input-available" as never,
  args: {
    questions: [
      {
        header: "Review",
        question: "What should the code-review plan cover?",
        options: [
          { label: "Current branch", description: "Review the current branch" },
          { label: "Checklist", description: "A review process" },
        ],
      },
    ],
  },
  result: undefined,
  timestamp: 0,
}

describe("NativeAskUserQuestionSheet", () => {
  test("slides up as a bottom sheet with Question 1 of 1 and a Done control", async () => {
    render(
      <NativeAskUserQuestionSheet
        visible
        tool={pendingTool}
        onClose={() => {}}
        onSubmitResponse={() => {}}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByTestId("native-ask-user-question-sheet")).toBeTruthy()
    expect(screen.getByText("Question 1 of 1")).toBeTruthy()
    expect(screen.getByText("What should the code-review plan cover?")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
  })

  test("close dismisses without submitting", async () => {
    const onClose = mock(() => {})
    const onSubmitResponse = mock(() => {})
    render(
      <NativeAskUserQuestionSheet
        visible
        tool={pendingTool}
        onClose={onClose}
        onSubmitResponse={onSubmitResponse}
      />,
    )

    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmitResponse).not.toHaveBeenCalled()
  })

  test("hidden when not visible", () => {
    render(
      <NativeAskUserQuestionSheet
        visible={false}
        tool={pendingTool}
        onClose={() => {}}
        onSubmitResponse={() => {}}
      />,
    )
    expect(screen.queryByTestId("native-ask-user-question-sheet")).toBeNull()
  })
})
