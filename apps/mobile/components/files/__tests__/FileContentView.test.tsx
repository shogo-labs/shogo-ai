// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One body per kind: the IDE previews for media, Monaco for code, and a
 * Markdown body that viewers get a read-only Source toggle on while the IDE
 * keeps its editable one.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())

mock.module("../../project/panels/ide/FilePreview", () => ({
  FilePreview: ({ kind, url }: { kind: string; url: string }) => (
    <div data-testid="file-preview" data-kind={kind} data-url={url} />
  ),
}))

mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({
    value,
    language,
    readOnly,
    pathKey,
  }: {
    value: string
    language: string
    readOnly?: boolean
    pathKey: string
  }) => (
    <div
      data-testid="code-editor"
      data-language={language}
      data-readonly={String(!!readOnly)}
      data-path-key={pathKey}
    >
      {value}
    </div>
  ),
}))

mock.module("../../chat/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}))

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react")
const { FileContentView, viewerPathKey } = await import("../FileContentView")

afterEach(cleanup)

function query(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe("FileContentView", () => {
  test("media render through the IDE preview", () => {
    render(<FileContentView kind="video" name="clip.mp4" url="blob:1" pathKey={viewerPathKey("a")} />)

    const preview = query("file-preview")!
    expect(preview.getAttribute("data-kind")).toBe("video")
    expect(preview.getAttribute("data-url")).toBe("blob:1")
  })

  test("code renders in a read-only Monaco with the language its name implies", () => {
    render(<FileContentView kind="text" name="src/app.ts" path="src/app.ts" text="const x = 1" />)

    const editor = query("code-editor")!
    expect(editor.textContent).toBe("const x = 1")
    expect(editor.getAttribute("data-language")).toBe("typescript")
    expect(editor.getAttribute("data-readonly")).toBe("true")
    expect(editor.getAttribute("data-path-key")).toBe("viewer:src/app.ts")
  })

  test("a viewer's Markdown opens on Preview and its second button is Source", () => {
    render(<FileContentView kind="markdown" name="notes.md" path="notes.md" text="# Hi" readOnly />)

    expect(query("markdown-body")!.textContent).toBe("# Hi")
    expect(query("ide-md-mode-edit")).toBeNull()

    fireEvent.click(query("file-view-md-mode-source")!)

    const editor = query("code-editor")!
    expect(editor.textContent).toBe("# Hi")
    expect(editor.getAttribute("data-language")).toBe("markdown")
    expect(editor.getAttribute("data-readonly")).toBe("true")

    fireEvent.click(query("ide-md-mode-preview")!)
    expect(query("markdown-body")!.textContent).toBe("# Hi")
  })

  test("the IDE keeps an editable Markdown with an Edit button", () => {
    const changes: string[] = []
    render(
      <FileContentView
        kind="markdown"
        name="notes.md"
        text="# Hi"
        readOnly={false}
        pathKey="tab-1"
        onChange={(value, sourceKey) => changes.push(`${sourceKey}:${value}`)}
      />,
    )

    fireEvent.click(query("ide-md-mode-edit")!)
    const editor = query("code-editor")!
    expect(editor.getAttribute("data-readonly")).toBe("false")
    expect(editor.getAttribute("data-path-key")).toBe("tab-1")
  })

  test("binary says so, and offers the host's download", () => {
    render(
      <FileContentView
        kind="binary"
        name="bundle.zip"
        download={<button data-testid="host-download">Download</button>}
      />,
    )

    expect(screen.getByText("No preview for this file type.")).toBeTruthy()
    expect(query("host-download")).toBeTruthy()
  })
})
