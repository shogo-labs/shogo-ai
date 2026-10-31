// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Check, FileText, KanbanSquare, MessageSquare, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ConversationDetail } from '../../lib/team-chat-api'
import type { Board } from '../../lib/work-boards-api'

/** Channels (not DMs or #activity) can have a doc and boards. */
export function channelSupportsDoc(conversation: Pick<ConversationDetail, 'kind'>): boolean {
  return conversation.kind === 'public' || conversation.kind === 'private'
}

export interface ChannelTabItem {
  key: string
  kind: 'messages' | 'board' | 'doc'
  label: string
  active: boolean
  onPress: () => void
  testID?: string
  /** A doc nobody has written yet: listed so it can be started, but not counted as a tab. */
  placeholder?: boolean
}

export interface ChannelTabsProps {
  conversation: ConversationDetail
  docOpen: boolean
  onOpenDoc: () => void
  onShowMessages: () => void
  boards?: Board[]
  activeBoardId?: string | null
  onOpenBoard?: (boardId: string) => void
  onAddBoard?: () => void
}

/** Messages, then each board, then the doc: the order the tabs read in. */
export function channelTabItems({ conversation, docOpen, onOpenDoc, onShowMessages, boards = [], activeBoardId = null, onOpenBoard }: ChannelTabsProps): ChannelTabItem[] {
  const hasDoc = !!conversation.hasDoc
  return [
    { key: 'messages', kind: 'messages', label: 'Messages', active: !docOpen && !activeBoardId, onPress: onShowMessages },
    ...boards.map((board): ChannelTabItem => ({
      key: board.id,
      kind: 'board',
      label: board.name,
      active: board.id === activeBoardId,
      onPress: () => onOpenBoard?.(board.id),
      testID: `channel-tab-board-${board.slug}`,
    })),
    { key: 'doc', kind: 'doc', label: hasDoc ? 'Doc' : 'Add doc', active: docOpen && !activeBoardId, onPress: onOpenDoc, placeholder: !hasDoc },
  ]
}

function TabIcon({ kind, active, size }: { kind: ChannelTabItem['kind']; active: boolean; size: number }) {
  const className = active ? 'text-foreground' : 'text-muted-foreground'
  if (kind === 'board') return <KanbanSquare size={size} className={className} />
  if (kind === 'doc') return <FileText size={size} className={className} />
  return <MessageSquare size={size} className={className} />
}

/** "Messages | boards… | Doc | +" tabs under a channel header. */
export function ChannelTabs(props: ChannelTabsProps) {
  const { boards = [], onAddBoard } = props
  const items = channelTabItems(props)
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="max-h-11 shrink-0 grow-0 border-b border-border"
      contentContainerClassName="items-center gap-1 px-3"
      accessibilityRole="tablist"
      testID="channel-tabs"
    >
      {items.map((item) => (
        <Tab key={item.key} label={item.label} active={item.active} onPress={item.onPress} testID={item.testID} icon={<TabIcon kind={item.kind} active={item.active} size={13} />} />
      ))}
      {onAddBoard ? (
        <Pressable
          onPress={onAddBoard}
          accessibilityRole="button"
          accessibilityLabel="Add board"
          testID="channel-add-board"
          className="flex-row items-center gap-1 rounded px-2.5 py-2 hover:bg-muted active:bg-muted"
        >
          <Plus size={16} className="text-muted-foreground" />
          {!boards.length ? <Text className="text-xs font-medium text-muted-foreground">Add board</Text> : null}
        </Pressable>
      ) : null}
    </ScrollView>
  )
}

/** The phone's version of the tabs: a list inside the header's glass panel. */
export function ChannelTabList({ items, onAddBoard, onSelect }: { items: ChannelTabItem[]; onAddBoard?: () => void; onSelect: (run: () => void) => void }) {
  return (
    <View accessibilityRole="tablist" testID="channel-tabs">
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => onSelect(item.onPress)}
          accessibilityRole="tab"
          aria-selected={item.active}
          accessibilityLabel={item.label}
          testID={item.testID}
          className={cn('min-h-11 flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-foreground/10', item.active && 'bg-foreground/10')}
        >
          <TabIcon kind={item.kind} active={item.active} size={18} />
          <Text className={cn('flex-1 text-[15px]', item.active ? 'font-semibold text-foreground' : 'text-foreground')} numberOfLines={1}>{item.label}</Text>
          {item.active ? <Check size={16} className="text-muted-foreground" /> : null}
        </Pressable>
      ))}
      {onAddBoard ? (
        <Pressable
          onPress={() => onSelect(onAddBoard)}
          accessibilityRole="button"
          accessibilityLabel="Add board"
          testID="channel-add-board"
          className="min-h-11 flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-foreground/10"
        >
          <Plus size={18} className="text-muted-foreground" />
          <Text className="flex-1 text-[15px] text-muted-foreground">Add board</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function Tab({ label, active, onPress, icon, testID }: { label: string; active: boolean; onPress: () => void; icon: React.ReactNode; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      aria-selected={active}
      accessibilityLabel={label}
      testID={testID}
      className={cn('flex-row items-center gap-1.5 border-b-2 px-2.5 py-2', active ? 'border-primary' : 'border-transparent hover:bg-muted')}
    >
      {icon}
      <Text className={cn('max-w-40 text-[13px] font-medium', active ? 'text-foreground' : 'text-muted-foreground')} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}
