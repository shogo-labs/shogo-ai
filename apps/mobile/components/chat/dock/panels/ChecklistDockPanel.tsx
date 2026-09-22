// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Live todo checklist — reads straight from the per-chat `todoStateStore`,
 * the same source the in-stream task row subscribes to, so the dock always
 * shows the latest snapshot regardless of which `TodoWrite` call wrote it
 * last.
 */

import { useMemo, useSyncExternalStore } from "react"
import { ListTodo } from "lucide-react-native"
import { useTodoStateStore } from "../../../../lib/todo-state-store"
import { useIsNativePhoneLayout } from "../../../../lib/native-phone-layout"
import { TasksList } from "../../sessionActivity"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export function ChecklistDockPanel() {
  const nativePhone = useIsNativePhoneLayout()
  const todoStateStore = useTodoStateStore()
  useSyncExternalStore(todoStateStore.subscribe, todoStateStore.getVersion, todoStateStore.getVersion)
  const todos = todoStateStore.getLatest()

  const completed = todos.filter((t) => t.status === "completed").length
  const inProgress = todos.filter((t) => t.status === "in_progress").length

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (nativePhone || todos.length === 0) return null
    return {
      id: "checklist",
      kind: "status",
      order: 40,
      title: "Tasks",
      icon: ListTodo,
      summary: `${completed}/${todos.length} complete`,
      accent: inProgress > 0 ? "running" : "default",
      chip: { icon: ListTodo, dot: inProgress > 0 },
      render: () => <TasksList todos={todos} variant="dock" />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, completed, inProgress, nativePhone])

  useDockPanel(descriptor)
  return null
}
