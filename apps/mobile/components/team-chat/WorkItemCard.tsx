// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A board card's post in a channel: key, title, column, priority, assignee and
 * board on one card you can tap to open the card pane.
 */
import { Pressable, Text, View } from 'react-native'
import { Bot, CalendarDays, KanbanSquare } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { Priority } from '../../lib/work-boards-api'
import type { WorkItemBlock } from '../../lib/team-chat-kinds'
import { PRIORITY_DOT } from '../boards/priority'

/** Column pill tone per column category, so a card's state reads at a glance. */
const COLUMN_TONE: Record<string, string> = {
  backlog: 'bg-muted text-muted-foreground',
  active: 'bg-primary/10 text-primary',
  waiting: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  review: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  dismissed: 'bg-muted text-muted-foreground',
}

export function WorkItemCard({ item, onPress }: { item: WorkItemBlock; onPress: () => void }) {
  const priority = (item.priority ?? 'none') as Priority
  const dot = PRIORITY_DOT[priority]
  const tone = COLUMN_TONE[item.column?.category ?? ''] ?? COLUMN_TONE.backlog
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={`Open ${item.key}: ${item.title}`}
      testID="work-item-card"
      className="mt-1 max-w-[520px] gap-2 rounded-lg border border-border bg-card p-3 hover:bg-muted/40 active:bg-muted/40"
    >
      <View className="flex-row flex-wrap items-center gap-2">
        {dot && priority !== 'none' ? <View className={cn('h-2 w-2 rounded-full', dot)} /> : null}
        <Text className="text-[11px] font-semibold text-muted-foreground" testID="work-item-key">{item.key}</Text>
        {item.column ? (
          <View className={cn('rounded px-1.5 py-0.5', tone)}>
            <Text className="text-[10px] font-medium">{item.column.name}</Text>
          </View>
        ) : null}
      </View>

      <Text className="text-sm font-semibold text-foreground" testID="work-item-title">{item.title}</Text>

      {item.note ? <Text className="text-xs text-muted-foreground">{item.note}</Text> : null}

      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        {item.boardName ? (
          <View className="flex-row items-center gap-1">
            <KanbanSquare size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">{item.boardName}</Text>
          </View>
        ) : null}
        <View className="flex-row items-center gap-1">
          {item.assignee ? (
            <>
              {item.assignee.kind === 'agent' ? <Bot size={11} className="text-muted-foreground" /> : null}
              <Text className="text-[11px] text-muted-foreground">{item.assignee.name}</Text>
            </>
          ) : (
            <Text className="text-[11px] text-muted-foreground">Unassigned</Text>
          )}
        </View>
        {item.dueAt ? (
          <View className="flex-row items-center gap-1">
            <CalendarDays size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">{`Due ${new Date(item.dueAt).toLocaleDateString()}`}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}
