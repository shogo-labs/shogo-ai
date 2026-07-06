// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React, { Profiler } from "react"

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

mock.module("react-native", () => ({
  Image: Host,
  Platform: { OS: "web" },
  Pressable: Host,
  ScrollView: Host,
  Text: Host,
  TextInput,
  View: Host,
}))

const StubIcon = () => null
mock.module("lucide-react-native", () => ({
  __esModule: true,
  ArrowUp: StubIcon,
  Plus: StubIcon,
  Square: StubIcon,
  X: StubIcon,
  Zap: StubIcon,
  Lock: StubIcon,
  File: StubIcon,
  FileText: StubIcon,
  FolderGit2: StubIcon,
  Image: StubIcon,
  ChevronDown: StubIcon,
  ChevronUp: StubIcon,
  Trash2: StubIcon,
  Pencil: StubIcon,
  SendHorizontal: StubIcon,
  Bot: StubIcon,
  ClipboardList: StubIcon,
  MessageCircleQuestion: StubIcon,
  Check: StubIcon,
  Mic: StubIcon,
  Sparkles: StubIcon,
  Languages: StubIcon,
}))

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}))

mock.module("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
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
mock.module("../ContextTracker", () => ({ ContextTracker: () => null }))
mock.module("../../../lib/visible-models", () => ({
  resolveShortName: (modelId: string) => modelId,
  resolveTier: () => "economy",
}))
mock.module("../ModelPickerMenu", () => ({ ModelPickerMenu: () => null }))
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
  },
}))
mock.module("../../../lib/agent-fetch", () => ({ agentFetch: fetch }))
mock.module("../ChatContext", () => ({ useChatContextSafe: () => null }))
mock.module("../EnvironmentPicker", () => ({ EnvironmentPicker: () => null }))

const { ChatInput } = await import("../ChatInput")

afterEach(() => cleanup())

describe("ChatInput integration — mobile-web TextInput changes", () => {
  test("repeated same-value TextInput echoes do not cause nested update-depth failures", async () => {
    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
      originalError(...args)
    }

    try {
      render(
        <ChatInput
          onSubmit={mock(() => {})}
          isPro
          ideMode
          ideContext={{ workspaceItems: [] } as any}
          ideFileSearch={mock(async () => [])}
          placeholder="Ask Shogo..."
        />,
      )

      const input = screen.getByPlaceholderText("Ask Shogo...") as HTMLTextAreaElement

      await act(async () => {
        fireEvent.change(input, { target: { value: "@" } })
        for (let i = 0; i < 80; i += 1) {
          fireEvent.change(input, { target: { value: "@" } })
        }
      })

      expect(input.value).toBe("@")
      expect(
        errors.some((args) => String(args[0] ?? "").includes("Maximum update depth exceeded")),
      ).toBe(false)
    } finally {
      console.error = originalError
    }
  })

  test("repeated identical selection events on an active mention token do not re-render repeatedly", async () => {
    let commits = 0

    render(
      <Profiler id="chat-input" onRender={() => { commits += 1 }}>
        <ChatInput
          onSubmit={mock(() => {})}
          isPro
          ideMode
          ideContext={{ workspaceItems: [] } as any}
          ideFileSearch={mock(async () => [])}
          placeholder="Ask Shogo..."
        />
      </Profiler>,
    )

    const input = screen.getByPlaceholderText("Ask Shogo...") as HTMLTextAreaElement

    await act(async () => {
      fireEvent.change(input, { target: { value: "@ali" } })
    })
    const commitsAfterTyping = commits

    input.selectionStart = 4
    input.selectionEnd = 4

    await act(async () => {
      for (let i = 0; i < 50; i += 1) {
        fireEvent.select(input)
      }
    })

    expect(input.value).toBe("@ali")
    expect(commits).toBe(commitsAfterTyping)
  })
})
