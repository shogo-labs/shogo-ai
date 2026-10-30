// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-255: a message typed into a window that opened onto an already-streaming
 * turn must leave the composer on the first Enter.
 *
 * The e2e trace showed the composer keeping the text and no request going out.
 * Two things had to hold for that to happen, and this file guards both:
 *
 *   1. Enter submits what the textarea SHOWS, not a stale state value, even
 *      when the change and the Enter land back-to-back (how `fill` + Enter
 *      arrive) while the parent re-renders `isStreaming` every few ms. The
 *      guard reads `pendingTextChangeRef`/`inputValueRef`, so a coalesced
 *      flush or a late render can't make it see an empty composer.
 *   2. Nothing steals focus out from under the composer while the transcript
 *      follows the stream. That was the actual cause: react-native-web's
 *      ScrollView dismissed the keyboard on every scroll event of the
 *      auto-following transcript, blurring the textarea milliseconds after it
 *      was focused, so the Enter landed on `<body>` and `handleSubmit` never
 *      ran. See `lib/__tests__/composer-keyboard-dismiss.test.ts` and
 *      `composer-focus-during-stream.guard.test.ts`.
 *
 * Run from apps/mobile: bun test components/chat/__tests__/ChatInput.submit-after-fill.test.tsx
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

/**
 * Stands in for react-native-web's TextInput: a multiline textarea whose
 * `onKeyPress` fires on keydown and — exactly like RNW — whose
 * `onSubmitEditing` is NOT called for Enter, because `multiline` with
 * `blurOnSubmit: false` is the only path that reaches it.
 */
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
        onKeyPress?.({
          nativeEvent: { key: event.key, shiftKey: event.shiftKey },
          preventDefault: () => event.preventDefault(),
        })
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
    // Desktop chrome: the phone layout renders the prominent composer, which
    // has its own (newline-on-Return) keyboard behaviour.
    useWindowDimensions: () => ({ width: 1280, height: 800 }),
    View: Host,
  }),
)

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
  },
}))
mock.module("../../../lib/agent-fetch", () => ({ agentFetch: fetch }))
mock.module("../ChatContext", () => ({ useChatContextSafe: () => null }))
mock.module("../EnvironmentPicker", () => ({ EnvironmentPicker: () => null }))
mock.module("../../../hooks/useWorkspaceExperience", () => ({
  useWorkspaceExperience: () => ({ kind: "team" }),
}))

const { ChatInput } = await import("../ChatInput")

afterEach(() => cleanup())

const TEXT = "[[e2e:long:tag=fb:n=60:ms=10]] follow-up"

/**
 * The chat panel of a window that opened onto a live turn: its streaming
 * state (and everything else a token tick touches) re-renders every few ms,
 * so the composer sits in the same re-render storm CI showed.
 */
function StreamingParent({
  onSubmit,
  tickMs,
}: {
  onSubmit: (text: string) => void
  tickMs: number
}) {
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), tickMs)
    return () => clearInterval(id)
  }, [tickMs])
  return (
    <ChatInput
      onSubmit={onSubmit}
      isStreaming={tick % 2 === 0}
      isPro
      ideMode
      ideContext={{ workspaceItems: [] } as any}
      ideFileSearch={mock(async () => [])}
      placeholder="Ask Shogo..."
    />
  )
}

function renderStreaming(onSubmit: (text: string) => void, tickMs = 5) {
  render(<StreamingParent onSubmit={onSubmit} tickMs={tickMs} />)
  return screen.getByTestId("project-composer-input") as HTMLTextAreaElement
}

describe("ChatInput — Enter after a fill-style change while a turn streams", () => {
  test("submits the full text once and clears the composer", async () => {
    const onSubmit = mock((_text: string) => {})
    const input = renderStreaming(onSubmit)
    // Let the streaming re-renders get going before the user types.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })

    await act(async () => {
      // `fill` sets the whole value and dispatches ONE input event; the Enter
      // follows in the same task, with no frame in between.
      fireEvent.change(input, { target: { value: TEXT } })
      fireEvent.keyDown(input, { key: "Enter", shiftKey: false })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(onSubmit.mock.calls.map((c) => c[0])).toEqual([TEXT])
    expect(input.value).toBe("")
  })

  test("a change still sitting in a coalesced flush is not seen as empty", async () => {
    const onSubmit = mock((_text: string) => {})
    const input = renderStreaming(onSubmit, 1)

    await act(async () => {
      // A burst of distinct keystrokes in one unyielded turn (the path that
      // buffers into `pendingTextChangeRef`), then Enter before the frame
      // that would have flushed it.
      let acc = ""
      for (const ch of TEXT) {
        acc += ch
        fireEvent.change(input, { target: { value: acc } })
      }
      fireEvent.keyDown(input, { key: "Enter", shiftKey: false })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(onSubmit.mock.calls.map((c) => c[0])).toEqual([TEXT])
    expect(input.value).toBe("")
  })

  test("shift+Enter does not submit", async () => {
    const onSubmit = mock((_text: string) => {})
    const input = renderStreaming(onSubmit)

    await act(async () => {
      fireEvent.change(input, { target: { value: TEXT } })
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(input.value).toBe(TEXT)
  })
})
