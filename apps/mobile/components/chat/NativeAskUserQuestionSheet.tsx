// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-phone bottom sheet for a pending AskUserQuestion poll.
 * Web and tablets keep the ChatDock card above the composer.
 */

import { useCallback, useState } from "react"
import { View } from "react-native"
import {
  NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO,
  NATIVE_PHONE_SHEET_COMPACT_RATIO,
} from "../../lib/native-phone-layout"
import { NativePhoneSheet, NativePhoneSheetCloseButton } from "../phone/NativePhoneSheet"
import type { ToolCallData } from "./tools/types"
import { AskUserQuestionWidget } from "./turns/AskUserQuestionWidget"

export function NativeAskUserQuestionSheet({
  visible,
  tool,
  onClose,
  onSubmitResponse,
}: {
  visible: boolean
  tool: ToolCallData
  onClose: () => void
  onSubmitResponse: (response: string) => void
}) {
  const [progress, setProgress] = useState({ index: 1, total: 1 })
  const title =
    progress.total > 0
      ? `Question ${Math.max(1, progress.index)} of ${progress.total}`
      : "Question"

  const handleQuestionProgress = useCallback(
    (next: { index: number; total: number }) => {
      setProgress((prev) =>
        prev.index === next.index && prev.total === next.total ? prev : next,
      )
    },
    [],
  )

  const handleSubmitResponse = useCallback(
    (response: string) => {
      onSubmitResponse(response)
      onClose()
    },
    [onClose, onSubmitResponse],
  )

  return (
    <NativePhoneSheet
      visible={visible}
      onClose={onClose}
      title={title}
      animationType="slide"
      scroll
      maxHeightRatio={NATIVE_PHONE_SHEET_COMPACT_RATIO}
      bodyMaxHeightRatio={NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO}
      testID="native-ask-user-question-sheet"
      headerLeft={<NativePhoneSheetCloseButton onPress={onClose} />}
    >
      <View className="px-5 pb-2">
        <AskUserQuestionWidget
          tool={tool}
          onSubmitResponse={handleSubmitResponse}
          embedded
          presentation="sheet"
          onQuestionProgress={handleQuestionProgress}
        />
      </View>
    </NativePhoneSheet>
  )
}
