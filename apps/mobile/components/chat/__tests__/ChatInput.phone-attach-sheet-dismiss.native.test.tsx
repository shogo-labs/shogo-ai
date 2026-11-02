// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-283 — native iOS: a picker presented while the attach sheet's `<Modal>`
 * is still dismissing is dropped without an error, so the tap looked dead.
 * Both native sheets must close first and launch from the Modal's `onDismiss`
 * (with the fallback timer), and launch exactly once.
 */

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import { resolve } from "node:path"

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

/**
 * `Modal` only fires `onDismiss` on iOS once it is really gone — there is no
 * DOM equivalent, so the shim records the visible modal's handler and the
 * test calls it.
 */
let modalOnDismiss: (() => void) | null = null

const Modal = ({ visible, onDismiss, children }: any) => {
  if (visible && typeof onDismiss === "function") modalOnDismiss = onDismiss
  return <div data-testid="rn-modal">{children}</div>
}

mock.module("react-native", () =>
  createReactNativeMock({
    Image: Host,
    Modal,
    Platform: { OS: "ios" },
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

mock.module(resolve(import.meta.dir, "../../../lib/auth-client"), () => ({
  authClient: { getCookie: () => null },
  autoSignInLocally: async () => {},
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

// Spy on the real picker entry point. `AttachSourceSheet` and `ChatInput` both
// resolve this module, so one spy covers both sheets.
const executeNativeAttachAction = mock((..._args: unknown[]) => {})
mock.module("../../../lib/native-attachment-picker", () => ({ executeNativeAttachAction }))

const { ChatInput } = await import("../ChatInput")
const { AttachSourceSheet } = await import("../AttachSourceSheet")

afterEach(() => {
  cleanup()
  executeNativeAttachAction.mockClear()
  modalOnDismiss = null
})

const SHEET_DISMISS_WAIT_MS = 500

function sheetDismiss() {
  act(() => {
    modalOnDismiss?.()
  })
}

async function waitPastFallbackTimer() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SHEET_DISMISS_WAIT_MS))
  })
}

const pickerOpts = {
  currentCount: 0,
  maxFiles: 5,
  maxFileSizeBytes: 10 * 1024 * 1024,
  onFiles: () => {},
  onError: () => {},
}

describe("SHO-283 — native attach sheets launch the picker after they close", () => {
  test("the prominent + sheet waits for onDismiss, then launches once", async () => {
    render(<ChatInput onSubmit={mock(() => {})} isPro />)
    fireEvent.click(screen.getByTestId("project-composer-plus"))
    fireEvent.click(screen.getByText("Photo library"))

    // The sheet is closing; presenting a picker right now is what iOS drops.
    expect(executeNativeAttachAction).not.toHaveBeenCalled()

    sheetDismiss()

    expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
    expect(executeNativeAttachAction.mock.calls[0][0]).toBe("library")

    await waitPastFallbackTimer()
    expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
  })

  test("Browse files from the + sheet opens the document picker", async () => {
    render(<ChatInput onSubmit={mock(() => {})} isPro />)
    fireEvent.click(screen.getByTestId("project-composer-plus"))
    fireEvent.click(screen.getByText("Browse files"))

    expect(executeNativeAttachAction).not.toHaveBeenCalled()

    sheetDismiss()

    expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
    expect(executeNativeAttachAction.mock.calls[0][0]).toBe("documents")
  })

  test("AttachSourceSheet waits for onDismiss, then launches once", async () => {
    render(
      <AttachSourceSheet open onOpenChange={mock(() => {})} {...pickerOpts} />,
    )
    fireEvent.click(screen.getByText("Photo library"))

    expect(executeNativeAttachAction).not.toHaveBeenCalled()

    sheetDismiss()

    expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
    expect(executeNativeAttachAction.mock.calls[0][0]).toBe("library")

    await waitPastFallbackTimer()
    expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
  })

  test("a sheet dismissed without a pick never launches anything", async () => {
    render(
      <AttachSourceSheet open onOpenChange={mock(() => {})} {...pickerOpts} />,
    )
    fireEvent.click(screen.getByLabelText("Dismiss attach menu"))

    sheetDismiss()
    await waitPastFallbackTimer()

    expect(executeNativeAttachAction).not.toHaveBeenCalled()
  })
})
