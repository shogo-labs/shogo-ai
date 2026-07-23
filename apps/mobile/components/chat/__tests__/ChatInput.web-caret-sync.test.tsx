// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * REGRESSION GUARD for the WEB half of the caret bug introduced by the
 * `bde7ecf7e` "coalesce ChatInput text-change bursts" fix — see
 * `ChatInput.native-caret-sync.test.tsx` for the full history and the
 * native half of this guard. That fix deferred every keystroke's commit to
 * `requestAnimationFrame` unconditionally, which reproduced the "cursor
 * jumps to the end after every letter" bug on web too, not just native.
 *
 * FIX: `handleChangeText` commits synchronously by default and only
 * defers once a `SYNC_BURST_LIMIT` circuit breaker trips from a genuine,
 * pathological burst of unyielded `onChangeText` calls (the actual
 * "Maximum update depth exceeded" failure mode — see
 * `ChatInput.max-update-depth-repro.test.tsx`). These tests assert:
 *   1. Ordinary typing (including mid-string edits) commits synchronously
 *      on web, so the caret is never at risk.
 *   2. A genuinely pathological burst still degrades gracefully — no
 *      crash, and the final committed value is correct once it settles —
 *      even though the burst-guard's slow path is momentarily active.
 *
 * Run: bun test components/chat/__tests__/ChatInput.web-caret-sync.test.tsx
 * (must run from apps/mobile/ so the bunfig happy-dom + RTL preload loads)
 */
// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"

mock.module("react-native", () => {
  const RNW = require("react-native-web")
  return {
    Image: RNW.Image,
    Platform: RNW.Platform,
    Pressable: RNW.Pressable,
    ScrollView: RNW.ScrollView,
    Text: RNW.Text,
    TextInput: RNW.TextInput,
    View: RNW.View,
  }
})

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
  Popover: ({ children }: any) => <>{children}</>,
  PopoverBackdrop: () => null,
  PopoverContent: ({ children }: any) => <>{children}</>,
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

describe("ChatInput — web caret regression guard", () => {
  test("ordinary keystrokes commit synchronously on web (no rAF delay)", () => {
    const input = renderChatInput()

    act(() => {
      fireEvent.change(input, { target: { value: "hello" } })
    })
    // No `await`/timer tick — if this were unconditionally coalesced
    // through `requestAnimationFrame`, the controlled re-render wouldn't
    // have happened yet and this assertion would fail.
    expect(input.value).toBe("hello")

    act(() => {
      fireEvent.change(input, { target: { value: "hello world" } })
    })
    expect(input.value).toBe("hello world")
  })

  test("a mid-string edit's caret position is not clobbered on web", () => {
    const input = renderChatInput()

    act(() => {
      fireEvent.change(input, { target: { value: "hello world" } })
    })
    expect(input.value).toBe("hello world")

    // Insert "X" between "hello" and " world" (real browsers update the
    // DOM value + caret BEFORE dispatching the change event).
    act(() => {
      input.focus()
      input.setSelectionRange(5, 5)
      input.value = "helloX world"
      input.setSelectionRange(6, 6)
      fireEvent.change(input, { target: { value: "helloX world" } })
    })

    expect(input.value).toBe("helloX world")
    expect(input.selectionStart).toBe(6)
  })

  test("a sequence of individually-settled keystrokes never loses the caret", async () => {
    const input = renderChatInput()

    await act(async () => {
      fireEvent.change(input, { target: { value: "hello world" } })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(input.value).toBe("hello world")

    // Repeatedly insert a character at a fixed mid-string position, each
    // as its own settled turn — mirrors a user editing a word one letter
    // at a time. Every single one must land at the expected caret.
    for (let i = 0; i < 5; i++) {
      const before = input.value
      const caretPos = 5
      const next = before.slice(0, caretPos) + "X" + before.slice(caretPos)
      await act(async () => {
        input.focus()
        input.setSelectionRange(caretPos, caretPos)
        input.value = next
        input.setSelectionRange(caretPos + 1, caretPos + 1)
        fireEvent.change(input, { target: { value: next } })
        await new Promise((r) => setTimeout(r, 15))
      })
      expect(input.value).toBe(next)
      expect(input.selectionStart).toBe(caretPos + 1)
    }
  })

  test("a genuinely pathological burst (>SYNC_BURST_LIMIT unyielded changes) still settles to the correct final value without crashing", async () => {
    const input = renderChatInput()
    const sentence = "Please refactor the billing service to use the new usage wallet"

    await act(async () => {
      let acc = ""
      for (const ch of sentence) {
        acc += ch
        // No `await` between dispatches — a burst well past the
        // SYNC_BURST_LIMIT circuit breaker (currently 20), exactly the
        // scenario the max-update-depth fix guards against.
        fireEvent.change(input, { target: { value: acc } })
      }
      await new Promise((r) => setTimeout(r, 32))
    })

    expect(input.value).toBe(sentence)
  })
})
