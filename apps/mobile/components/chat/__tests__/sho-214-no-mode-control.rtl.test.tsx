// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-214 — one mode: no composer offers an Agent / Plan / Ask control.
 *
 * The selector is gone from every surface: the phone plus-sheet "Mode"
 * section, the desktop "Advanced controls" popover, and the studio
 * presentation's own dropdown. Shift+Tab no longer cycles a mode either.
 *
 * Rendered at both phone (390 px) and desktop (1280 px) widths, because the
 * composer picks a different layout for each and the selector lived in a
 * different place in both. The `Popover` mock below renders its content
 * unconditionally, so anything the popover *would* show is really in the DOM —
 * a negative assertion here is not vacuous.
 */

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

let windowWidth = 390
const PHONE_WIDTH = 390
const DESKTOP_WIDTH = 1280

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
        const wrappedEvent = {
          nativeEvent: { key: event.key, shiftKey: event.shiftKey },
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
    useWindowDimensions: () => ({ width: windowWidth, height: 900 }),
    View: Host,
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}))

// Renders trigger AND content, so a selector that still existed would render.
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

const QUICK_ACTIONS = [{ label: "Ship it", prompt: "Ship it" }]

/**
 * The descriptor a team workspace got before this refactor: model picker plus
 * the interaction-mode selector. Every render below passes it, so the negative
 * assertions are never vacuous — a caller that still asks for modes (a cached
 * bundle, an older shared-app, a stale test) must still get none.
 */
const STALE_TEAM_COMPOSER = {
  showModelPicker: true,
  showInteractionModes: true,
} as any

/** Nothing that belonged to the mode selector may exist anywhere in the tree. */
function expectNoModeControl() {
  expect(screen.queryAllByTestId(/^interaction-mode-/)).toEqual([])
  expect(screen.queryByTestId("dual-plan-toggle")).toBeNull()
  expect(screen.queryByLabelText(/^Mode: /)).toBeNull()
  // Row labels from the old selector (exact, so "Ask Shogo..." is not a match).
  expect(screen.queryByText("Mode")).toBeNull()
  expect(screen.queryByText("Plan", { exact: true })).toBeNull()
  expect(screen.queryByText("Agent", { exact: true })).toBeNull()
  expect(screen.queryByText("Ask", { exact: true })).toBeNull()
}

afterEach(() => {
  cleanup()
  windowWidth = PHONE_WIDTH
})

describe("SHO-214 — phone composer has no mode control", () => {
  test("the + sheet has Model and quick actions but no Mode section", () => {
    windowWidth = PHONE_WIDTH
    render(
      <ChatInput
        onSubmit={mock(() => {})}
        isPro
        presentation="agent"
        composer={STALE_TEAM_COMPOSER}
        quickActions={QUICK_ACTIONS}
      />,
    )

    // The phone composer keeps its prominent layout: one `+` opens the sheet.
    const plus = screen.getByTestId("project-composer-plus")
    expectNoModeControl()

    fireEvent.click(plus)

    // The sheet really rendered (Model + the quick action are in it) …
    expect(screen.getByText("Model")).toBeTruthy()
    expect(screen.getByText("Quick actions")).toBeTruthy()
    // … and it carries no mode section or rows.
    expectNoModeControl()
    // The phone composer paints its own placeholder node rather than the
    // TextInput's `placeholder` attribute.
    expect(screen.getByText("Ask Shogo...")).toBeTruthy()
  })
})

describe("SHO-214 — desktop composer has no mode control", () => {
  test("the Advanced controls popover holds the model picker and no mode rows", () => {
    windowWidth = DESKTOP_WIDTH
    render(
      <ChatInput
        onSubmit={mock(() => {})}
        isPro
        presentation="agent"
        composer={STALE_TEAM_COMPOSER}
        quickActions={QUICK_ACTIONS}
      />,
    )

    expect(screen.getByLabelText("Advanced controls")).toBeTruthy()
    // The popover content renders unconditionally in this mock, so this proves
    // what it holds: the Model section is there, the Mode section is not.
    expect(screen.getByText("Model")).toBeTruthy()
    expectNoModeControl()
    // One placeholder everywhere: no per-mode copy is left.
    expect((screen.getByTestId("project-composer-input") as HTMLTextAreaElement).placeholder).toBe(
      "Ask Shogo...",
    )
  })

  test("the studio presentation no longer renders its own mode dropdown", () => {
    windowWidth = DESKTOP_WIDTH
    render(
      <ChatInput
        onSubmit={mock(() => {})}
        isPro
        presentation="studio"
        composer={STALE_TEAM_COMPOSER}
      />,
    )

    expectNoModeControl()
  })
})

describe("SHO-214 — a stale descriptor asking for modes gets none", () => {
  test("showInteractionModes in the composer descriptor is inert", () => {
    windowWidth = DESKTOP_WIDTH
    render(
      <ChatInput
        onSubmit={mock(() => {})}
        isPro
        presentation="agent"
        // An old caller — a cached bundle, a shared-app version from before the
        // refactor — still asks for the selector. There is nothing to show.
        composer={STALE_TEAM_COMPOSER}
      />,
    )

    expectNoModeControl()
    expect(screen.getByText("Model")).toBeTruthy()
  })
})

describe("SHO-214 — Shift+Tab no longer cycles a mode", () => {
  test("Shift+Tab leaves the text and the composer alone", () => {
    windowWidth = DESKTOP_WIDTH
    const onSubmit = mock(() => {})
    render(
      <ChatInput
        onSubmit={onSubmit}
        isPro
        presentation="agent"
        composer={STALE_TEAM_COMPOSER}
      />,
    )

    const input = screen.getByTestId("project-composer-input") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "hello" } })
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })

    expect(input.value).toBe("hello")
    expect(onSubmit).not.toHaveBeenCalled()
    expectNoModeControl()
  })
})
