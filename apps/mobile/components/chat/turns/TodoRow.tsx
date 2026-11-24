// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The agent's session checklist in the stream — a quiet pointer to the Tasks
 * panel, never the checklist itself: the full list lives in the dock
 * (`ChecklistDockPanel`) on desktop/web and in the "Worked" sheet on phone.
 *
 * Text only, no icon (SHO-574): it shares the 11px muted row style of every
 * other minimal tool row, and it usually rides inside the surrounding
 * work-group (`WorkGroup.tsx`) rather than standing alone.
 */

import { useMemo } from "react"
import { Pressable, Text } from "react-native"
import type { ToolCallData } from "../tools/types"
import { parseTodos } from "../../../lib/todo-state-store"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { useChatDockStore } from "../../../lib/chat-dock-store"

export interface TodoRowProps {
  tool: ToolCallData
  className?: string
}

export function TodoRow({ tool, className }: TodoRowProps) {
  const nativePhone = useIsNativePhoneLayout()
  const dockStore = useChatDockStore()
  const todos = useMemo(() => parseTodos(tool.args), [tool.args])
  const completed = todos.filter((todo) => todo.status === "completed").length
  const inProgress = todos.filter((todo) => todo.status === "in_progress").length
  const isPlanning = tool.state === "streaming" && todos.length === 0

  const content = isPlanning
    ? "Planning tasks…"
    : todos.length > 0
      ? `Updated tasks · ${completed}/${todos.length} complete${inProgress > 0 ? ` · ${inProgress} active` : ""}`
      : "Updated tasks"

  return (
    <Pressable
      accessibilityLabel={content}
      accessibilityRole={nativePhone ? undefined : "button"}
      disabled={nativePhone}
      onPress={() => dockStore.openPanel("checklist")}
      className={`flex-row items-center rounded py-0.5 ${className ?? ""}`}
    >
      <Text className="flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
        {content}
      </Text>
    </Pressable>
  )
}

export default TodoRow
