// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** One card as a list row: used by My work and a board's list view. */
import { Pressable, Text, View } from 'react-native'
import { Bot, Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { Mentionables } from '../../lib/team-chat-api'
import type { WorkItem } from '../../lib/work-boards-api'
import { age, assigneeName } from '../../lib/board-layout'
import { PRIORITY_DOT } from './priority'
import { WorkingIndicator } from './WorkingIndicator'

export function WorkItemRow({ item, mentionables, showBoard, selected, cursor, open, onPress, onToggle }: {
  item: WorkItem
  mentionables: Mentionables | null
  showBoard?: boolean
  selected?: boolean
  /** The keyboard cursor is on this row. */
  cursor?: boolean
  /** Its card is open in the side pane. */
  open?: boolean
  onPress: () => void
  onToggle?: () => void
}) {
  const who = assigneeName(item, mentionables)
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.key} ${item.title}`}
      aria-selected={!!selected}
      testID={`work-row-${item.key}`}
      className={cn(
        'flex-row items-center gap-3 border-b border-border/60 px-4 py-2.5 hover:bg-muted/50',
        open && 'bg-primary/5',
        cursor && 'bg-muted',
      )}
    >
      {onToggle ? (
        <Pressable
          onPress={onToggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: !!selected }}
          accessibilityLabel={`Select ${item.key}`}
          hitSlop={8}
          className={cn('h-4 w-4 items-center justify-center rounded border', selected ? 'border-primary bg-primary' : 'border-border')}
        >
          {selected ? <Check size={11} className="text-primary-foreground" /> : null}
        </Pressable>
      ) : null}
      <View className={cn('h-2 w-2 rounded-full', PRIORITY_DOT[item.priority], item.priority === 'none' && 'border border-border')} />
      <Text className="w-16 text-xs text-muted-foreground" numberOfLines={1}>{item.key}</Text>
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>{item.title}</Text>
        {showBoard && item.board ? (
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{item.board.name}</Text>
        ) : null}
      </View>
      {item.column ? (
        <View className="rounded bg-muted px-1.5 py-0.5">
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{item.column.name}</Text>
        </View>
      ) : null}
      <WorkingIndicator working={item.working} showLabel={false} testID={`work-row-working-${item.key}`} />
      <View className="hidden w-32 flex-row items-center gap-1 md:flex">
        {item.assigneeAgentRef ? <Bot size={11} className="text-muted-foreground" /> : null}
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>{who ?? 'Unassigned'}</Text>
      </View>
      <Text className="w-8 text-right text-[11px] text-muted-foreground">{age(item.lastActivityAt)}</Text>
    </Pressable>
  )
}
