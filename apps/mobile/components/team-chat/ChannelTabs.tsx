// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Pressable, ScrollView, Text } from 'react-native'
import { FileText, KanbanSquare, MessageSquare, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ConversationDetail } from '../../lib/team-chat-api'
import type { Board } from '../../lib/work-boards-api'

/** Channels (not DMs or #activity) can have a doc and boards. */
export function channelSupportsDoc(conversation: Pick<ConversationDetail, 'kind'>): boolean {
  return conversation.kind === 'public' || conversation.kind === 'private'
}

/** "Messages | boards… | Doc | +" tabs under a channel header. */
export function ChannelTabs({
  conversation,
  docOpen,
  onOpenDoc,
  onShowMessages,
  boards = [],
  activeBoardId = null,
  onOpenBoard,
  onAddBoard,
}: {
  conversation: ConversationDetail
  docOpen: boolean
  onOpenDoc: () => void
  onShowMessages: () => void
  boards?: Board[]
  activeBoardId?: string | null
  onOpenBoard?: (boardId: string) => void
  onAddBoard?: () => void
}) {
  const hasDoc = !!conversation.hasDoc
  const messagesActive = !docOpen && !activeBoardId
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="max-h-10 shrink-0 grow-0 border-b border-border"
      contentContainerClassName="items-center gap-1 px-3"
      accessibilityRole="tablist"
      testID="channel-tabs"
    >
      <Tab label="Messages" active={messagesActive} onPress={onShowMessages} icon={<MessageSquare size={13} className={messagesActive ? 'text-foreground' : 'text-muted-foreground'} />} />
      {boards.map((board) => {
        const active = board.id === activeBoardId
        return (
          <Tab
            key={board.id}
            label={board.name}
            active={active}
            onPress={() => onOpenBoard?.(board.id)}
            testID={`channel-tab-board-${board.slug}`}
            icon={<KanbanSquare size={13} className={active ? 'text-foreground' : 'text-muted-foreground'} />}
          />
        )
      })}
      <Tab
        label={hasDoc ? 'Doc' : 'Add doc'}
        active={docOpen && !activeBoardId}
        onPress={onOpenDoc}
        icon={<FileText size={13} className={docOpen && !activeBoardId ? 'text-foreground' : 'text-muted-foreground'} />}
      />
      {onAddBoard ? (
        <Pressable
          onPress={onAddBoard}
          accessibilityRole="button"
          accessibilityLabel="Add board"
          testID="channel-add-board"
          className="flex-row items-center gap-1 rounded px-2 py-1.5 hover:bg-muted"
        >
          <Plus size={13} className="text-muted-foreground" />
          {!boards.length ? <Text className="text-xs font-medium text-muted-foreground">Add board</Text> : null}
        </Pressable>
      ) : null}
    </ScrollView>
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
      className={cn('flex-row items-center gap-1.5 border-b-2 px-2 py-1.5', active ? 'border-primary' : 'border-transparent hover:bg-muted')}
    >
      {icon}
      <Text className={cn('max-w-40 text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}
