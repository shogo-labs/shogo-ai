// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A Markdown file on a phone (SHOGO-ANDROID-1A / SHOGO-IOS-V).
 *
 * The markdown body used to build its Preview / Source tabs from raw DOM
 * `<button>`s, and its native branch put them inside a `<View>`. Neither tag
 * has a native view config, so opening any `.md` from chat or the files browser
 * crashed with "View config getter callback for component `button`".
 *
 * `Pressable` is mocked as a `<div role="button">` here — the shared mock
 * renders `<button>`, which would make "no host button in the tree"
 * unassertable. With the two telling apart, a raw `<button>` left anywhere in
 * the native markdown tree fails the first test.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" } as never,
    Pressable: (({
      children,
      onPress,
      testID,
      accessibilityRole,
      ...props
    }: {
      children?: React.ReactNode
      onPress?: () => void
      testID?: string
      accessibilityRole?: string
    }) => (
      <div {...props} data-testid={testID} role={accessibilityRole ?? "button"} onClick={() => onPress?.()}>
        {children}
      </div>
    )) as never,
  }),
)

mock.module("../../project/panels/ide/CodeEditor", () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}))

mock.module("../../project/panels/ide/FilePreview", () => ({
  FilePreview: ({ kind }: { kind: string }) => <div data-testid="file-preview" data-kind={kind} />,
  previewLanguageFor: () => null,
}))

mock.module("../../chat/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}))

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react")
const { FileContentView } = await import("../FileContentView")

afterEach(() => {
  cleanup()
})

const query = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe("a Markdown file on a phone", () => {
  test("its tabs are RN primitives, never a host `button`", () => {
    render(<FileContentView kind="markdown" name="README.md" text={"# Hello"} />)

    expect(query("ide-md-mode-preview")).toBeTruthy()
    expect(query("file-view-md-mode-source")).toBeTruthy()
    expect(document.querySelectorAll("button")).toHaveLength(0)
  })

  test("the Source tab switches from the rendered markdown to the text", () => {
    render(<FileContentView kind="markdown" name="README.md" text={"# Hello"} />)

    expect(query("markdown-body")!.textContent).toBe("# Hello")

    fireEvent.click(query("file-view-md-mode-source")!)

    expect(query("markdown-body")).toBeNull()
    expect(screen.getByText("# Hello")).toBeTruthy()
  })

  test("an editable file labels the tab Edit and stays in preview until tapped", () => {
    render(<FileContentView kind="markdown" name="NOTES.md" text={"hello"} readOnly={false} />)

    expect(screen.getByText("Edit")).toBeTruthy()
    expect(query("markdown-body")).toBeTruthy()

    fireEvent.click(query("ide-md-mode-edit")!)
    expect(query("markdown-body")).toBeNull()

    fireEvent.click(query("ide-md-mode-preview")!)
    expect(query("markdown-body")!.textContent).toBe("hello")
  })
})
