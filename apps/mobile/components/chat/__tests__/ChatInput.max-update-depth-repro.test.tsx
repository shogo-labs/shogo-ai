// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * REPRODUCTION + REGRESSION GUARD for the Sentry "Maximum update depth
 * exceeded" cluster on `apps/mobile/components/chat/ChatInput.tsx`
 * (JAVASCRIPT-REACT-3C, and the sibling instances -41/-3W/-4D/-49/-3M that
 * share the same React error #185 signature elsewhere in the chat surface).
 *
 * `ChatInput.integration.test.tsx` already guards two NARROW cases from a
 * prior investigation: repeated IDENTICAL `onChangeText` echoes, and
 * repeated IDENTICAL `onSelectionChange` events on a stable mention token —
 * both already short-circuited by equality checks in the component. This
 * file investigates ordinary, non-degenerate usage (real, distinct text
 * every keystroke) to find the actual trigger.
 *
 * FINDING (before the fix below): typing a normal sentence one character at
 * a time reliably threw "Maximum update depth exceeded" at the crash site
 * from production (`ChatInput.tsx`'s `setInputValue(change.text)` call
 * inside `handleChangeText`) — but ONLY when ~50+ distinct `onChangeText`
 * dispatches landed back-to-back without the render pipeline ever settling
 * to idle in between. Three control experiments ruled out a real
 * per-keystroke infinite loop living inside ChatInput itself:
 *   1. A React Profiler showed exactly ONE commit per distinct keystroke —
 *      no runaway re-render chain from any single change.
 *   2. Dispatching the identical full sentence with each keystroke in its
 *      OWN settled render cycle (mirroring one browser task per native
 *      `input` event) never threw, even with a concurrent sibling
 *      component re-rendering at high frequency on the same root (a stand-in
 *      for `ChatPanel`'s frequent `onData`-driven `setMessages` /
 *      `setRunningProcesses` calls while a turn is streaming).
 *   3. The crash required DISTINCT values — replaying the SAME value in a
 *      tight loop (already covered by the existing integration test) never
 *      tripped it, because `resolveChatInputTextChange` short-circuits to
 *      `{ type: "unchanged" }` and never calls `setState`.
 *
 * ROOT CAUSE: React's nested-update safety counter (present in production
 * too — Sentry shows it as "Minified React error #185") tripping from a
 * genuine BURST of many legitimately-different updates landing in the same
 * unyielded batch, not an infinite loop in any single effect. In production
 * this plausibly happens when the main thread is busy (e.g. heavy
 * Streamdown/markdown re-rendering during an active stream) long enough for
 * the browser to queue up several keystrokes, then dispatch them
 * back-to-back once the thread frees up.
 *
 * FIX: `handleChangeText` now coalesces "text" changes into at most one
 * `setInputValue`/`setInputHeight`/mention-state commit per animation frame
 * (see the comment above `flushPendingTextChange` in `ChatInput.tsx`), so a
 * burst of N raw dispatches produces at most one commit per frame instead
 * of N commits — bounding the nested-update pressure regardless of burst
 * size. `inputValueRef` and `composerDisplayValue` still track the FRESHEST
 * text synchronously, so nothing is visually delayed.
 *
 * Run: bun test components/chat/__tests__/ChatInput.max-update-depth-repro.test.tsx
 * (must run from apps/mobile/ so the bunfig happy-dom + RTL preload loads)
 */
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

/** Stands in for `ChatPanel`'s frequent `onData`-driven state updates
 * (`setMessages`, `setRunningProcesses`, etc.) firing on the same root while
 * a turn streams — without touching ChatInput at all. */
function StreamingSibling({ tickMs }: { tickMs: number }) {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), tickMs)
    return () => clearInterval(id)
  }, [tickMs])
  return null
}

describe("ChatInput — Maximum update depth exceeded regression guard", () => {
  test("FIXED: ~65 distinct keystrokes dispatched in one unyielded burst no longer throws", async () => {
    const input = renderChatInput()
    const sentence = "Please refactor the billing service to use the new usage wallet"

    await act(async () => {
      let acc = ""
      for (const ch of sentence) {
        acc += ch
        // No `await` between dispatches: all ~65 keystrokes are queued and
        // flushed as one continuous batch, exactly like a browser whose
        // main thread was busy long enough to buffer several native
        // `input` events and then fire them back-to-back. Before the fix,
        // this threw "Maximum update depth exceeded" partway through.
        fireEvent.change(input, { target: { value: acc } })
      }
      // Let the coalesced rAF flush(es) settle before asserting.
      await new Promise((r) => setTimeout(r, 32))
    })

    expect(input.value).toBe(sentence)
  })

  test("CONTROL 1: the same value repeated (no state actually changes) never throws — existing short-circuit holds", async () => {
    const input = renderChatInput()
    await act(async () => {
      for (let i = 0; i < 80; i += 1) {
        fireEvent.change(input, { target: { value: "@" } })
      }
    })
    expect(input.value).toBe("@")
  })

  test("CONTROL 2: coalescing collapses a burst into far fewer commits than raw keystrokes (Profiler)", async () => {
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
    const sentence = "Please refactor the billing service to use the new usage wallet"

    const commitsBeforeBurst = commits
    await act(async () => {
      let acc = ""
      for (const ch of sentence) {
        acc += ch
        // Same unyielded burst as the main regression test above.
        fireEvent.change(input, { target: { value: acc } })
      }
      await new Promise((r) => setTimeout(r, 32))
    })
    const burstCommits = commits - commitsBeforeBurst

    // Every one of the `sentence.length` raw dispatches used to produce its
    // own commit (that's what tripped the nested-update limit); coalescing
    // should now collapse the whole burst into a small, roughly frame-bound
    // number of commits regardless of how many keystrokes fed it.
    expect(burstCommits).toBeGreaterThan(0)
    expect(burstCommits).toBeLessThan(sentence.length)
    expect(input.value).toBe(sentence)
  })

  test("CONTROL 3: full sentence typed with one FULLY SETTLED render per keystroke never throws, even with a concurrent high-frequency sibling on the same root", async () => {
    render(
      <>
        <StreamingSibling tickMs={2} />
        <ChatInput
          onSubmit={mock(() => {})}
          isPro
          ideMode
          ideContext={{ workspaceItems: [] } as any}
          ideFileSearch={mock(async () => [])}
          placeholder="Ask Shogo..."
        />
      </>,
    )
    const input = screen.getByPlaceholderText("Ask Shogo...") as HTMLTextAreaElement
    const sentence = "Please refactor the billing service to use the new usage wallet"

    let acc = ""
    for (const ch of sentence) {
      acc += ch
      // Each keystroke gets its OWN act() — mirroring one browser task per
      // native `input` event — while the sibling's 2ms interval keeps firing
      // unrelated updates on the same root in between.
      await act(async () => {
        fireEvent.change(input, { target: { value: acc } })
        await new Promise((r) => setTimeout(r, 8))
      })
    }
    expect(input.value).toBe(sentence)
    // Flush any trailing sibling interval tick scheduled just before the
    // last keystroke's act() closed, so cleanup() doesn't unmount mid-tick.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  })
})
