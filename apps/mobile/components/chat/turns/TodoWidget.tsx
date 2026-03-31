// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TodoWidget Component (React Native)
 *
 * Renders the agent's task list from TodoWrite tool calls.
 * Shows task list with status indicators, collapsible details, and progress tracking.
 */

import { useMemo } from "react"
import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  ChevronRight,
  ChevronDown,
  ListTodo,
} from "lucide-react-native"
import type { ToolCallData } from "../tools/types"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

export interface TodoWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

function parseTodos(args?: Record<string, unknown>): TodoItem[] {
  if (!args) return []

  let todosArray: unknown[] | undefined

  if (Array.isArray(args.todos)) {
    todosArray = args.todos
  } else if (typeof args.todos === "string") {
    try {
      const parsed = JSON.parse(args.todos)
      if (Array.isArray(parsed)) todosArray = parsed
    } catch {
      /* ignore */
    }
  } else if (args.input && typeof args.input === "object") {
    const input = args.input as Record<string, unknown>
    if (Array.isArray(input.todos)) {
      todosArray = input.todos
    }
  }

  if (!todosArray || todosArray.length === 0) return []

  return todosArray
    .filter((item): item is Record<string, unknown> => {
      if (!item || typeof item !== "object") return false
      const t = item as Record<string, unknown>
      return typeof t.content === "string" && t.content.length > 0
    })
    .map((item, index): TodoItem => {
      const t = item as Record<string, unknown>
      const rawStatus = typeof t.status === "string" ? t.status : ""
      const validStatuses: TodoStatus[] = [
        "pending",
        "in_progress",
        "completed",
        "cancelled",
      ]

      return {
        id: typeof t.id === "string" ? t.id : `todo-${index}`,
        content: t.content as string,
        status: validStatuses.includes(rawStatus as TodoStatus)
          ? (rawStatus as TodoStatus)
          : "pending",
      }
    })
}

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

function getStatusColors(status: TodoStatus) {
  switch (status) {
    case "completed":
      return "text-green-500"
    case "in_progress":
      return "text-primary"
    case "cancelled":
      return "text-muted-foreground"
    case "pending":
    default:
      return "text-muted-foreground"
  }
}

function TodoItemRow({ todo }: { todo: TodoItem; index: number }) {
  const StatusIcon = getStatusIcon(todo.status)
  const colorClass = getStatusColors(todo.status)

  return (
    <View
      className={cn(
        "flex-row items-start gap-2 py-1.5 px-2",
        todo.status === "cancelled" && "opacity-50"
      )}
    >
      <StatusIcon className={cn("w-3.5 h-3.5 mt-0.5", colorClass)} />

      <Text
        className={cn(
          "text-xs flex-1",
          todo.status === "completed" && "text-muted-foreground",
          todo.status === "cancelled" && "line-through text-muted-foreground"
        )}
      >
        {todo.content}
      </Text>
    </View>
  )
}

function ProgressBar({ todos }: { todos: TodoItem[] }) {
  const total = todos.length
  const completed = todos.filter((t) => t.status === "completed").length
  const inProgress = todos.filter((t) => t.status === "in_progress").length
  const cancelled = todos.filter((t) => t.status === "cancelled").length

  if (total === 0) return null

  const completedPercent = (completed / total) * 100
  const inProgressPercent = (inProgress / total) * 100

  return (
    <View className="gap-1">
      <View className="h-1 bg-muted rounded-full overflow-hidden flex-row">
        <View
          className="h-full bg-green-500"
          style={{ width: `${completedPercent}%` }}
        />
        <View
          className="h-full bg-primary"
          style={{ width: `${inProgressPercent}%` }}
        />
      </View>

      <View className="flex-row gap-3">
        <Text className="text-[9px] text-muted-foreground">
          {completed}/{total} completed
        </Text>
        {inProgress > 0 && (
          <Text className="text-[9px] text-primary">
            {inProgress} in progress
          </Text>
        )}
        {cancelled > 0 && (
          <Text className="text-[9px] text-muted-foreground">
            {cancelled} cancelled
          </Text>
        )}
      </View>
    </View>
  )
}

export function TodoWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: TodoWidgetProps) {
  const todos = useMemo(() => parseTodos(tool.args), [tool.args])
  const isExpanded = controlledExpanded ?? true

  const handleToggle = () => {
    onToggle?.()
  }

  const stats = useMemo(() => {
    const total = todos.length
    const completed = todos.filter((t) => t.status === "completed").length
    const inProgress = todos.filter((t) => t.status === "in_progress").length
    return { total, completed, inProgress }
  }, [todos])

  const isStreaming = tool.state === "streaming" && todos.length === 0

  if (isStreaming) {
    return (
      <View
        className={cn(
          "rounded-md border border-primary/20 bg-primary/5 p-2",
          className
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <ListTodo className="w-3 h-3 text-primary" />
          <Text className="font-mono text-[10px] font-medium text-foreground">
            TodoWrite
          </Text>
          <Text className="text-[9px] text-muted-foreground">
            Planning tasks...
          </Text>
        </View>
      </View>
    )
  }

  if (todos.length === 0) {
    return (
      <View
        className={cn(
          "rounded-md border border-border/50 bg-muted/30 p-2",
          className
        )}
      >
        <View className="flex-row items-center gap-1.5">
          <ListTodo className="w-3 h-3 text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">No tasks</Text>
        </View>
      </View>
    )
  }

  const allComplete = stats.completed === stats.total
  const hasInProgress = stats.inProgress > 0

  return (
    <View
      className={cn(
        "rounded-md border overflow-hidden",
        allComplete
          ? "border-green-500/30 bg-green-500/5"
          : hasInProgress
            ? "border-primary/30 bg-primary/5"
            : "border-border/50 bg-muted/30",
        className
      )}
    >
      {/* Header */}
      <Pressable
        onPress={handleToggle}
        className="w-full flex-row items-center gap-1.5 py-1.5 px-2"
      >
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        )}

        <ListTodo
          className={cn(
            "w-3 h-3",
            allComplete
              ? "text-green-500"
              : hasInProgress
                ? "text-primary"
                : "text-muted-foreground"
          )}
        />

        <Text className="font-mono text-[10px] font-medium text-foreground">
          Tasks
        </Text>

        <Text className="flex-1 text-[9px] text-muted-foreground text-right">
          {stats.completed}/{stats.total} complete
          {stats.inProgress > 0 && (
            <Text className="text-primary">
              {" "}• {stats.inProgress} active
            </Text>
          )}
        </Text>

        {allComplete ? (
          <CheckCircle2 className="w-3 h-3 text-green-500" />
        ) : hasInProgress ? (
          <Loader2 className="w-3 h-3 text-primary" />
        ) : null}
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View className="border-t border-border/50">
          <View className="px-3 pt-2">
            <ProgressBar todos={todos} />
          </View>

          <View className="py-1">
            {todos.map((todo, index) => (
              <TodoItemRow key={todo.id} todo={todo} index={index} />
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

export default TodoWidget
