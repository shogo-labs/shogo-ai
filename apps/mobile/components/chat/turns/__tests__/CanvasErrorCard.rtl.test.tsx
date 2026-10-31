// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A canvas-error debug prompt renders as a card: phase, route, and the error.
 * Actions and logs stay behind "Show details". An ordinary user message is
 * unchanged and can still be edited.
 */

import { resolve } from "node:path"
import { createElement } from "react"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import { buildCanvasErrorDebugPrompt } from "../canvasErrorPrompt"

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({
      accessibilityLabel,
      children,
      onPress,
      disabled,
    }: any) =>
      createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          type: "button",
          disabled,
          onClick: onPress,
        },
        children,
      ),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
}))
mock.module("expo-clipboard", () => ({ setStringAsync: async () => {} }))
mock.module(resolve(import.meta.dir, "../../ChatInput.tsx"), () => ({
  ChatInput: () => null,
}))
mock.module(resolve(import.meta.dir, "../MessageContent.tsx"), () => ({
  MessageContent: ({
    message,
  }: {
    message: { content?: string; parts?: Array<{ type: string; text?: string }> }
  }) =>
    createElement(
      "div",
      null,
      message.parts?.find((part) => part.type === "text")?.text ??
        message.content ??
        "",
    ),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/native-phone-layout.ts"), () => ({
  useIsNativePhoneLayout: () => false,
  usePhoneLayout: () => false,
  usePhoneLayoutOverride: () => null,
}))
mock.module(resolve(import.meta.dir, "../../ChatContext.tsx"), () => ({
  useChatContextSafe: () => null,
}))

const { EditableUserMessage } = await import("../EditableUserMessage")
const { MessageEditProvider } = await import("../MessageEditContext")

const prompt = buildCanvasErrorDebugPrompt({
  phase: "runtime",
  error: "TypeError: Cannot read properties of undefined",
  route: "/settings",
  recentActions: [
    { ts: Date.UTC(2026, 0, 2, 3, 4, 5, 678), kind: "click", target: "Save" },
  ],
  recentLogs: [
    {
      ts: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
      source: "console",
      level: "error",
      text: "render failed",
    },
  ],
})

function renderMessage(content: string) {
  return render(
    <MessageEditProvider
      editMessage={async () => {}}
      retryFromMessage={async () => {}}
      countMessagesAfter={() => 0}
      isStreaming={false}
      canEditMessage={() => true}
      composerProps={{ isPro: true }}
    >
      <EditableUserMessage
        message={
          {
            id: "m1",
            role: "user",
            content,
            parts: [{ type: "text", text: content }],
          } as any
        }
      />
    </MessageEditProvider>,
  )
}

describe("canvas error card", () => {
  test("shows the phase, route, and error, and hides the model instructions", () => {
    renderMessage(prompt)
    expect(screen.getByText("Canvas error")).toBeTruthy()
    expect(screen.getByText("RUNTIME · /settings")).toBeTruthy()
    expect(
      screen.getByText("TypeError: Cannot read properties of undefined"),
    ).toBeTruthy()
    expect(screen.getByText("1 recent action · 1 log line")).toBeTruthy()
    expect(screen.queryByText(/Read the relevant files/)).toBeNull()
    expect(screen.queryByText(/click Save/)).toBeNull()
    expect(screen.queryByText(/render failed/)).toBeNull()
    expect(
      screen.queryByLabelText("Edit this message and re-run from here"),
    ).toBeNull()
  })

  test("show details expands the action and log lists", () => {
    renderMessage(prompt)
    fireEvent.click(screen.getByRole("button", { name: "Show error details" }))
    expect(screen.getByText(/click Save/)).toBeTruthy()
    expect(screen.getByText(/render failed/)).toBeTruthy()
    expect(screen.getByText("Recent actions")).toBeTruthy()
    expect(screen.getByText("Runtime logs")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Hide error details" }))
    expect(screen.queryByText(/click Save/)).toBeNull()
    expect(screen.queryByText(/render failed/)).toBeNull()
  })

  test("an ordinary user message still shows its text and can be edited", () => {
    renderMessage("please rename the button")
    expect(screen.getByText("please rename the button")).toBeTruthy()
    expect(screen.queryByText("Canvas error")).toBeNull()
    expect(
      screen.getByLabelText("Edit this message and re-run from here"),
    ).toBeTruthy()
  })
})
