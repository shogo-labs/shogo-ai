// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * On iOS / Android a tapped video opens the app's own viewer instead of
 * handing the URL to the system browser.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import React from "react"
import { Linking } from "react-native"
import { pressableAsButton } from "../../../test/native-phone-sheet-mock"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: pressableAsButton,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  }),
)

const VIDEO_URL = "https://files.test/clip.mp4?t=sig"

mock.module("../markdown-media", () => ({
  useMarkdownMedia: () => ({ url: VIDEO_URL, kind: "video", label: "clip.mp4", fromWorkspace: false }),
  useMarkdownImageUri: () => null,
}))
mock.module("../VideoPreviewModal", () => ({
  VideoPreviewModal: ({ url, title }: { url: string; title?: string }) => (
    <div data-testid="video-modal" data-url={url} data-title={title} />
  ),
}))

const { MarkdownMediaNative } = await import("../MarkdownMediaNative")
const { VideoAttachment } = await import("../../team-chat/VideoAttachment")

let openURL: ReturnType<typeof spyOn>

beforeEach(() => {
  openURL = spyOn(Linking, "openURL").mockImplementation(() => Promise.resolve())
})

afterEach(() => {
  cleanup()
  openURL.mockRestore()
})

describe("native video taps", () => {
  test("a markdown video opens the in-app viewer, not the browser", async () => {
    const { container } = render(<MarkdownMediaNative src="clip.mp4" alt="clip.mp4" />)
    expect(container.querySelector('[data-testid="video-modal"]')).toBeNull()

    fireEvent.click(container.querySelector('[testid="chat-media-video"]') as HTMLElement)

    await waitFor(() => expect(container.querySelector('[data-testid="video-modal"]')).not.toBeNull())
    const modal = container.querySelector('[data-testid="video-modal"]') as HTMLElement
    expect(modal.getAttribute("data-url")).toBe(VIDEO_URL)
    expect(modal.getAttribute("data-title")).toBe("clip.mp4")
    expect(openURL).not.toHaveBeenCalled()
  })

  test("a team-chat video tile opens the in-app viewer, not the browser", async () => {
    const { container } = render(<VideoAttachment url={VIDEO_URL} name="standup.mp4" />)

    fireEvent.click(container.querySelector('[testid="message-video"]') as HTMLElement)

    await waitFor(() => expect(container.querySelector('[data-testid="video-modal"]')).not.toBeNull())
    const modal = container.querySelector('[data-testid="video-modal"]') as HTMLElement
    expect(modal.getAttribute("data-url")).toBe(VIDEO_URL)
    expect(modal.getAttribute("data-title")).toBe("standup.mp4")
    expect(openURL).not.toHaveBeenCalled()
  })
})
