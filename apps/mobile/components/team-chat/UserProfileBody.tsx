// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a person's profile says: their photo, whether they are around, their
 * local time, and the things you can do with them (message, huddle). Shared by
 * the side pane and the full-screen page so the two cannot drift.
 *
 * Everything but the chrome lives here — the hosts differ only in how they
 * frame it.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { Check, Clock, Copy, Headphones, Mail, MessageSquare, ShieldCheck } from 'lucide-react-native'
import { teamChatApi, conversationTitle, isSelfDm, type ConversationSummary, type PresenceStatus, type UserCard } from '../../lib/team-chat-api'
import { useConversationList, useMyUserId } from '../../hooks/useTeamChat'
import { usePresence } from '../../hooks/usePresence'
import { useUserStatus } from '../../hooks/useChatPrefs'
import { useOpenUserDm } from '../../lib/use-open-user-dm'
import { joinHuddleCall } from '../../lib/huddle-call'
import { directConversations } from '../../lib/dm-list'
import { UserAvatar } from './UserAvatar'

const api = teamChatApi()

/** Loads a person's profile card. `failed` distinguishes "gone" from "loading". */
export function useUserCard(workspaceId: string | null | undefined, userId: string | null | undefined) {
  const [card, setCard] = useState<UserCard | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!workspaceId || !userId) return
    let live = true
    setCard(null)
    setFailed(false)
    api.userCard(workspaceId, userId)
      .then((c) => { if (live) setCard(c) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [workspaceId, userId])

  return { card, failed }
}

const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  active: 'Active',
  away: 'Away',
  offline: 'Offline',
}

const ROLE_LABEL: Record<string, string> = { owner: 'OWNER', admin: 'ADMIN' }

/** The DMs you already have with this person, most recent first. */
export function conversationsWith(list: ConversationSummary[], userId: string, limit = 4): ConversationSummary[] {
  return directConversations(list)
    .filter((c) => (c.participants ?? []).some((p) => p.type === 'user' && p.id === userId))
    .slice(0, limit)
}

export function UserProfileBody({
  workspaceId,
  userId,
  avatarSize = 96,
  onClose,
}: {
  workspaceId: string
  userId: string
  avatarSize?: number
  /** Called after a navigation the host may need to leave for (e.g. a new DM). */
  onClose?: () => void
}) {
  const router = useRouter()
  const me = useMyUserId()
  const { card, failed } = useUserCard(workspaceId, userId)
  const presence = usePresence(workspaceId, userId)
  const liveStatus = useUserStatus(workspaceId, userId)
  // The live feed wins; the card's copy keeps the page honest when the feed
  // for this workspace is not mounted.
  const status = liveStatus ?? card?.status ?? null
  const { list } = useConversationList(workspaceId)
  const { openUserDm, opening } = useOpenUserDm(workspaceId)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copyEmail = useCallback(async (email: string) => {
    try {
      await Clipboard.setStringAsync(email)
      setCopied(true)
    } catch {
      // Best effort: leave the row alone rather than claim a copy that failed.
    }
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const message = useCallback(async () => {
    setError(null)
    const conversation = await openUserDm(userId)
    if (conversation) onClose?.()
    else setError('Couldn’t open that conversation. Try again.')
  }, [openUserDm, userId, onClose])

  /**
   * A huddle belongs to a conversation, so this opens the DM first and rings
   * it — the same thing the header's huddle button does inside that DM.
   */
  const huddle = useCallback(async () => {
    setError(null)
    const conversation = await openUserDm(userId, { navigate: () => {} })
    if (!conversation) {
      setError('Couldn’t start the huddle. Try again.')
      return
    }
    await joinHuddleCall({
      conversationId: conversation.id,
      workspaceId,
      label: card?.name ?? 'Direct message',
      kind: conversation.kind,
    })
    onClose?.()
  }, [openUserDm, userId, workspaceId, card?.name, onClose])

  if (!card) {
    return (
      <View className="flex-1 items-center justify-center py-10">
        {failed ? (
          <Text className="px-6 text-center text-sm text-muted-foreground">Couldn’t load this profile.</Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    )
  }

  const statusLine = [presence ? PRESENCE_LABEL[presence] : null, status?.dnd ? 'notifications snoozed' : null]
    .filter(Boolean)
    .join(', ')
  const recent = conversationsWith(list, card.id)
  const seeAll = () => router.push({ pathname: '/(app)/c/search', params: { q: `in:@${card.handle}` } } as any)

  return (
    <ScrollView contentContainerClassName="gap-5 px-4 pb-8 pt-4">
      <View className="items-center gap-2">
        <UserAvatar name={card.name} image={card.image} size={avatarSize} />
        <View className="flex-row items-center gap-1.5">
          <Text className="text-xl font-semibold text-foreground" numberOfLines={2}>
            {card.name}
          </Text>
          {status?.emoji ? <Text className="text-base">{status.emoji}</Text> : null}
        </View>
        <View className="flex-row flex-wrap items-center justify-center gap-1.5">
          {card.isSelf ? (
            <View className="rounded bg-muted px-1.5 py-px">
              <Text className="text-[10px] font-medium text-muted-foreground">YOU</Text>
            </View>
          ) : null}
          {ROLE_LABEL[card.role] ? (
            <View className="flex-row items-center gap-1 rounded bg-primary/10 px-1.5 py-px">
              <ShieldCheck size={10} className="text-primary" />
              <Text className="text-[10px] font-medium text-primary">{ROLE_LABEL[card.role]}</Text>
            </View>
          ) : null}
        </View>
        {statusLine ? <Text className="text-xs text-muted-foreground">{statusLine}</Text> : null}
        {status?.text ? (
          <Text className="text-center text-xs text-muted-foreground" numberOfLines={2}>
            {status.text}
          </Text>
        ) : null}
      </View>

      {card.localTimeLabel ? (
        <View className="flex-row items-center gap-2">
          <Clock size={14} className="text-muted-foreground" />
          <Text testID="user-profile-local-time" className="text-xs text-muted-foreground">
            {card.localTimeLabel}
          </Text>
        </View>
      ) : null}

      {!card.isSelf ? (
        <View className="flex-row flex-wrap gap-2">
          <ProfileAction
            label="Message"
            Icon={MessageSquare}
            onPress={message}
            disabled={opening}
            testID="user-profile-message"
          />
          <ProfileAction
            label="Huddle"
            Icon={Headphones}
            onPress={() => void huddle()}
            disabled={opening}
            testID="user-profile-huddle"
          />
        </View>
      ) : null}

      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}

      <View className="gap-1">
        <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Contact information</Text>
        <Pressable
          onPress={() => void copyEmail(card.email)}
          accessibilityRole="button"
          accessibilityLabel={`Copy email address ${card.email}`}
          className="flex-row items-center gap-2 py-1 active:bg-muted"
        >
          <View className="items-center justify-center rounded border border-border p-1.5">
            <Mail size={12} className="text-muted-foreground" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-[11px] text-muted-foreground">Email Address</Text>
            <Text className="text-sm text-foreground" numberOfLines={1}>{card.email}</Text>
          </View>
          {copied ? <Check size={14} className="text-primary" /> : <Copy size={14} className="text-muted-foreground" />}
        </Pressable>
      </View>

      <View className="gap-1">
        <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Recent DMs</Text>
        {recent.length === 0 ? (
          <Text className="py-1 text-sm text-muted-foreground">No conversations with {card.name} yet.</Text>
        ) : (
          recent.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => {
                router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: c.id } } as any)
                onClose?.()
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open conversation with ${conversationTitle(c)}`}
              className="flex-row items-center gap-2 rounded-lg px-1 py-1.5 active:bg-muted"
            >
              <View className="flex-row">
                {(c.participants ?? [])
                  .filter((p): p is Extract<typeof p, { type: 'user' }> => p.type === 'user' && p.id !== me)
                  .slice(0, 3)
                  .map((p) => (
                    <UserAvatar key={p.id} name={p.name} image={p.image} size={24} />
                  ))}
              </View>
              <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                {isSelfDm(c) ? 'Note to self' : conversationTitle(c)}
              </Text>
            </Pressable>
          ))
        )}
        <Pressable onPress={seeAll} accessibilityRole="button" className="py-1">
          <Text className="text-xs text-primary">See all conversations with {card.name}</Text>
        </Pressable>
      </View>
    </ScrollView>
  )
}

function ProfileAction({
  label,
  Icon,
  onPress,
  disabled,
  testID,
}: {
  label: string
  Icon: typeof MessageSquare
  onPress: () => void
  disabled?: boolean
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`min-w-[104px] flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 active:bg-muted ${disabled ? 'opacity-60' : ''}`}
    >
      <Icon size={14} className="text-foreground" />
      <Text className="text-sm font-medium text-foreground">{label}</Text>
    </Pressable>
  )
}
