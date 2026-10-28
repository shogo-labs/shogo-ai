// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mount point for the task-thread side window. Subscribes to the shared store,
 * so any background-task row (dock or finished-task row) can open it without
 * the screen wiring a callback down the message tree. Wide layouts get a pane
 * beside the chat; phones get the same pane in a sheet.
 */

import { useWindowDimensions, View } from "react-native"
import { useTaskThreadTarget, taskThreadPane } from "../../../lib/task-thread-pane-store"
import { NativePhoneSheet } from "../../phone/NativePhoneSheet"
import { TaskThreadPane } from "./TaskThreadPane"

/** Same breakpoint the project/plan side panes use. */
const SIDE_PANE_MIN_WIDTH = 1024

export function TaskThreadPaneHost() {
  const target = useTaskThreadTarget()
  const { width, height } = useWindowDimensions()
  const wide = width >= SIDE_PANE_MIN_WIDTH
  const close = () => taskThreadPane.close()

  if (!target) return null

  if (wide) {
    return (
      <View className="w-[45%] min-w-[420px] border-l border-border" testID="task-thread-pane-host">
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
