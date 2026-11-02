// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-283 — mobile web: the composer's "+" sheet rows must open the browser's
 * chooser themselves, from a hidden `<input type="file">` clicked inside the
 * press's own task. iOS Safari ignores a chooser opened from an async chain
 * (which is what `executeNativeAttachAction` does on web), so the tap looked
 * dead before this fix.
 */

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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

// Phone-sized web viewport: `useComposerLayoutMode` turns on the prominent
// (phone) composer, which is the layout that renders `ComposerPlusSheet`.
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
const executeNativeAttachAction = mock((..._args: unknown[]) => {})
mock.module("../../../lib/native-attachment-picker", () => ({ executeNativeAttachAction }))
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

afterEach(() => {
  cleanup()
  executeNativeAttachAction.mockClear()
})

type InputClick = {
  accept: string | null
  capture: string | null
  multiple: boolean
  /** Was the sheet still on screen? Proves the click stayed in the press's own task. */
  sheetStillOpen: boolean
}

function renderPhoneComposer() {
  const view = render(<ChatInput onSubmit={mock(() => {})} isPro />)
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).toBeTruthy()

  const clicks: InputClick[] = []
  input.click = (() => {
    clicks.push({
      accept: input.getAttribute("accept"),
      capture: input.getAttribute("capture"),
      multiple: input.multiple,
      sheetStillOpen: screen.queryByText("Photo library") !== null,
    })
  }) as unknown as typeof input.click
  return { ...view, input, clicks }
}

function openPlusSheetThenPress(row: string) {
  fireEvent.click(screen.getByTestId("project-composer-plus"))
  fireEvent.click(screen.getByText(row))
}

describe("SHO-283 — phone composer '+' sheet on web", () => {
  test("Photo library opens the hidden input for images, in the press's own tick", () => {
    const { clicks } = renderPhoneComposer()

    openPlusSheetThenPress("Photo library")

    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toEqual({
      accept: "image/*",
      capture: null,
      multiple: true,
      sheetStillOpen: true,
    })
    expect(executeNativeAttachAction).not.toHaveBeenCalled()
  })

  test("Browse files opens the hidden input with no type filter", () => {
    const { clicks } = renderPhoneComposer()

    openPlusSheetThenPress("Browse files")

    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toEqual({
      accept: null,
      capture: null,
      multiple: true,
      sheetStillOpen: true,
    })
    expect(executeNativeAttachAction).not.toHaveBeenCalled()
  })

  test("Take photo asks for the rear camera", () => {
    const { clicks } = renderPhoneComposer()

    openPlusSheetThenPress("Take photo")

    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toEqual({
      accept: "image/*",
      capture: "environment",
      multiple: false,
      sheetStillOpen: true,
    })
    expect(executeNativeAttachAction).not.toHaveBeenCalled()
  })

  test("a pick after Photo library drops the image filter again", () => {
    const { clicks } = renderPhoneComposer()

    openPlusSheetThenPress("Photo library")
    fireEvent.click(screen.getByTestId("project-composer-plus"))
    fireEvent.click(screen.getByText("Browse files"))

    expect(clicks.map((click) => click.accept)).toEqual(["image/*", null])
    expect(clicks.map((click) => click.capture)).toEqual([null, null])
  })
})
