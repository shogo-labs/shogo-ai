// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Add to Chat" insertion (#1082): references from the IDE tree/editor,
 * terminal and Shogo Code are inserted at the caret as inline pills, never
 * replacing the draft or its attachments, and travel with the message.
 */
// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import { CHAT_REFS_MIME, encodeChatDragPayload } from "../../../lib/chat-drag"

const Host = React.forwardRef<HTMLElement, any>(function Host(
  { accessibilityLabel, children, keyboardShouldPersistTaps: _k, onPress, pointerEvents: _p, style: _style, testID, ...props },
  ref,
) {
  return React.createElement(
    "div",
    { ...props, "aria-label": accessibilityLabel, "data-testid": testID, onClick: onPress ?? props.onClick, ref },
    children,
  )
})

const TextInput = React.forwardRef<HTMLTextAreaElement, any>(function TextInput(
  {
    accessibilityLabel,
    blurOnSubmit: _blurOnSubmit,
    editable = true,
    multiline: _multiline,
    onChange,
    onChangeText,
    onContentSizeChange: _onContentSizeChange,
    onKeyPress,
    onSelectionChange,
    onSubmitEditing,
    placeholderTextColor: _placeholderTextColor,
    returnKeyType: _returnKeyType,
    style: _style,
    testID,
    textAlignVertical: _textAlignVertical,
    selection: _selection,
    ...props
  },
  ref,
) {
  return (
    <textarea
      {...props}
      aria-label={accessibilityLabel}
      data-testid={testID}
      disabled={!editable}
      ref={ref}
      onChange={(event) => {
        onChange?.(event)
        onChangeText?.(event.currentTarget.value)
      }}
      onKeyDown={(event) => {
        // Web: the composer submits from its own Enter key handler.
        void onSubmitEditing
        onKeyPress?.({ nativeEvent: { key: event.key, shiftKey: event.shiftKey }, preventDefault: () => event.preventDefault() })
      }}
      onSelect={(event) => {
        onSelectionChange?.({
          nativeEvent: {
            selection: { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd },
            text: event.currentTarget.value,
          },
        })
      }}
    />
  )
})

mock.module("react-native", () =>
  createReactNativeMock({
    Image: Host,
    Platform: { OS: "web" },
    Pressable: Host,
    ScrollView: Host,
    Text: Host,
    TextInput,
    useWindowDimensions: () => ({ width: 1280, height: 900 }),
    View: Host,
  } as any),
)
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: any[]) => args.filter(Boolean).join(" ") }))
mock.module("@/components/ui/popover", () => ({
  Popover: ({ children, trigger }: { children?: React.ReactNode; trigger?: (p: Record<string, unknown>) => React.ReactNode }) => (
    <>
      {trigger?.({})}
      {children}
    </>
  ),
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
mock.module("../../../lib/platform-config", () => ({ usePlatformConfig: () => ({ features: { billing: false, ezMode: false } }) }))
mock.module("../useVoiceInput", () => ({
  useVoiceInput: () => ({ isBusy: false, isRecording: false, liveTranscript: "", start: mock(async () => {}), stop: mock(async () => {}) }),
}))
mock.module("../VoiceWaveform", () => ({ VoiceWaveform: () => null }))
mock.module("../AttachSourceSheet", () => ({ AttachSourceSheet: () => null }))
mock.module("../../../lib/native-attachment-picker", () => ({ executeNativeAttachAction: () => {} }))
mock.module("../ContextTracker", () => ({ ContextTracker: () => null, formatTokenCount: (t: number) => String(t) }))
mock.module("../../../lib/visible-models", () => ({ resolveShortName: (m: string) => m, resolveTier: () => "economy" }))
mock.module("../ModelPickerMenu", () => ({ ModelPickerMenu: () => null, ComposerModelPicker: () => null, getNativeModelMenuWidth: () => 280 }))
mock.module("../FileViewerModal", () => ({ FileViewerModal: () => null }))
mock.module("../PastedTextChip", () => ({ PastedTextChip: () => null }))
mock.module("../../voice-mode/ChatBridgeContext", () => ({ useChatBridgeOptional: () => null }))
mock.module("../turns/AskUserQuestionWidget", () => ({ AskUserQuestionWidget: () => null }))
mock.module("@shogo-ai/sdk/agent", () => ({
  AgentClient: class {
    getWorkspaceTree = mock(async () => [])
    searchFiles = mock(async () => [])
    searchHistory = mock(async () => [])
  },
}))
mock.module("../../../lib/agent-fetch", () => ({ agentFetch: fetch }))
mock.module("../ChatContext", () => ({ useChatContextSafe: () => null }))
mock.module("../EnvironmentPicker", () => ({ EnvironmentPicker: () => null }))
mock.module("../../../hooks/useWorkspaceExperience", () => ({ useWorkspaceExperience: () => ({ kind: "team" }) }))

const { ChatInput } = await import("../ChatInput")
type InsertRequest = NonNullable<React.ComponentProps<typeof ChatInput>["insertRequest"]>

afterEach(() => cleanup())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const big = (start: number, end: number, text = "const x = 1") =>
  ({ type: "selection", path: "src/big.ts", name: "big.ts", startLine: start, endLine: end, text }) as const

async function typeInto(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } })
    await sleep(40)
  })
}

async function submit(input: HTMLTextAreaElement) {
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" })
    await sleep(20)
  })
}

function renderComposer(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onSubmit = mock((..._args: any[]) => {})
  const utils = render(<ChatInput onSubmit={onSubmit} isPro {...props} />)
  const input = screen.getByTestId("project-composer-input") as HTMLTextAreaElement
  return { ...utils, onSubmit, input }
}

describe("ChatInput insertRequest", () => {
  test("inserts selection and file pills without clearing the draft or pending attachments", async () => {
    const restore = {
      nonce: 1,
      content: "",
      files: [{ dataUrl: "data:text/plain;base64,Zm9v", name: "notes.txt", type: "text/plain" }],
    }
    const { input, rerender, onSubmit } = renderComposer({ restoreDraftRequest: restore })
    await typeInto(input, "please review")
    const request: InsertRequest = {
      nonce: 7,
      references: [big(120, 140), big(150, 150), { type: "file", path: "src/util.ts", name: "util.ts" }],
    }
    const onInsertApplied = mock((_nonce: number) => {})
    await act(async () => {
      rerender(<ChatInput onSubmit={onSubmit} isPro restoreDraftRequest={restore} insertRequest={request} onInsertApplied={onInsertApplied} />)
      await sleep(20)
    })
    expect(input.value).toBe("please review @big.ts:120-140 @big.ts:150 @util.ts ")
    expect(onInsertApplied).toHaveBeenCalledWith(7)

    await submit(input)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [content, files, , references] = onSubmit.mock.calls[0]
    expect(content).toContain("please review @big.ts:120-140")
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe("notes.txt")
    expect(references.map((r: any) => [r.type, r.label])).toEqual([
      ["selection", "@big.ts:120-140"],
      ["selection", "@big.ts:150"],
      ["file", "@util.ts"],
    ])
    expect(references[0]).toMatchObject({ startLine: 120, endLine: 140, text: "const x = 1", path: "src/big.ts" })
  })

  test("deleting one pill prunes only its reference", async () => {
    const { input, rerender, onSubmit } = renderComposer()
    await act(async () => {
      rerender(
        <ChatInput
          onSubmit={onSubmit}
          isPro
          insertRequest={{ nonce: 1, references: [{ type: "file", path: "src/big.ts", name: "big.ts" }, big(10, 20)] }}
        />,
      )
      await sleep(20)
    })
    expect(input.value).toBe("@big.ts @big.ts:10-20 ")
    // Remove the whole-file pill; its label is a prefix of the selection's.
    await typeInto(input, "@big.ts:10-20 ")
    await submit(input)
    const references = onSubmit.mock.calls[0][3]
    expect(references.map((r: any) => r.label)).toEqual(["@big.ts:10-20"])
  })

  test("the same nonce is applied once, even across re-renders", async () => {
    const { input, rerender, onSubmit } = renderComposer()
    const request: InsertRequest = { nonce: 3, text: "$ ls\nfile.txt" }
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        rerender(<ChatInput onSubmit={onSubmit} isPro insertRequest={{ ...request }} />)
        await sleep(10)
      })
    }
    expect(input.value).toBe("$ ls\nfile.txt ")
  })

  test("terminal text is inserted at the caret, keeping what the user typed", async () => {
    const { input, rerender, onSubmit } = renderComposer()
    await typeInto(input, "explain this: ")
    await act(async () => {
      rerender(<ChatInput onSubmit={onSubmit} isPro insertRequest={{ nonce: 1, text: "error: ENOENT" }} />)
      await sleep(20)
    })
    expect(input.value).toBe("explain this: error: ENOENT ")
  })

  test("over-long selections are clamped and flagged truncated", async () => {
    const { input, rerender, onSubmit } = renderComposer()
    await act(async () => {
      rerender(<ChatInput onSubmit={onSubmit} isPro insertRequest={{ nonce: 1, references: [big(1, 900, "x".repeat(30_000))] }} />)
      await sleep(20)
    })
    await submit(input)
    const [ref] = onSubmit.mock.calls[0][3]
    expect(ref.text.length).toBe(24_000)
    expect(ref.truncated).toBe(true)
  })
})

describe("ChatInput reference drop", () => {
  function dropEvent(type: string, payload?: string) {
    const event = new Event(type, { bubbles: true, cancelable: true }) as any
    const data: Record<string, string> = payload ? { [CHAT_REFS_MIME]: payload } : {}
    event.dataTransfer = {
      types: Object.keys(data),
      files: [],
      dropEffect: "none",
      getData: (t: string) => data[t] ?? "",
    }
    return event
  }

  // Drag events bubble from the textarea to the drop-zone container.
  async function dispatch(target: HTMLElement, event: Event) {
    await act(async () => {
      target.dispatchEvent(event)
      await sleep(10)
    })
    return event as any
  }

  test("dropping tree items adds agent-workspace references and reports skipped ones", async () => {
    const { input } = renderComposer()
    await typeInto(input, "look at")
    const payload = encodeChatDragPayload([
      { kind: "file", path: "src/big.ts", name: "big.ts", rootId: "agent" },
      { kind: "folder", path: "src/ide", name: "ide", rootId: "agent" },
      { kind: "file", path: "README.md", name: "README.md", rootId: "local:repo:1" },
    ])
    const enter = await dispatch(input, dropEvent("dragenter", payload))
    expect(enter.defaultPrevented).toBe(true)
    expect(screen.getByText("Drop to add as context")).toBeTruthy()
    const over = await dispatch(input, dropEvent("dragover", payload))
    expect(over.dataTransfer.dropEffect).toBe("copy")
    await dispatch(input, dropEvent("drop", payload))
    expect(input.value).toBe("look at @big.ts @ide ")
    expect(screen.getByText(/Only files in the project workspace can be added as references — skipped: README\.md\./)).toBeTruthy()
    expect(screen.queryByText("Drop to add as context")).toBeNull()
  })

  test("an OS file drag shows the attachment overlay text", async () => {
    const { input } = renderComposer()
    const enter = dropEvent("dragenter")
    enter.dataTransfer.types = ["Files"]
    await dispatch(input, enter)
    expect(screen.getByText("Drop files to attach")).toBeTruthy()
  })
})
