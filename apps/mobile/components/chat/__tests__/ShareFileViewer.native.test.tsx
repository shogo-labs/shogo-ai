// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A picture or a PDF opens on a phone without downloading it first. The viewer
 * decides the kind from the name, asks one byte and hands the URL to the
 * platform's own renderer — a 300 MB PDF must not be buffered to read page one
 * (SHO-388). A dead link still says the API's `code` in words.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import * as lucideStub from "../../../test/stubs/lucide-react-native"

mock.module("lucide-react-native", () => lucideStub)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("../../../lib/agent-image-source", () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios ?? options.default },
    // A phone's Image: the test only needs the URL it was handed.
    Image: ({ source, accessibilityLabel }: { source?: { uri?: string }; accessibilityLabel?: string }) => (
      <img data-testid="rn-image" data-uri={source?.uri} alt={accessibilityLabel} />
    ),
  } as never),
)

mock.module("../../chat/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}))
mock.module("../../project/panels/ide/FilePreview", () => ({
  FilePreview: ({ kind }: { kind: string }) => <div data-testid="file-preview" data-kind={kind} />,
  // `file-view-kind` classifies through this. The real one is the IDE's preview
  // registry (DOM heavy); a phone still needs its answer for a picture and a PDF.
  previewLanguageFor: (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() ?? ""
    if (ext === "pdf") return "pdf"
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"].includes(ext)) return "image"
    if (["mp4", "m4v", "webm", "mov"].includes(ext)) return "video"
    return null
  },
}))
mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}))
mock.module("react-native-webview", () => ({
  default: ({ source, testID }: { source: { uri: string }; testID?: string }) => (
    <div data-testid={testID ?? "file-view-pdf"} data-uri={source.uri} />
  ),
}))
mock.module(resolve(import.meta.dir, "../../../lib/attachment-download"), () => ({
  attachmentDownloadUrl: (url: string) => `${url}&dl=1`,
  downloadAttachment: mock(async () => {}),
}))

const { cleanup, render, waitFor } = await import("@testing-library/react")
const { ShareFileView } = await import("../ShareFileViewer")
const { resolveChatAttachmentUrl } = await import("../../../lib/chat-attachment-url")

afterEach(cleanup)

function probeResponds(body: unknown, init: ResponseInit) {
  const response = new Response(typeof body === "string" ? body : JSON.stringify(body), init)
  const blob = mock(() => Promise.reject(new Error("the body must not be downloaded")))
  response.blob = blob as unknown as typeof response.blob
  globalThis.fetch = mock(async () => response) as unknown as typeof fetch
  return blob
}

describe("a picture in the viewer on a phone", () => {
  test("renders through the URL, never through a downloaded blob", async () => {
    const blob = probeResponds("png-bytes", {
      status: 206,
      headers: { "content-type": "image/png", "content-range": "bytes 0-0/2048" },
    })

    const { container } = render(
      <ShareFileView target={{ kind: "share", href: "/api/f/tok", name: "photo.png" }} />,
    )

    const image = await waitFor(() => {
      const node = container.querySelector('[data-testid="rn-image"]')
      expect(node).toBeTruthy()
      return node!
    })
    expect(image.getAttribute("data-uri")).toBe(resolveChatAttachmentUrl("/api/f/tok"))
    expect(blob).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="file-view-binary"]')).toBeNull()
  })

  test("a dead link shows the API's code instead of a broken picture", async () => {
    probeResponds({ error: { code: "expired", message: "This download link has expired" } }, {
      status: 404,
      headers: { "content-type": "application/json" },
    })

    const { container } = render(
      <ShareFileView target={{ kind: "share", href: "/api/f/dead", name: "photo.png" }} />,
    )

    const error = await waitFor(() => {
      const node = container.querySelector('[data-rn-shim="share-file-error"]')
      expect(node).toBeTruthy()
      return node!
    })
    expect(error.textContent).toBe("Link expired — ask for a new one")
    expect(container.querySelector('[data-testid="rn-image"]')).toBeNull()
  })
})

describe("a PDF in the viewer on a phone", () => {
  test("renders in the native PDF view with the URL", async () => {
    const blob = probeResponds("%PDF-1.4", {
      status: 206,
      headers: { "content-type": "application/pdf", "content-range": "bytes 0-0/900000" },
    })

    const { container } = render(
      <ShareFileView target={{ kind: "share", href: "/api/f/pdf", name: "report.pdf" }} />,
    )

    const pdf = await waitFor(() => {
      const node = container.querySelector("[data-uri]")
      expect(node).toBeTruthy()
      return node!
    })
    expect(pdf.getAttribute("data-uri")).toBe(resolveChatAttachmentUrl("/api/f/pdf"))
    expect(blob).not.toHaveBeenCalled()
  })

  test("asks for one byte, not the file", async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response("%PDF-1.4", {
        status: 206,
        headers: { "content-type": "application/pdf", "content-range": "bytes 0-0/900000" },
      })
    }) as unknown as typeof fetch

    const { container } = render(
      <ShareFileView target={{ kind: "share", href: "/api/f/pdf", name: "report.pdf" }} />,
    )

    await waitFor(() => expect(container.querySelector("[data-uri]")).toBeTruthy())
    expect(calls[0]!.headers.get("range")).toBe("bytes=0-0")
  })
})
