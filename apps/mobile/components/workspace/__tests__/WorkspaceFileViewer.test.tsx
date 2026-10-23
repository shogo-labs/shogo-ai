// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace file viewer picks one of four bodies per file: Markdown,
 * monospace text, an IDE preview (images, PDFs, media, SQLite), or a download
 * chip when nothing can render it inline.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
// Load the real preview chooser before the module is mocked below, so the
// viewer's per-type routing uses the real mapping and only the DOM stubs change.
import * as realFilePreview from "../../project/panels/ide/FilePreview"

const readFile = mock(async (_path: string): Promise<string> => "")
const readFileBlob = mock(async (_path: string): Promise<Blob> => new Blob(["x"]))

// The shared mock passes `onPress` through to a <button>, where React ignores it.
// Forward it as `onClick` so the close button can be clicked in jsdom-style tests.
const Pressable = ({ onPress, children, ...rest }: Record<string, unknown> & { onPress?: () => void }) => (
  <button {...rest} onClick={onPress}>
    {children as React.ReactNode}
  </button>
)
mock.module("react-native", () => createReactNativeMock({ Pressable: Pressable as never }))
mock.module("@shogo-ai/sdk/agent", () => ({
  AgentClient: class {
    readFile(path: string) {
      return readFile(path)
    }
    readFileBlob(path: string) {
      return readFileBlob(path)
    }
  },
}))
mock.module("../../../lib/agent-fetch", () => ({ agentFetch: () => Promise.reject(new Error("unused")) }))
mock.module("../../../contexts/theme", () => ({ useResolvedTheme: () => "dark" }))
mock.module("expo-clipboard", () => ({ setStringAsync: async () => {} }))
mock.module("../../chat/FileTypeIcon", () => ({ FileTypeIcon: () => null }))
mock.module("../../chat/MarkdownMediaNative", () => ({
  MarkdownMediaNative: ({ src }: { src: string }) => <div data-testid="native-image" data-src={src} />,
}))
mock.module("../../chat/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}))
mock.module("../../chat/turns/DownloadChip", () => ({
  DownloadChip: ({ path }: { path: string }) => (
    <button data-testid="download-chip" data-path={path}>
      Download
    </button>
  ),
}))
// Monaco would try to load its AMD bundle under happy-dom; the body's job is
// to hand it the text and the language, which the stub records.
mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({ value, language, readOnly }: { value: string; language: string; readOnly?: boolean }) => (
    <div data-testid="code-editor" data-language={language} data-readonly={String(!!readOnly)}>
      {value}
    </div>
  ),
}))
mock.module("../../project/panels/ide/FilePreview", () => ({
  FilePreview: ({ kind, url, name }: { kind: string; url: string; name: string }) => (
    <div data-testid="file-preview" data-kind={kind} data-url={url} data-name={name} />
  ),
  previewLanguageFor: realFilePreview.previewLanguageFor,
  isPreviewLanguage: realFilePreview.isPreviewLanguage,
  PREVIEW_LANGUAGES: realFilePreview.PREVIEW_LANGUAGES,
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react")
const { WorkspaceFileViewer } = await import("../WorkspaceFileViewer")

const revoked: string[] = []

/** The React Native mock renders `testID` / `accessibilityLabel` as lowercase attributes. */
function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[testid="${id}"], [data-testid="${id}"]`)
}

async function findByTestId(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(byTestId(id)).not.toBeNull())
  return byTestId(id)!
}

function byAccessibilityLabel(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[accessibilitylabel="${label}"]`)
}

beforeEach(() => {
  readFile.mockClear()
  readFileBlob.mockClear()
  readFile.mockImplementation(async () => "")
  readFileBlob.mockImplementation(async () => new Blob(["x"]))
  revoked.length = 0
  URL.createObjectURL = mock(() => "blob:preview-1") as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = mock((url: string) => {
    revoked.push(url)
  }) as unknown as typeof URL.revokeObjectURL
})

afterEach(() => {
  cleanup()
})

function open(path: string, onClose = () => {}) {
  return render(
    <WorkspaceFileViewer agentUrl="https://agent.example" path={path} nonce={1} onClose={onClose} />,
  )
}

describe("WorkspaceFileViewer", () => {
  test("shows the full path in the header", async () => {
    readFile.mockImplementation(async () => "# Hi")
    open("notes/plan.md")
    expect(screen.getAllByText("notes/plan.md").length).toBeGreaterThan(0)
    await findByTestId("workspace-file-markdown")
  })

  test("renders Markdown files as Markdown", async () => {
    readFile.mockImplementation(async () => "# Launch plan")
    open("notes/plan.md")

    const body = await screen.findByTestId("markdown-body")
    expect(body.textContent).toBe("# Launch plan")
    expect(readFile).toHaveBeenCalledWith("notes/plan.md")
    expect(byTestId("workspace-file-text")).toBeNull()
  })

  test("a Markdown file gets a read-only Source toggle", async () => {
    readFile.mockImplementation(async () => "# Launch plan")
    open("notes/plan.md")

    await screen.findByTestId("markdown-body")
    const source = document.querySelector<HTMLElement>('[data-testid="file-view-md-mode-source"]')
    expect(source).not.toBeNull()
    fireEvent.click(source!)

    const editor = document.querySelector<HTMLElement>('[data-testid="code-editor"]')
    expect(editor!.textContent).toContain("# Launch plan")
    expect(editor!.getAttribute("data-readonly")).toBe("true")
    expect(editor!.getAttribute("data-language")).toBe("markdown")
  })

  test("routes a video to the IDE's own video preview", async () => {
    open("clips/demo.mp4")

    const preview = await screen.findByTestId("file-preview")
    expect(preview.getAttribute("data-kind")).toBe("video")
    expect(readFileBlob).toHaveBeenCalledWith("clips/demo.mp4")
    expect(readFile).not.toHaveBeenCalled()
  })

  test("shows other text files in a monospace view", async () => {
    readFile.mockImplementation(async () => "export const x = 1")
    open("src/app.ts")

    const text = await findByTestId("workspace-file-text")
    expect(text.textContent).toContain("export const x = 1")
    expect(byTestId("markdown-body")).toBeNull()
  })

  test("cuts very large text files and offers a download", async () => {
    readFile.mockImplementation(async () => "a".repeat(600_000))
    open("data/big.log")

    const text = await findByTestId("workspace-file-text")
    expect(text.textContent!.startsWith("a".repeat(500_000))).toBe(true)
    expect(text.textContent!.includes("a".repeat(500_001))).toBe(false)
    expect(screen.getByText("Showing the first part of this file.")).toBeTruthy()
    expect(screen.getAllByTestId("download-chip").length).toBeGreaterThan(0)
  })

  test("routes images, PDFs and media to the IDE preview through a blob URL", async () => {
    open("photos/cat.png")

    const preview = await screen.findByTestId("file-preview")
    expect(preview.getAttribute("data-kind")).toBe("image")
    expect(preview.getAttribute("data-url")).toBe("blob:preview-1")
    expect(readFileBlob).toHaveBeenCalledWith("photos/cat.png")
    expect(readFile).not.toHaveBeenCalled()
  })

  test("revokes the blob URL when the viewer unmounts", async () => {
    const { unmount } = open("docs/report.pdf")
    await screen.findByTestId("file-preview")

    unmount()
    expect(revoked).toEqual(["blob:preview-1"])
  })

  test("shows a download chip for files with no inline preview", async () => {
    open("archive/bundle.zip")

    await findByTestId("workspace-file-unavailable")
    expect(screen.getByText("Preview not available for this file type.")).toBeTruthy()
    // The header and the fallback body each render a download chip for the file.
    const chips = screen.getAllByTestId("download-chip")
    expect(chips.length).toBe(2)
    for (const chip of chips) expect(chip.getAttribute("data-path")).toBe("archive/bundle.zip")
    expect(readFile).not.toHaveBeenCalled()
    expect(readFileBlob).not.toHaveBeenCalled()
  })

  test("says the file is missing when the agent returns 404", async () => {
    readFile.mockImplementation(async () => {
      throw new Error("Agent readFile 404: not found")
    })
    open("gone/notes.md")

    const missing = await findByTestId("workspace-file-missing")
    expect(missing.textContent).toContain("File not found")
    expect(missing.textContent).toContain("gone/notes.md")
  })

  test("shows the error message for other failures", async () => {
    readFile.mockImplementation(async () => {
      throw new Error("Agent readFile 500: boom")
    })
    open("src/app.ts")

    const error = await findByTestId("workspace-file-error")
    expect(error.textContent).toContain("Agent readFile 500: boom")
  })

  test("calls onClose from the close button", async () => {
    readFile.mockImplementation(async () => "hi")
    let closed = 0
    open("notes/a.md", () => {
      closed += 1
    })
    await findByTestId("workspace-file-markdown")

    const close = byAccessibilityLabel("Close file")
    expect(close).not.toBeNull()
    fireEvent.click(close!)
    await waitFor(() => expect(closed).toBe(1))
  })
})
