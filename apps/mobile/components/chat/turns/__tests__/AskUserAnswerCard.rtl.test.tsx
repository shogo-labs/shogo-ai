// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("../ChatContext", () => ({
  useChatContextSafe: () => null,
}))
mock.module("../../../../lib/agent-image-source", () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))

const { AskUserAnswerCard } = await import("../AskUserAnswerCard")

describe("AskUserAnswerCard", () => {
  test("renders each question and its selected answers", () => {
    render(
      <AskUserAnswerCard
        variant="row"
        answeredQuestion={{
          toolCallId: "call-1",
          response: "Style: Minimal\nColors: Blue, Green",
          questions: [
            {
              header: "Style",
              question: "What style should we use?",
              options: [{ label: "Minimal", description: "Clean and focused" }],
              multiSelect: false,
            },
            {
              header: "Colors",
              question: "Which colors work?",
              options: [
                { label: "Blue", description: "Cool" },
                { label: "Green", description: "Fresh" },
              ],
              multiSelect: true,
            },
          ],
        }}
      />,
    )

    expect(screen.getByText("Answered 2 questions")).toBeTruthy()
    expect(screen.getByText("What style should we use?")).toBeTruthy()
    expect(screen.getByText("Minimal")).toBeTruthy()
    expect(screen.getByText("Which colors work?")).toBeTruthy()
    expect(screen.getByText("Blue")).toBeTruthy()
    expect(screen.getByText("Green")).toBeTruthy()
  })
})
