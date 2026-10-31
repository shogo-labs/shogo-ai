// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 AC 5 / 8 — the in-place editor itself.
 *
 * Two things QA called out as unguarded: an outside click must close an
 * unchanged editor but never a changed one, and a send must publish the draft
 * to the context (so a failed truncate can re-mount it) and surface the API
 * error instead of rejecting into the void.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { act, fireEvent, render } from "@testing-library/react"
import { createElement, forwardRef, useImperativeHandle } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const mockAt = (relative: string, factory: () => unknown) =>
  mock.module(resolve(import.meta.dir, relative), factory as any)

let composerProps: any = null

mock.module("react-native", () =>
  createReactNativeMock({
    View: ({ children, ...rest }: any) =>
      createElement("div", { ...rest, style: undefined }, children),
    Text: ({ children, ...rest }: any) =>
      createElement("span", { ...rest, style: undefined }, children),
    Pressable: ({ onPress, children, disabled, ...rest }: any) =>
      createElement(
        "button",
        { ...rest, disabled, style: undefined, onClick: onPress },
        children,
      ),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }))
mockAt("../../ChatInput.tsx", () => ({
  ChatInput: forwardRef(function FakeChatInput(props: any, ref: any) {
    composerProps = props
    useImperativeHandle(ref, () => ({ submit: () => props.onSubmit("x", []) }))
    return createElement("div", { "data-testid": "composer" })
  }),
}))

const { InlineMessageEditor } = await import("../InlineMessageEditor")
const { EditContextHost } = await import("./editContextFixture")

const CHECKPOINT = {
  id: "cp1",
  projectId: "p1",
  createdAt: new Date(Date.now() - 180_000).toISOString(),
  filesChanged: 2,
  includesDb: false,
}

function renderEditor(overrides: Record<string, any> = {}) {
  const calls = { cancel: 0 }
  const element = createElement(EditContextHost, {
    editingMessageId: "u1",
    countMessagesAfter: () => 2,
    ...overrides,
    children: createElement(InlineMessageEditor as any, {
      messageId: "u1",
      originalText: "hello world",
      originalFiles: undefined,
      discardCount: 2,
      checkpoint: CHECKPOINT,
      streaming: false,
      error: null,
      onCancel: () => {
        calls.cancel += 1
      },
      onSubmit: overrides.onSubmit ?? (async () => {}),
    }),
  })
  return { view: render(element), calls }
}

function typeDraft(text: string) {
  act(() => {
    composerProps.onComposerDraftChange({ text, fileCount: 0 })
  })
}

describe("InlineMessageEditor — outside click (AC 5)", () => {
  beforeEach(() => {
    composerProps = null
  })

  test("closes an unchanged editor", () => {
    const { calls } = renderEditor()
    fireEvent.mouseDown(document.body)
    expect(calls.cancel).toBe(1)
  })

  test("never closes (or loses) a changed draft", () => {
    const { calls } = renderEditor()
    typeDraft("hello world, edited a lot")
    fireEvent.mouseDown(document.body)
    expect(calls.cancel).toBe(0)
  })

  test("Escape still cancels a changed draft", () => {
    const { calls } = renderEditor()
    typeDraft("hello world, edited a lot")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(calls.cancel).toBe(1)
  })
})

describe("InlineMessageEditor — send (AC 8)", () => {
  beforeEach(() => {
    composerProps = null
  })

  test("publishes the draft before dispatching and clears it on success", async () => {
    const seen: any[] = []
    renderEditor({ onPendingEdit: (next: any) => seen.push(next) })
    typeDraft("hello world, edited")

    await act(async () => {
      composerProps.onSubmit("hello world, edited", [])
    })

    expect(seen[0]).toMatchObject({
      messageId: "u1",
      content: "hello world, edited",
      error: null,
    })
    expect(seen.at(-1)).toBeNull()
  })

  test("swallows a rejected send and keeps the draft published", async () => {
    const seen: any[] = []
    renderEditor({
      onPendingEdit: (next: any) => seen.push(next),
      onSubmit: async () => {
        throw new Error("truncate-from failed (500)")
      },
    })
    typeDraft("hello world, edited")

    await act(async () => {
      // The composer's onSubmit wrapper must swallow the rejection; an
      // unhandled promise here would fail the suite.
      composerProps.onSubmit("hello world, edited", [])
    })

    // The draft stays in the context (EditableUserMessage fills in the error
    // it received, which the editor reads back as its `error` prop).
    expect(seen.at(-1)).toMatchObject({
      messageId: "u1",
      content: "hello world, edited",
    })
  })

  test("the button reads Revert & resend when files will be reverted", () => {
    const { view } = renderEditor()
    expect(view.getByText("Revert & resend")).toBeTruthy()
    expect(view.getByRole("checkbox")).toBeTruthy()
  })

  test("the button reads Resend with the revert box unchecked", () => {
    const { view } = renderEditor()
    fireEvent.click(view.getByRole("checkbox"))
    expect(view.getByText("Resend")).toBeTruthy()
  })
})
