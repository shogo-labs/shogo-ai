// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Pressable, Text, View } from 'react-native'
import { FileText, MessageSquare } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ConversationDetail } from '../../lib/team-chat-api'

/** Channels (not DMs or #activity) can have a doc. */
export function channelSupportsDoc(conversation: Pick<ConversationDetail, 'kind'>): boolean {
  return conversation.kind === 'public' || conversation.kind === 'private'
}

/** "Messages | Doc" tabs under a channel header. */
export function ChannelTabs({
  conversation,
  docOpen,
  onOpenDoc,
  onShowMessages,
}: {
  conversation: ConversationDetail
  docOpen: boolean
  onOpenDoc: () => void
  onShowMessages: () => void
}) {
  const hasDoc = !!conversation.hasDoc
  return (
    <View className="flex-row items-center gap-1 border-b border-border px-3" accessibilityRole="tablist" testID="channel-tabs">
      <Tab label="Messages" active={!docOpen} onPress={onShowMessages} icon={<MessageSquare size={13} className={!docOpen ? 'text-foreground' : 'text-muted-foreground'} />} />
      <Tab
        label={hasDoc ? 'Doc' : 'Add doc'}
        active={docOpen}
        onPress={onOpenDoc}
        icon={<FileText size={13} className={docOpen ? 'text-foreground' : 'text-muted-foreground'} />}
      />
    </View>
  )
}

function Tab({ label, active, onPress, icon }: { label: string; active: boolean; onPress: () => void; icon: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      aria-selected={active}
      accessibilityLabel={label}
      className={cn('flex-row items-center gap-1.5 border-b-2 px-2 py-1.5', active ? 'border-primary' : 'border-transparent hover:bg-muted')}
    >
      {icon}
      <Text className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>{label}</Text>
    </Pressable>
  )
}
