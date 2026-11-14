// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-386 — a video picked on iOS must reach the composer as a video chip
 * that plays, and must be submitted with its on-device `uri` so the upload
 * streams from disk instead of a base64 read.
 *
 * The picker itself is stubbed here (its decisions are covered by
 * `lib/__tests__/native-attachment-picker.test.ts`); what this file guards is
 * the composer end: `previewUrl` surviving `applyPickedFiles`, the chip being
 * tappable into the preview modal, and `onSubmit` receiving `uri`.
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

mock.module("../../../lib/auth-client", () => ({
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
mock.module("../turns/AskUserQuestionWidget", () => ({
  AskUserQuestionWidget: () => null,
}))
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

/** The modal is the proof that a tap on the video chip plays the video. */
let previewVideoUrl: string | null = null
mock.module("../VideoPreviewModal", () => ({
  VideoPreviewModal: ({ visible, url }: { visible?: boolean; url?: string }) => {
    if (visible) previewVideoUrl = url ?? null
    return null
  },
}))

// Captures the options `ChatInput` hands the picker, so the test can deliver a
// pick the way a real `launchImageLibraryAsync` would.
const executeNativeAttachAction = mock((_action: unknown, _opts: unknown) => {})
mock.module("../../../lib/native-attachment-picker", () => ({
  executeNativeAttachAction,
}))

const { ChatInput } = await import("../ChatInput")

const PICKED_VIDEO = {
  id: "video-1",
  dataUrl: "",
  name: "IMG_1234.MOV",
  type: "video/quicktime",
  size: 12 * 1024 * 1024,
  uri: "file:///var/mobile/DCIM/IMG_1234.MOV",
  previewUrl: "file:///var/mobile/DCIM/IMG_1234.MOV",
}

function pickerOptions(): {
  onFiles: (files: unknown[]) => void
  onError: (message: string) => void
} {
  expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
  return executeNativeAttachAction.mock.calls[0][1] as {
    onFiles: (files: unknown[]) => void
    onError: (message: string) => void
  }
}

afterEach(() => {
  cleanup()
  executeNativeAttachAction.mockClear()
  modalOnDismiss = null
  previewVideoUrl = null
})

describe("SHO-386 — a picked video in the native composer", () => {
  test("the chip shows the file, plays it, and submits its uri", async () => {
    const onSubmit = mock((..._args: any[]) => {})
    render(<ChatInput onSubmit={onSubmit} isPro />)

    fireEvent.click(screen.getByTestId("project-composer-plus"))
    fireEvent.click(screen.getByText("Photo library"))

    // iOS drops a picker presented while the sheet is dismissing (SHO-283).
    act(() => {
      modalOnDismiss?.()
    })
    const options = pickerOptions()

    act(() => {
      options.onFiles([PICKED_VIDEO])
    })

    const chip = screen.getByLabelText("Preview video IMG_1234.MOV")
    expect(screen.getByText("IMG_1234.MOV")).toBeTruthy()

    fireEvent.click(chip)
    expect(previewVideoUrl).toBe("file:///var/mobile/DCIM/IMG_1234.MOV")

    fireEvent.click(screen.getByLabelText("Send message"))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const files = onSubmit.mock.calls[0][1] as any[]
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      name: "IMG_1234.MOV",
      type: "video/quicktime",
      size: 12 * 1024 * 1024,
      uri: "file:///var/mobile/DCIM/IMG_1234.MOV",
      previewUrl: "file:///var/mobile/DCIM/IMG_1234.MOV",
    })
    // No base64 read of the video: the upload streams from `uri`.
    expect(files[0].dataUrl).toBe("")
  })

  test("the + sheet offers a camera that records video and a library with videos", () => {
    render(<ChatInput onSubmit={mock(() => {})} isPro />)

    fireEvent.click(screen.getByTestId("project-composer-plus"))

    expect(screen.getByText("Camera")).toBeTruthy()
    expect(screen.getByText("Photo or video")).toBeTruthy()
    expect(screen.getByText("Photos and videos")).toBeTruthy()
  })

  test("an oversize video never reaches the chip", () => {
    render(<ChatInput onSubmit={mock(() => {})} isPro maxFileSizeBytes={1024 * 1024} />)

    fireEvent.click(screen.getByTestId("project-composer-plus"))
    fireEvent.click(screen.getByText("Photo library"))
    act(() => {
      modalOnDismiss?.()
    })
    const options = pickerOptions()

    act(() => {
      options.onFiles([PICKED_VIDEO])
    })

    expect(screen.queryByLabelText("Preview video IMG_1234.MOV")).toBeNull()
    expect(screen.getByText(/exceeds 1MB limit/)).toBeTruthy()
    expect(executeNativeAttachAction).toHaveBeenCalledTimes(1)
  })
})
