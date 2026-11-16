// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A message that links a picture or a clip shows the file under the text, not
 * only a chip you have to click to recognise — and the chip is still there in
 * the sentence (SHO-388).
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import * as lucideStub from "../../../test/stubs/lucide-react-native"

mock.module("lucide-react-native", () => lucideStub)
// `primitives` pulls the real `react-native` module (Flow types, no DOM shim);
// the chat only needs `cn`.
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
// The real one reaches the auth client and `expo-secure-store`, which pull the
// native module set in. A card only needs the URI the hook would hand it.
mock.module("../../../lib/agent-image-source", () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
    // The cards are Pressables, and the base shim drops `onPress`: wire it to a
    // real DOM click so a tap is what the test exercises.
    Pressable: ({
      children,
      onPress,
      disabled,
      testID,
      accessibilityLabel,
      ...rest
    }: Record<string, unknown>) =>
      React.createElement(
        "div",
        {
          ...rest,
          "aria-label": accessibilityLabel as string,
          "data-rn-shim": testID as string,
          onClick: disabled ? undefined : (onPress as () => void),
        },
        children as React.ReactNode,
      ),
  } as never),
)

const { ChatMarkdown } = await import("../ChatMarkdown")
const { ShareFileProvider } = await import("../share-file-context")

afterEach(cleanup)

function token(path: string): string {
  const claims = {
    typ: "shared-file",
    workspaceId: "ws-1",
    path,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  }
  return `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.c2ln`
}

function renderInApp(text: string, open: (target: unknown) => void, variant?: "card") {
  return render(
    <ShareFileProvider open={open}>
      <ChatMarkdown isStreaming={false} variant={variant}>
        {text}
      </ChatMarkdown>
    </ShareFileProvider>,
  ).container
}

describe("a message that links a picture", () => {
  test("shows the picture under the text and keeps the chip inline", () => {
    const href = `https://studio.shogo.ai/api/f/${token("shots/screen.png")}`
    const container = renderInApp(`Here it is: [screen.png](${href})`, () => {})

    expect(container.querySelector('[data-rn-shim="chat-file-preview-image"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="chat-file-chip"]')).toBeTruthy()
    expect(container.querySelector("img")?.getAttribute("src")).toBe(href)
  })

  test("opens the app's viewer when the preview is tapped", () => {
    const opened: Array<Record<string, unknown>> = []
    const href = `https://studio.shogo.ai/api/f/${token("shots/screen.png")}`
    const container = renderInApp(`[screen.png](${href})`, (target) =>
      opened.push(target as Record<string, unknown>),
    )

    fireEvent.click(container.querySelector('[data-rn-shim="chat-file-preview-image"]') as HTMLElement)

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ href, name: "screen.png", kind: "share" })
  })

  test("a bare URL previews too", () => {
    const href = `https://studio.shogo.ai/api/f/${token("shots/screen.png")}`
    const container = renderInApp(href, () => {})

    expect(container.querySelector('[data-rn-shim="chat-file-preview-image"]')).toBeTruthy()
  })

  test("without an opener there is no card, only the chip behaviour", () => {
    const href = `https://studio.shogo.ai/api/f/${token("shots/screen.png")}`
    const container = render(
      <ChatMarkdown isStreaming={false}>{`[screen.png](${href})`}</ChatMarkdown>,
    ).container

    expect(container.querySelector('[data-rn-shim="chat-file-preview-image"]')).toBeNull()
  })

  test("a card body and a search answer do not grow previews", () => {
    const href = `https://studio.shogo.ai/api/f/${token("shots/screen.png")}`
    const withVariant = renderInApp(`[screen.png](${href})`, () => {}, "card")
    expect(withVariant.querySelector('[data-rn-shim="chat-file-preview-image"]')).toBeNull()
    cleanup()

    const disabled = render(
      <ShareFileProvider open={() => {}}>
        <ChatMarkdown isStreaming={false} filePreviews={false}>{`[screen.png](${href})`}</ChatMarkdown>
      </ShareFileProvider>,
    ).container
    expect(disabled.querySelector('[data-rn-shim="chat-file-preview-image"]')).toBeNull()
  })

  test("a document is left as a chip, with no card", () => {
    const href = `https://studio.shogo.ai/api/f/${token("reports/q4.pdf")}`
    const container = renderInApp(`[Q4 report](${href})`, () => {})

    expect(container.querySelector('[data-testid="chat-file-chip"]')).toBeTruthy()
    expect(container.querySelector('[data-rn-shim="chat-file-preview-image"]')).toBeNull()
    expect(container.querySelector('[data-rn-shim="chat-file-preview-video"]')).toBeNull()
  })
})

describe("a message that links a clip", () => {
  test("shows a poster card that streams its metadata, never a whole-file blob", () => {
    const href = `https://studio.shogo.ai/api/f/${token("clips/demo.mp4")}`
    const container = renderInApp(`[demo.mp4](${href})`, () => {})

    const card = container.querySelector('[data-rn-shim="chat-file-preview-video"]')
    expect(card).toBeTruthy()

    const video = card!.querySelector("video")!
    expect(video).toBeTruthy()
    expect(video.getAttribute("preload")).toBe("metadata")
    expect(video.getAttribute("src")).toBe(href)
    expect(video.getAttribute("src")).not.toContain("blob:")
    expect(video.hasAttribute("controls")).toBe(false)
    expect(video.hasAttribute("autoplay")).toBe(false)
  })

  test("opens the player when tapped", () => {
    const opened: Array<Record<string, unknown>> = []
    const href = `https://studio.shogo.ai/api/f/${token("clips/demo.mp4")}`
    const container = renderInApp(`[demo.mp4](${href})`, (target) =>
      opened.push(target as Record<string, unknown>),
    )

    fireEvent.click(container.querySelector('[data-rn-shim="chat-file-preview-video"]') as HTMLElement)
    expect(opened[0]).toMatchObject({ href, name: "demo.mp4" })
  })
})
