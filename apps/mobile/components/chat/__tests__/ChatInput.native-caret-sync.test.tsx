// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * REGRESSION GUARD for a caret bug introduced by the `bde7ecf7e` "coalesce
 * ChatInput text-change bursts" fix, on NATIVE (iOS/Android) —
 * `ChatInput.web-caret-sync.test.tsx` covers the same regression on web,
 * since it turned out to affect both, not just native as first suspected.
 *
 * That fix deferred the `setInputValue` commit (and the mention/skill-picker
 * side effects) to `requestAnimationFrame` on EVERY keystroke, on every
 * platform, to stop a "Maximum update depth exceeded" crash (Sentry
 * JAVASCRIPT-REACT-3C) caused by bursts of `onChangeText` events piling up
 * while the JS/main thread was busy — see
 * `ChatInput.max-update-depth-repro.test.tsx`.
 *
 * But a controlled `TextInput`'s `value` prop echo landing even one frame
 * later than its `onChangeText` event breaks the caret: on native, the
 * view's own internal event-count bookkeeping desyncs and force-resets the
 * selection to the end of the text; a delayed echo can just as easily lose
 * the caret on web once some other re-render reconciles the controlled
 * `value` against a DOM node whose native selection already moved on. Since
 * the old fix deferred UNCONDITIONALLY, this reproduced on EVERY keystroke,
 * deterministically, not just under load — what a user described as "the
 * cursor always goes to the end after each letter typed" / "can only edit a
 * word one letter at a time".
 *
 * FIX: `handleChangeText` now commits synchronously by default (matching
 * pre-`bde7ecf7e` behavior, so the caret is never at risk) and only falls
 * back to the animation-frame-coalesced path once a `SYNC_BURST_LIMIT`
 * circuit breaker trips from genuinely many unyielded commits in a row —
 * ordinary typing never gets close to that limit. This test asserts the
 * native commit happens WITHOUT waiting for a `requestAnimationFrame` tick.
 *
 * Run: bun test components/chat/__tests__/ChatInput.native-caret-sync.test.tsx
 * (must run from apps/mobile/ so the bunfig happy-dom + RTL preload loads)
 */
// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"

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

// The key difference from the web-focused mock in
// `ChatInput.max-update-depth-repro.test.tsx`: `Platform.OS` is a native
// value here, exercising the synchronous (non-rAF) commit path.
mock.module("react-native", () => ({
  Image: Host,
  Platform: { OS: "ios" },
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

function renderChatInput() {
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
  return screen.getByPlaceholderText("Ask Shogo...") as HTMLTextAreaElement
}

describe("ChatInput — native caret regression guard", () => {
  test("on native, each keystroke commits synchronously (no rAF delay) so the controlled value never lags the native view", async () => {
    const input = renderChatInput()

    act(() => {
      fireEvent.change(input, { target: { value: "hello" } })
    })
    // No `await`/timer tick here at all — if this were coalesced through
    // `requestAnimationFrame` (the web path), the controlled re-render
    // wouldn't have happened yet and this assertion would fail.
    expect(input.value).toBe("hello")

    act(() => {
      fireEvent.change(input, { target: { value: "hello world" } })
    })
    expect(input.value).toBe("hello world")
  })

  test("a mid-string edit's caret position is not clobbered by a later, out-of-sync re-render", async () => {
    const input = renderChatInput()

    act(() => {
      fireEvent.change(input, { target: { value: "hello world" } })
    })
    expect(input.value).toBe("hello world")

    // Insert "X" between "hello" and " world" (native browsers update the
    // DOM value + caret BEFORE dispatching the change event).
    act(() => {
      input.value = "helloX world"
      input.setSelectionRange(6, 6)
      fireEvent.change(input, { target: { value: "helloX world" } })
    })

    expect(input.value).toBe("helloX world")
    expect(input.selectionStart).toBe(6)
  })
})
