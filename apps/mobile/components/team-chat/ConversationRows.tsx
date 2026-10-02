// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Rows and section headers shared by the Channels, DMs and Home panels, on
 * desktop and mobile. People and agents use the same row: a person shows a
 * presence dot, an agent shows a bot mark.
 */
import { useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Bot, ChevronDown, ChevronRight, Hash, Lock, Pencil, Plus, Radio, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { densityFor } from '../../lib/phone-density'
import { usePhoneLayout } from '../../lib/native-phone-layout'
import { conversationTitle, type ConversationSummary } from '../../lib/team-chat-api'
import { useHasDraft } from '../../hooks/useChatItems'
import { PresenceDot } from './PresenceDot'

export function conversationHref(id: string): string {
  return `/(app)/c/${encodeURIComponent(id)}`
}

export function hasAgent(c: Pick<ConversationSummary, 'participants'>): boolean {
  return (c.participants ?? []).some((p) => p.type === 'agent')
}

export function iconFor(c: ConversationSummary) {
  if (c.kind === 'activity') return Radio
  if (c.kind === 'private') return Lock
  if (c.kind === 'public') return Hash
  if (hasAgent(c)) return Bot
  return Users
}

export function rowTitle(c: ConversationSummary): string {
  return c.kind === 'public' || c.kind === 'private' || c.kind === 'activity' ? c.name ?? 'channel' : conversationTitle(c)
}

/** Unread that should draw attention: mentions anywhere, any unread in a DM. */
export function attentionCount(c: ConversationSummary): number {
  if (c.muted) return 0
  if (c.mentionCount) return c.mentionCount
  return c.kind === 'dm' || c.kind === 'group_dm' ? c.unreadCount : 0
}

export function CountPill({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <View className="min-w-[18px] items-center rounded-full bg-destructive px-1.5" testID="count-pill">
      <Text className="text-[10px] font-semibold text-white">{count > 99 ? '99+' : count}</Text>
    </View>
  )
}

function DraftMark({ conversationId }: { conversationId: string }) {
  const hasDraft = useHasDraft(conversationId)
  return hasDraft ? <Pencil size={11} className="text-muted-foreground" accessibilityLabel="Draft" /> : null
}

export interface ConversationRowProps {
  conversation: ConversationSummary
  workspaceId: string
  active?: boolean
  /** Show the newest message under the name (direct messages carry one). */
  preview?: boolean
  onPress: (c: ConversationSummary) => void
}

export function ConversationRow({ conversation: c, workspaceId, active = false, preview = false, onPress }: ConversationRowProps) {
  const comfortable = usePhoneLayout()
  const density = densityFor(comfortable)
  const Icon = iconFor(c)
  const unread = !active && c.unreadCount > 0 && !c.muted && c.joined
  const title = rowTitle(c)
  const peers = c.kind === 'dm' ? c.participants ?? [] : []
  const dmPeer = peers.length === 1 && peers[0]!.type === 'user' ? peers[0]!.id : null
  const mentions = !active ? c.mentionCount : 0
  return (
    <Pressable
      onPress={() => onPress(c)}
      accessibilityRole="link"
      accessibilityLabel={`${title}${c.mentionCount ? `, ${c.mentionCount} mentions` : unread ? ', unread' : ''}`}
      className={cn(
        'flex-row items-center rounded-md',
        comfortable ? `${density.rowMin} gap-3 px-3 py-2` : 'gap-2 px-2 py-1',
        active ? 'bg-accent' : 'active:bg-accent/50',
      )}
    >
      {dmPeer ? (
        <View style={{ width: comfortable ? density.icon.nav : 12 }} className="items-center">
          <PresenceDot userId={dmPeer} workspaceId={workspaceId} />
        </View>
      ) : (
        <Icon size={comfortable ? density.icon.nav : 12} className={active || unread ? 'text-foreground' : 'text-muted-foreground'} />
      )}
      <View className="min-w-0 flex-1">
        <Text
          className={cn(comfortable ? density.text.body : 'text-xs', active || unread ? 'text-foreground' : 'text-muted-foreground', unread && 'font-semibold')}
          numberOfLines={1}
        >
          {title}
        </Text>
        {preview && c.lastMessage?.preview ? (
          <Text className={cn('text-xs', unread ? 'text-foreground' : 'text-muted-foreground')} numberOfLines={1} testID="conversation-preview">
            {c.lastMessage.preview}
          </Text>
        ) : null}
      </View>
      {!active && <DraftMark conversationId={c.id} />}
      <CountPill count={mentions} />
    </Pressable>
  )
}

export interface PanelSectionProps {
  label: string
  addLabel?: string
  onAdd?: () => void
  /** Hide the chevron and keep the section open. */
  fixed?: boolean
  children: ReactNode
}

/** A collapsible, labelled group of rows with an optional "+" action. */
export function PanelSection({ label, addLabel, onAdd, fixed, children }: PanelSectionProps) {
  const comfortable = usePhoneLayout()
  const density = densityFor(comfortable)
  const [expanded, setExpanded] = useState(true)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <View className="mb-2">
      <View className="flex-row items-center">
        <Pressable
          onPress={() => !fixed && setExpanded((v) => !v)}
          accessibilityRole="button"
          aria-expanded={expanded}
          accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          className="flex-1 flex-row items-center gap-1.5 rounded-md px-1 py-1 active:bg-accent/50"
        >
          <Text className={cn('flex-1 font-semibold uppercase tracking-wider text-muted-foreground', density.text.label)}>{label}</Text>
          {!fixed && <Chevron size={12} className="text-muted-foreground" />}
        </Pressable>
        {onAdd && (
          <Pressable onPress={onAdd} accessibilityRole="button" accessibilityLabel={addLabel} className="rounded-md p-1 active:bg-accent/50 hover:bg-accent/50">
            <Plus size={12} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>
      {(expanded || fixed) && children}
    </View>
  )
}

export interface PanelLinkProps {
  icon: React.ElementType
  label: string
  count?: number
  onPress: () => void
}

/** A plain action row: an icon, a label and an optional count. */
export function PanelLink({ icon: Icon, label, count = 0, onPress }: PanelLinkProps) {
  const comfortable = usePhoneLayout()
  const density = densityFor(comfortable)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count ? `${label}, ${count} unread` : label}
      onPress={onPress}
      className={cn('flex-row items-center rounded-md active:bg-accent/50', comfortable ? `${density.rowMin} gap-3 px-3 py-2` : 'gap-2 px-2 py-1')}
    >
      <Icon size={comfortable ? density.icon.nav : 12} className={count ? 'text-foreground' : 'text-muted-foreground'} />
      <Text className={cn('flex-1', count ? 'font-semibold text-foreground' : 'text-muted-foreground', comfortable ? density.text.body : 'text-xs')}>{label}</Text>
      <CountPill count={count} />
    </Pressable>
  )
}
