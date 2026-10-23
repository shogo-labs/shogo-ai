// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Images and videos an agent embeds by workspace path render from the agent
 * workspace instead of Streamdown's "[Image blocked]" placeholder; stored
 * attachments load from their signed URL.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, waitFor } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
  }),
)

const fetched: string[] = []
mock.module("../../../lib/agent-fetch", () => ({
  agentFetch: async (url: string) => {
    fetched.push(url)
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } })
  },
}))
mock.module("../../../lib/agent-image-source", () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))
mock.module("../../../lib/api-url", () => ({ API_URL: "https://api.test" }))

const { MarkdownText } = await import("../MarkdownText.web")
const { ChatContextProvider } = await import("../ChatContext")

afterEach(() => {
  cleanup()
  fetched.length = 0
})

function renderMd(text: string, agentUrl: string | null = "https://agent.test") {
  const value = { agentUrl } as any
  return render(
    <ChatContextProvider value={value}>
      <MarkdownText isStreaming={false}>{text}</MarkdownText>
    </ChatContextProvider>,
  ).container
}

describe("media in rendered markdown", () => {
  test("a workspace image loads from the agent and is never blocked", () => {
    const container = renderMd("Here it is:\n\n![](brand/buddy-pixar/faithful.png)")
    expect(container.textContent).not.toContain("Image blocked")
    const img = container.querySelector('[data-testid="chat-media-image"]') as HTMLImageElement
    expect(img.getAttribute("src")).toBe("https://agent.test/agent/workspace/download/brand/buddy-pixar/faithful.png")
    expect(img.getAttribute("alt")).toBe("faithful.png")
  })

  test("a workspace video plays from a fetched blob", async () => {
    const createObjectURL = mock(() => "blob:video-1")
    ;(globalThis.URL as any).createObjectURL = createObjectURL
    ;(globalThis.URL as any).revokeObjectURL = () => {}
    const container = renderMd("![Demo](clips/demo.mp4)")
    await waitFor(() => expect(container.querySelector('[data-testid="chat-media-video"]')).not.toBeNull())
    const video = container.querySelector('[data-testid="chat-media-video"]') as HTMLVideoElement
    expect(video.getAttribute("src")).toBe("blob:video-1")
    expect(fetched).toEqual(["https://agent.test/agent/workspace/download/clips/demo.mp4"])
  })

  test("a stored attachment uses its signed URL", () => {
    const container = renderMd("![Hero](/api/conversation-files/abc?t=sig#hero.png)", null)
    const img = container.querySelector('[data-testid="chat-media-image"]') as HTMLImageElement
    expect(img.getAttribute("src")).toBe("https://api.test/api/conversation-files/abc?t=sig#hero.png")
  })

  test("without an agent the workspace image says it is unavailable", () => {
    const container = renderMd("![Logo](brand/logo.png)", null)
    expect(container.querySelector('[data-testid="chat-media-unavailable"]')?.textContent).toBe("Image unavailable: Logo")
    expect(container.textContent).not.toContain("Image blocked")
  })
})
