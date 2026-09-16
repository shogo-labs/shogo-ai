// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React, { Profiler } from "react"
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

// Icons come from the shared stub that `test/testing-library.ts` preloads.
// A per-file `mock.module('lucide-react-native', …)` would narrow the module
// process-wide and strip every icon it omits for later test files.

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
mock.module("../../../lib/native-attachment-picker", () => ({
  executeNativeAttachAction: () => {},
}))
mock.module("../ContextTracker", () => ({
  ContextTracker: () => null,
  // `ContextBreakdownPanel` (rendered by the dock's `ContextUsageDockPanel`,
  // now part of `ChatInput`'s tree) imports this alongside the component.
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
let mentionHistoryResults: any[] = []
mock.module("@shogo-ai/sdk/agent", () => ({
  AgentClient: class {
    getWorkspaceTree = mock(async () => [])
    searchFiles = mock(async () => [])
    searchHistory = mock(async () => mentionHistoryResults)
  },
}))
mock.module("../../../lib/agent-fetch", () => ({ agentFetch: fetch }))
let chatContext: any = null
mock.module("../ChatContext", () => ({ useChatContextSafe: () => chatContext }))
mock.module("../EnvironmentPicker", () => ({ EnvironmentPicker: () => null }))

const { ChatInput } = await import("../ChatInput")

afterEach(() => {
  cleanup()
  mentionHistoryResults = []
  chatContext = null
})

describe("ChatInput integration — chat and plan mentions", () => {
  test("renders Chats and Plans sections and submits structured references", async () => {
    mentionHistoryResults = [
      { kind: "chat", id: "chat-1", title: "SQLite decision", snippet: "Use SQLite", score: 1, projectId: "project-1" },
      { kind: "plan", id: "plan-1", title: "History Search", filename: "history.plan.md", snippet: "Search", score: 1, projectId: "project-1" },
    ]
    chatContext = { agentUrl: "http://runtime.test" }
    const onSubmit = mock(() => {})
    render(<ChatInput onSubmit={onSubmit} isPro />)
    const input = screen.getByTestId("project-composer-input") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(input, { target: { value: "@" } })
      await new Promise((resolve) => setTimeout(resolve, 240))
    })
    expect(screen.getByText("Chats")).toBeTruthy()
    expect(screen.getByText("Plans")).toBeTruthy()
    // Both mention results render while the "@" dropdown is open. Assert the
    // plan item's title BEFORE selecting the chat item below — clicking a
    // mention closes the dropdown, so "History Search" (only rendered inside
    // it) would no longer be in the DOM afterward.
    expect(screen.getByText("History Search")).toBeTruthy()
    fireEvent.click(screen.getByText("SQLite decision"))
    expect(input.value).toContain("@chat:chat-1")
  })
})

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

      const input = screen.getByTestId("project-composer-input") as HTMLTextAreaElement

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

    const input = screen.getByTestId("project-composer-input") as HTMLTextAreaElement

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
