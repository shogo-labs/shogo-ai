// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live session files + tasks, shown inside the native "Worked" sheet
 * instead of stacked on the project composer.
 */

import { useMemo, useSyncExternalStore } from "react"
import { Text, View } from "react-native"
import { useFileChangeStore } from "../../lib/file-change-store"
import { useTodoStateStore } from "../../lib/todo-state-store"
import { ChangedFilesList, TasksList } from "./sessionActivity"

export function NativeWorkedSessionExtras() {
  const fileStore = useFileChangeStore()
  const version = useSyncExternalStore(fileStore.subscribe, fileStore.getVersion, fileStore.getVersion)
  const files = useMemo(() => fileStore.getAll(), [fileStore, version])

  const todoStore = useTodoStateStore()
  useSyncExternalStore(todoStore.subscribe, todoStore.getVersion, todoStore.getVersion)
  const todos = todoStore.getLatest()

  if (files.length === 0 && todos.length === 0) return null

  return (
    <View className="mb-3 border-b border-border/50 pb-1">
      {files.length > 0 ? (
        <View className="mb-4 gap-2">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="text-[15px] font-semibold text-foreground">Changed files</Text>
            <Text className="text-[13px] text-muted-foreground">
              {files.length} file{files.length === 1 ? "" : "s"} changed
            </Text>
          </View>
          <ChangedFilesList files={files} variant="sheet" />
        </View>
      ) : null}
      {todos.length > 0 ? (
        <View className="mb-4 gap-2">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="text-[15px] font-semibold text-foreground">Tasks</Text>
            <Text className="text-[13px] text-muted-foreground">
              {todos.filter((t) => t.status === "completed").length}/{todos.length} complete
            </Text>
          </View>
          <TasksList todos={todos} variant="sheet" />
        </View>
      ) : null}
    </View>
  )
}
