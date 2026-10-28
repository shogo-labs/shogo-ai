// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * On phones there is no IDE preview. Images render through the chat's
 * markdown media component, Markdown renders as Markdown, and every other
 * binary falls back to the download chip.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const readFile = mock(async (_path: string): Promise<string> => "")
const readFileBlob = mock(async (_path: string): Promise<Blob> => new Blob(["x"]))

mock.module("react-native", () => createReactNativeMock({ Platform: { OS: "ios" } as never }))
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
mock.module("../../../contexts/theme", () => ({ useResolvedTheme: () => "light" }))
mock.module("expo-clipboard", () => ({ setStringAsync: async () => {} }))
mock.module("../../chat/FileTypeIcon", () => ({ FileTypeIcon: () => null }))
mock.module("../../chat/MarkdownMediaNative", () => ({
  MarkdownMediaNative: ({ src, agentUrl }: { src: string; agentUrl?: string | null }) => (
    <div data-testid="native-image" data-src={src} data-agent-url={agentUrl ?? ""} />
  ),
}))
mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
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

const { cleanup, render, screen, waitFor } = await import("@testing-library/react")
const { WorkspaceFileViewer } = await import("../WorkspaceFileViewer")

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[testid="${id}"]`)
}

async function findByTestId(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(byTestId(id)).not.toBeNull())
  return byTestId(id)!
}

beforeEach(() => {
  readFile.mockClear()
  readFileBlob.mockClear()
  readFile.mockImplementation(async () => "")
})

afterEach(() => {
  cleanup()
})

function open(path: string) {
  return render(
    <WorkspaceFileViewer agentUrl="https://agent.example" path={path} nonce={1} onClose={() => {}} />,
  )
}

describe("WorkspaceFileViewer on phones", () => {
  test("renders images through the chat media component with the agent URL", async () => {
    open("photos/cat.png")

    const image = await screen.findByTestId("native-image")
    expect(image.getAttribute("data-src")).toBe("/shogo-image?path=photos%2Fcat.png")
    expect(image.getAttribute("data-agent-url")).toBe("https://agent.example")
    expect(readFileBlob).not.toHaveBeenCalled()
  })

  test("renders Markdown as Markdown", async () => {
    readFile.mockImplementation(async () => "# Notes")
    open("notes/plan.md")

    const body = await screen.findByTestId("markdown-body")
    expect(body.textContent).toBe("# Notes")
  })

  test("falls back to the download chip for PDFs", async () => {
    open("docs/report.pdf")

    await findByTestId("workspace-file-unavailable")
    expect(readFileBlob).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    const chips = screen.getAllByTestId("download-chip")
    for (const chip of chips) expect(chip.getAttribute("data-path")).toBe("docs/report.pdf")
  })
})
