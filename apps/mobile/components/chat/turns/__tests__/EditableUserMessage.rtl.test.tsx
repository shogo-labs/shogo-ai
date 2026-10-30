// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 AC 1 / 2 / 8 — the user-message bubble.
 *
 * Guards the wiring QA asked for: a selection (or a click on a link / code
 * block / mention) never opens the editor, the hover row really renders
 * Copy/Edit/Retry, and a failed resend re-mounts the editor with the user's
 * draft and the API's error instead of silently reverting to the original
 * text (the draft lives in `MessageEditContext.pendingEdit`).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import * as lucideStub from "../../../../test/stubs/lucide-react-native"

let editorProps: any = null

const mockAt = (relative: string, factory: () => unknown) =>
  mock.module(resolve(import.meta.dir, relative), factory as any)

/** Map RN accessibility props onto the DOM ones RTL queries against. */
function a11y(props: Record<string, any>) {
  const { accessibilityLabel, accessibilityRole, accessibilityHint, ...rest } =
    props
  return {
    ...rest,
    "aria-label": accessibilityLabel,
    role: accessibilityRole,
    "aria-description": accessibilityHint,
  }
}

mock.module("react-native", () =>
  createReactNativeMock({
    View: ({ onHoverIn, onHoverOut, children, style, ...rest }: any) =>
      createElement(
        "div",
        {
          ...a11y(rest),
          style: undefined,
          // react-native-web's View only whitelists the DOM mouse handlers
          // (`onMouseEnter`/`onMouseLeave`); `onHoverIn` is a Pressable prop.
          // Forward whichever the component passed, DOM handlers winning.
          onMouseEnter: rest.onMouseEnter ?? onHoverIn,
          onMouseLeave: rest.onMouseLeave ?? onHoverOut,
        },
        children,
      ),
    Text: ({ children, ...rest }: any) =>
      createElement("span", { ...a11y(rest), style: undefined }, children),
    Pressable: ({ onPress, children, disabled, ...rest }: any) =>
      createElement(
        "button",
        { ...a11y(rest), disabled, style: undefined, onClick: onPress },
        children,
      ),
    ActivityIndicator: () => createElement("div", { "data-testid": "spinner" }),
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
// ChatPanel's provider tree normally supplies this; the bubble doesn't use it,
// but its transitive imports reach for it.
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
}))
// The preload already stubs every lucide icon the app imports; keep it rather
// than replacing it with a 4-icon mock (a partial mock breaks the graph).
mock.module("lucide-react-native", () => lucideStub)
const clipboardWrites: string[] = []
mock.module("expo-clipboard", () => ({
  setStringAsync: async (text: string) => {
    clipboardWrites.push(text)
  },
}))
mock.module("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Medium: "medium" },
}))
mockAt("../../WebTooltip.tsx", () => ({
  WebTooltip: ({ children }: any) => children,
}))
mockAt("../MessageContent.tsx", () => ({
  MessageContent: ({ message }: any) =>
    createElement(
      "span",
      null,
      message.parts?.[0]?.text,
      createElement("a", { href: "#x" }, "a link"),
      createElement("code", null, "code()"),
    ),
}))
mockAt("../InlineMessageEditor.tsx", () => ({
  InlineMessageEditor: (props: any) => {
    editorProps = props
    return createElement(
      "div",
      { "data-testid": "inline-editor" },
      props.error ? createElement("span", { role: "alert" }, props.error) : null,
    )
  },
}))
mockAt("../../../../lib/native-phone-layout.ts", () => ({
  useIsNativePhoneLayout: () => false,
  usePhoneLayout: () => false,
  usePhoneLayoutOverride: () => null,
}))
mockAt("../../../layout/MobileWorkspaceChromeContext.tsx", () => ({
  useMobileWorkspaceChrome: () => false,
}))

const { EditableUserMessage } = await import("../EditableUserMessage")
const { EditContextHost, userMessage } = await import("./editContextFixture")

const MESSAGE = userMessage("u1", "hello world")

function renderRow(overrides: Record<string, unknown> = {}, message = MESSAGE) {
  editorProps = null
  return render(
    createElement(
      EditContextHost,
      overrides as any,
      createElement(EditableUserMessage as any, { message }),
    ),
  )
}

function setSelection(text: string) {
  ;(globalThis as any).getSelection = () => ({ toString: () => text })
}

describe("EditableUserMessage — display mode", () => {
  beforeEach(() => {
    clipboardWrites.length = 0
    setSelection("")
  })

  test("clicking plain text opens the in-place editor", () => {
    const view = renderRow()
    fireEvent.click(view.getByText("hello world"))
    expect(editorProps).not.toBeNull()
  })

  test("a live text selection never opens the editor (AC 1)", () => {
    setSelection("hello")
    const view = renderRow()
    fireEvent.click(view.getByText("hello world"))
    expect(editorProps).toBeNull()
  })

  test("clicking a link inside the message never opens the editor (AC 1)", () => {
    const view = renderRow()
    fireEvent.click(view.getByText("a link"))
    expect(editorProps).toBeNull()
  })

  test("clicking a code block inside the message never opens the editor (AC 1)", () => {
    const view = renderRow()
    fireEvent.click(view.getByText("code()"))
    expect(editorProps).toBeNull()
  })

  test("hover reveals Copy, Edit and Retry (AC 2)", () => {
    const view = renderRow()
    expect(view.queryByLabelText("Copy message text")).toBeNull()

    fireEvent.mouseEnter(view.getByText("hello world").closest("div")!)

    expect(view.getByLabelText("Copy message text")).toBeTruthy()
    expect(view.getByLabelText("Edit message")).toBeTruthy()
    expect(view.getByLabelText("Retry from this message")).toBeTruthy()
  })

  test("Copy puts the original message text on the clipboard (AC 2)", async () => {
    const view = renderRow()
    fireEvent.mouseEnter(view.getByText("hello world").closest("div")!)
    fireEvent.click(view.getByLabelText("Copy message text"))
    await Promise.resolve()
    expect(clipboardWrites).toEqual(["hello world"])
  })

  test("the pencil opens the editor", () => {
    const view = renderRow()
    fireEvent.mouseEnter(view.getByText("hello world").closest("div")!)
    fireEvent.click(view.getByLabelText("Edit message"))
    expect(editorProps).not.toBeNull()
  })
})

describe("EditableUserMessage — restored draft after a failed send (AC 8)", () => {
  beforeEach(() => setSelection(""))

  test("re-mounts the editor with the pending draft and the API error", () => {
    renderRow({
      editingMessageId: "u1",
      pendingEdit: {
        messageId: "u1",
        content: "hello world, edited",
        error: "truncate-from failed (500)",
      },
      countMessagesAfter: () => 3,
    })

    expect(editorProps.initialText).toBe("hello world, edited")
    expect(editorProps.error).toBe("truncate-from failed (500)")
    expect(editorProps.discardCount).toBe(3)
  })

  test("falls back to the original text when there is no pending draft", () => {
    renderRow({ editingMessageId: "u1" })
    expect(editorProps.initialText).toBeUndefined()
    expect(editorProps.error).toBeNull()
  })

  test("a failed resend records the draft and the error in the context", async () => {
    const seen: any[] = []
    renderRow({
      editingMessageId: "u1",
      editMessage: async () => {
        throw new Error("rollback failed (500)")
      },
      onPendingEdit: (next: any) => seen.push(next),
    })

    await editorProps.onSubmit(
      "hello world, edited",
      undefined,
      {},
    ).catch(() => {})

    const withError = seen.find((entry) => entry?.error)
    expect(withError?.content).toBe("hello world, edited")
    expect(withError?.error).toBe("rollback failed (500)")
    expect(withError?.messageId).toBe("u1")
  })
})

describe("EditableUserMessage — files-reverted note", () => {
  test("the note is rendered under the resent message (AC 7)", () => {
    const view = renderRow({
      revertedNotes: {
        u1: "Files reverted to the checkpoint from 3 minutes ago",
      },
    })
    expect(
      view.getByText("Files reverted to the checkpoint from 3 minutes ago"),
    ).toBeTruthy()
  })
})
