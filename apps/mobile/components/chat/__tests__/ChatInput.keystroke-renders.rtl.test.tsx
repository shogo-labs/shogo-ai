// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-314: the chat composer's keystroke path must not re-render the panel.
 *
 * A `useChatComposerMemory` hook test can only prove the hook does not
 * setState. The freeze Russell reported was the whole ChatPanel going round
 * once per character, so this mounts the real `ChatInput` wired the way
 * `ChatPanel.handleComposerTextChange` wires it (ChatInput -> onTextChange ->
 * `memory.saveDraft`) above a message list, and counts renders of both.
 *
 * The draft must still land in the composer cache: 0 renders achieved by
 * dropping the text would pass a render count and lose what the person typed.
 */

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const Host = React.forwardRef<HTMLElement, any>(function Host(
  {
    accessibilityLabel,
    children,
    keyboardShouldPersistTaps: _keyboardShouldPersistTaps,
    onPress,
    style: _style,
    testID,
    ...props
  },
  ref,
) {
  return React.createElement(
    "div",
    {
      ...props,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      onClick: onPress ?? props.onClick,
      ref,
    },
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
        const nativeEvent = { key: event.key, shiftKey: event.shiftKey }
        const wrappedEvent = {
          nativeEvent,
          preventDefault: () => event.preventDefault(),
        }
        onKeyPress?.(wrappedEvent)
        if (event.key === "Enter" && !event.shiftKey) {
          onSubmitEditing?.(wrappedEvent)
        }
      }}
      onSelect={(event) => {
        onSelectionChange?.({
          nativeEvent: {
            selection: {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            },
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
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    View: Host,
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}))

mock.module("@/components/ui/popover", () => ({
  Popover: ({
    children,
    trigger,
  }: {
    children?: React.ReactNode
    trigger?: (triggerProps: Record<string, unknown>) => React.ReactNode
  }) => (
    <>
      {trigger?.({})}
      {children}
    </>
  ),
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

mock.module("../../../lib/platform-config", () => ({
  usePlatformConfig: () => ({ features: { billing: false, ezMode: false } }),
}))

mock.module("../useVoiceInput", () => ({
  useVoiceInput: () => ({
    isBusy: false,
    isRecording: false,
    liveTranscript: "",
    start: mock(async () => {}),
    stop: mock(async () => {}),
  }),
}))

mock.module("../VoiceWaveform", () => ({ VoiceWaveform: () => null }))
mock.module("../AttachSourceSheet", () => ({ AttachSourceSheet: () => null }))
mock.module("../../../lib/native-attachment-picker", () => ({
  executeNativeAttachAction: () => {},
}))
mock.module("../ContextTracker", () => ({
  ContextTracker: () => null,
  formatTokenCount: (tokens: number) => String(tokens),
}))
mock.module("../../../lib/visible-models", () => ({
  resolveShortName: (modelId: string) => modelId,
  resolveTier: () => "economy",
}))
mock.module("../ModelPickerMenu", () => ({
  ModelPickerMenu: () => null,
  ComposerModelPicker: () => null,
  getNativeModelMenuWidth: () => 280,
}))
mock.module("../FileViewerModal", () => ({ FileViewerModal: () => null }))
mock.module("../PastedTextChip", () => ({ PastedTextChip: () => null }))
mock.module("../../voice-mode/ChatBridgeContext", () => ({
  useChatBridgeOptional: () => null,
}))
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
mock.module("../../../hooks/useWorkspaceExperience", () => ({
  useWorkspaceExperience: () => ({ kind: "team" }),
}))

const { ChatInput } = await import("../ChatInput")
const { composerMemoryKey, useChatComposerMemory } = await import(
  "../../../lib/chat-composer-memory"
)

afterEach(() => cleanup())

const ROW_COUNT = 200
let panelRenders = 0
let rowRenders = 0
let latest: { readDraft: () => { text: string } | null } | null = null

function Row({ i }: { i: number }) {
  rowRenders += 1
  return <div data-row={i}>line {i}</div>
}

/**
 * Stands in for ChatPanel: one `observer` component in the real app, with the
 * transcript above the composer and `handleComposerTextChange`'s wiring into
 * `memory.saveDraft` (ChatPanel.tsx, "Persist the composer's text").
 */
function Panel({ chatKey }: { chatKey: string }) {
  panelRenders += 1
  const memory = useChatComposerMemory(chatKey)
  latest = memory
  const onTextChange = React.useCallback(
    (text: string, references: any[]) => {
      memory.saveDraft(text, references)
    },
    [memory.saveDraft],
  )
  const onSubmit = React.useCallback(() => {}, [])
  return (
    <div>
      {Array.from({ length: ROW_COUNT }, (_, i) => (
        <Row key={i} i={i} />
      ))}
      <ChatInput onSubmit={onSubmit} isPro onTextChange={onTextChange} />
    </div>
  )
}

describe("SHO-314 composer keystroke path", () => {
  test("20 keystrokes do not re-render the panel, and the draft still lands", async () => {
    render(<Panel chatKey={composerMemoryKey("sho314-no-rerender")} />)
    const input = (await screen.findByTestId("project-composer-input")) as HTMLTextAreaElement
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    panelRenders = 0
    rowRenders = 0
    let text = ""
    for (let i = 0; i < 20; i++) {
      text += "a"
      await act(async () => {
        fireEvent.change(input, { target: { value: text } })
      })
    }

    expect(panelRenders).toBe(0)
    expect(rowRenders).toBe(0)
    // The point is saving WITHOUT rendering, not skipping the save.
    expect(latest?.readDraft()?.text).toBe("a".repeat(20))
    expect(input.value).toBe("a".repeat(20))
  }, 60000)
})
