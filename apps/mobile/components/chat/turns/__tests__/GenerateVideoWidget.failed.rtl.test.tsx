// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A failed generate_video call is a quiet one-line row, not a red card: the
 * agent usually retries or falls back to another model on its own, and one
 * alarm card per attempt buried the clip that did arrive.
 */

import { createElement } from "react"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ accessibilityLabel, children, onPress, disabled }: any) =>
      createElement("button", { "aria-label": accessibilityLabel, type: "button", disabled, onClick: onPress }, children),
  } as any),
)
mock.module("@legendapp/motion", () => ({
  Motion: { View: ({ children }: any) => createElement("div", null, children) },
}))
mock.module("lucide-react-native", () => ({
  Clapperboard: () => null,
  Download: () => null,
  RefreshCw: () => null,
  Share2: () => null,
}))

const sent: string[] = []
mock.module("../../ChatContext", () => ({
  useChatContextSafe: () => ({ agentUrl: "http://agent", sendMessage: (text: string) => sent.push(text) }),
}))
mock.module("../use-chat-image-width", () => ({ useChatImageWidth: () => 320 }))
mock.module("../../generated-image-actions", () => ({ runGeneratedImageAction: async () => {} }))

const { GenerateVideoWidget } = await import("../GenerateVideoWidget")

describe("GenerateVideoWidget — failed", () => {
  test("renders a muted row with the error and a retry, no destructive styling", () => {
    const { container } = render(
      createElement(GenerateVideoWidget, {
        tool: {
          id: "t1",
          name: "generate_video",
          state: "success",
          args: { prompt: "Krishna playing the flute", model: "google-omni-1.2-flash" },
          result: { id: "vid_1", status: "failed", error: "fetch() URL must not be a blank string." },
        } as any,
      }),
    )

    expect(screen.getByText(/Video not generated · fetch\(\) URL must not be a blank string\./)).toBeTruthy()
    expect(screen.queryByText("Video generation failed")).toBeNull()
    expect(container.innerHTML).not.toContain("destructive")

    fireEvent.click(screen.getByLabelText("Try generating the video again"))
    expect(sent).toEqual(["Krishna playing the flute"])
  })
})
