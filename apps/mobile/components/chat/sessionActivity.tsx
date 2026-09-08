// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared changed-files / tasks lists for the chat dock and the native
 * Worked sheet. `dock` is the compact web chip panel; `sheet` is the
 * larger native-phone layout.
 */

import { Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  CheckCircle2,
  Circle,
  FileEdit,
  FilePlus,
  FileX,
  Loader2,
  XCircle,
} from "lucide-react-native"
import type { FileChangeKind } from "../../lib/file-change-store"
import type { TodoItem, TodoStatus } from "../../lib/todo-state-store"

export type SessionActivityVariant = "dock" | "sheet"

const KIND_ICON: Record<FileChangeKind, typeof FileEdit> = {
  write: FilePlus,
  edit: FileEdit,
  delete: FileX,
}

const KIND_COLOR: Record<FileChangeKind, string> = {
  write: "text-emerald-500",
  edit: "text-sky-500",
  delete: "text-red-500",
}

function statusIcon(status: TodoStatus) {
  switch (status) {
    case "completed":
      return CheckCircle2
    case "in_progress":
      return Loader2
    case "cancelled":
      return XCircle
    default:
      return Circle
  }
}

function statusColor(status: TodoStatus) {
  switch (status) {
    case "completed":
      return "text-green-500"
    case "in_progress":
      return "text-primary"
    default:
      return "text-muted-foreground"
  }
}

export function ChangedFilesList({
  files,
  variant,
}: {
  files: { path: string; kind: FileChangeKind }[]
  variant: SessionActivityVariant
}) {
  const sheet = variant === "sheet"
  return (
    <View className={sheet ? "gap-1.5" : "gap-1"}>
      {files.map(({ path, kind }) => {
        const Icon = KIND_ICON[kind]
        const fileName = path.split("/").pop() || path
        return (
          <View
            key={path}
            className={cn("flex-row items-center", sheet ? "gap-2" : "gap-1.5")}
          >
            <Icon
              size={sheet ? 14 : 12}
              className={cn("shrink-0", KIND_COLOR[kind])}
            />
            <Text
              className={cn(
                "flex-1 text-foreground",
                sheet ? "text-[14px]" : "text-[11px]",
              )}
              numberOfLines={1}
            >
              {fileName}
            </Text>
            {sheet ? null : (
              <Text className="text-[9px] text-muted-foreground" numberOfLines={1}>
                {path}
              </Text>
            )}
          </View>
        )
      })}
    </View>
  )
}

export function TasksList({
  todos,
  variant,
}: {
  todos: TodoItem[]
  variant: SessionActivityVariant
}) {
  const sheet = variant === "sheet"
  const total = todos.length
  const completed = todos.filter((t) => t.status === "completed").length

  return (
    <View className={sheet ? "gap-2" : "gap-1"}>
      <View className="h-1 overflow-hidden rounded-full bg-muted">
        <View
          className="h-full bg-green-500"
          style={{ width: total > 0 ? `${(completed / total) * 100}%` : "0%" }}
        />
      </View>
      <View className={cn(sheet ? "gap-1 pt-1" : "gap-0.5 pt-1")}>
        {todos.map((todo) => {
          const StatusIcon = statusIcon(todo.status)
          return (
            <View
              key={todo.id}
              className={cn(
                "flex-row items-start",
                sheet ? "gap-2 py-0.5" : "gap-1.5 py-0.5",
                todo.status === "cancelled" && "opacity-50",
              )}
            >
              <StatusIcon
                size={sheet ? 14 : 12}
                className={cn("mt-0.5", statusColor(todo.status))}
              />
              <Text
                className={cn(
                  "flex-1 text-foreground",
                  sheet ? "text-[14px]" : "text-[11px]",
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
