// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mount point for the task-thread side window. Subscribes to the shared store,
 * so any background-task row (dock or finished-task row) can open it without
 * the screen wiring a callback down the message tree. Wide layouts get a pane
 * beside the chat; phones get the same pane in a sheet.
 */

import { useEffect } from "react"
import { useWindowDimensions, View } from "react-native"
import { useTaskThreadTarget, taskThreadPane } from "../../../lib/task-thread-pane-store"
import { SidePaneResizeHandle, useSidePaneWidth, SIDE_PANE_CHAT_MIN_WIDTH } from "../../layout/SidePaneResizer"
import { NativePhoneSheet } from "../../phone/NativePhoneSheet"
import { TaskThreadPane } from "./TaskThreadPane"

/** Same breakpoint the project/plan side panes use. */
const SIDE_PANE_MIN_WIDTH = 1024
export const TASK_THREAD_PANE_STORAGE_KEY = "shogo.taskThreadPaneWidth"
export const TASK_THREAD_PANE_MIN_WIDTH = 420

export function TaskThreadPaneHost({
  containerWidth,
  reservedWidth = 0,
  onWidthChange,
}: {
  /** Measured width of the row the pane opens into (the window without the app sidebar). */
  containerWidth?: number
  /** Pixels of that row another open pane already occupies. */
  reservedWidth?: number
  /** Reports the pane's width while it is open, and null once it is closed. */
  onWidthChange?: (width: number | null) => void
} = {}) {
  const target = useTaskThreadTarget()
  const { width: windowWidth, height } = useWindowDimensions()
  const wide = windowWidth >= SIDE_PANE_MIN_WIDTH
  const rowWidth = containerWidth && containerWidth > 0 ? containerWidth : windowWidth
  const pane = useSidePaneWidth({
    storageKey: TASK_THREAD_PANE_STORAGE_KEY,
    defaultWidth: Math.max(TASK_THREAD_PANE_MIN_WIDTH, Math.round(rowWidth * 0.45)),
    minWidth: TASK_THREAD_PANE_MIN_WIDTH,
    maxWidth: rowWidth - SIDE_PANE_CHAT_MIN_WIDTH - reservedWidth,
  })
  const open = !!target
  const close = () => taskThreadPane.close()

  useEffect(() => {
    onWidthChange?.(open ? pane.width : null)
    return () => onWidthChange?.(null)
  }, [open, pane.width, onWidthChange])

  if (!target) return null

  if (wide) {
    return (
      <View
        className="relative shrink-0 border-l border-border"
        style={{ width: pane.width }}
        testID="task-thread-pane-host"
      >
        <SidePaneResizeHandle
          width={pane.width}
          minWidth={TASK_THREAD_PANE_MIN_WIDTH}
          maxWidth={rowWidth - SIDE_PANE_CHAT_MIN_WIDTH - reservedWidth}
          onResize={pane.setWidth}
          onResizeEnd={pane.commit}
          onReset={pane.reset}
        />
        <TaskThreadPane target={target} onClose={close} embedded />
      </View>
    )
  }

  return (
    <NativePhoneSheet visible onClose={close} grabber={false} testID="task-thread-sheet">
      <View style={{ height: Math.round(height * 0.9) }}>
        <TaskThreadPane target={target} onClose={close} />
      </View>
    </NativePhoneSheet>
  )
}

export default TaskThreadPaneHost
