// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a phone can actually do with each kind. There is no DOM, so the IDE's
 * media previews are out — but a PDF has its own native renderer, and every
 * fallback has to leave a person a way to get the file. That last part is the
 * regression this file guards: saying "Use Download" next to no Download.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" } as never,
    // The base mock renders a host element with no press wiring; here the
    // button's press is the thing under test.
    Pressable: (({
      children,
      onPress,
      disabled,
      testID,
      ...props
    }: {
      children?: React.ReactNode
      onPress?: () => void
      disabled?: boolean
      testID?: string
    }) => (
      <button
        {...props}
        data-testid={testID}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onPress?.()
        }}
      >
        {children}
      </button>
    )) as never,
  }),
)

const downloads: Array<{ url: string; name: string }> = []
mock.module(resolve(import.meta.dir, "../../../lib/attachment-download"), () => ({
  attachmentDownloadUrl: (url: string) => `${url}&dl=1`,
  downloadAttachment: async (url: string, name: string) => {
    downloads.push({ url, name })
  },
}))

// WKWebView, not a browser: the component only has to hand it the URL.
mock.module("react-native-webview", () => ({
  default: ({ source, testID }: { source: { uri: string }; testID?: string }) => (
    <div data-testid={testID} data-uri={source.uri} />
  ),
}))

mock.module("../../project/panels/ide/FilePreview", () => ({
  FilePreview: ({ kind }: { kind: string }) => <div data-testid="file-preview" data-kind={kind} />,
  // `file-view-kind` classifies through this; on a phone it is never handed a
  // kind to classify, but the export still has to resolve.
  previewLanguageFor: () => null,
}))

mock.module("../../chat/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}))

mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react")
const { FileContentView } = await import("../FileContentView")

afterEach(() => {
  cleanup()
  downloads.length = 0
})

function query(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe("FileContentView on a phone", () => {
  test("a PDF renders in the native PDF view, not the fallback", () => {
    render(<FileContentView kind="pdf" name="docs/report.pdf" url="https://api/f/tok" />)

    const pdf = query("file-view-pdf")!
    expect(pdf.getAttribute("data-uri")).toBe("https://api/f/tok")
    expect(query("file-preview")).toBeNull()
    expect(query("file-view-binary")).toBeNull()
  })

  test("a video falls back, and the fallback downloads the URL it was given", async () => {
    render(<FileContentView kind="video" name="clip.mp4" url="https://api/f/tok" />)

    expect(screen.getByText("No preview for this file type.")).toBeTruthy()
    fireEvent.click(query("file-view-download")!)

    await waitFor(() => expect(downloads).toEqual([{ url: "https://api/f/tok", name: "clip.mp4" }]))
  })

  test("the host's own download wins over the built-in one", () => {
    render(
      <FileContentView
        kind="font"
        name="Inter.woff2"
        url="https://api/f/tok"
        download={<button data-testid="host-download">Download</button>}
      />,
    )

    expect(query("host-download")).toBeTruthy()
    expect(query("file-view-download")).toBeNull()
  })

  test("with nothing to download it does not ask for a Download button", () => {
    render(<FileContentView kind="sqlite" name="app.db" />)

    expect(screen.getByText("No preview for this file type.")).toBeTruthy()
    expect(query("file-view-download")).toBeNull()
    expect(screen.queryByText(/Use Download to save it/)).toBeNull()
  })
})
