// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Live todo checklist — reads straight from the per-chat `todoStateStore`,
 * the same source `TodoWidget` subscribes to, so the dock always shows the
 * latest snapshot regardless of which in-stream `TodoWrite` card wrote it
 * last. In-stream `TodoWidget`s stay put as milestone markers ("you were at
 * 4/10 here").
 */

import { useMemo, useSyncExternalStore } from "react"
import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { CheckCircle2, Circle, Loader2, XCircle, ListTodo } from "lucide-react-native"
import { useTodoStateStore, type TodoItem, type TodoStatus } from "../../../../lib/todo-state-store"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

function getStatusIcon(status: TodoStatus) {
  switch (status) {
    case "completed":
      return CheckCircle2
    case "in_progress":
      return Loader2
    case "cancelled":
      return XCircle
    case "pending":
    default:
      return Circle
  }
}

function getStatusColorClass(status: TodoStatus) {
  switch (status) {
    case "completed":
      return "text-green-500"
    case "in_progress":
      return "text-primary"
    default:
      return "text-muted-foreground"
  }
}

function ChecklistBody({ todos }: { todos: TodoItem[] }) {
  const total = todos.length
  const completed = todos.filter((t) => t.status === "completed").length

  return (
    <View className="gap-1">
      <View className="h-1 rounded-full bg-muted overflow-hidden">
        <View
          className="h-full bg-green-500"
          style={{ width: total > 0 ? `${(completed / total) * 100}%` : "0%" }}
        />
      </View>
      <View className="gap-0.5 pt-1">
        {todos.map((todo) => {
          const StatusIcon = getStatusIcon(todo.status)
          return (
            <View key={todo.id} className={cn("flex-row items-start gap-1.5 py-0.5", todo.status === "cancelled" && "opacity-50")}>
              <StatusIcon size={12} className={cn("mt-0.5", getStatusColorClass(todo.status))} />
              <Text
                className={cn(
                  "flex-1 text-[11px] text-foreground",
                  todo.status === "completed" && "text-muted-foreground",
                  todo.status === "cancelled" && "line-through text-muted-foreground",
                )}
              >
                {todo.content}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

export function ChecklistDockPanel() {
  const todoStateStore = useTodoStateStore()
  useSyncExternalStore(todoStateStore.subscribe, todoStateStore.getVersion, todoStateStore.getVersion)
  const todos = todoStateStore.getLatest()

  const completed = todos.filter((t) => t.status === "completed").length
  const inProgress = todos.filter((t) => t.status === "in_progress").length

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (todos.length === 0) return null
    return {
      id: "checklist",
      kind: "status",
      order: 40,
      title: "Tasks",
      icon: ListTodo,
      summary: `${completed}/${todos.length} complete`,
      accent: inProgress > 0 ? "running" : "default",
      chip: { icon: ListTodo, dot: inProgress > 0 },
      render: () => <ChecklistBody todos={todos} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, completed, inProgress])

  useDockPanel(descriptor)
  return null
}
