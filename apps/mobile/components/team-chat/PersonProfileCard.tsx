// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A teammate's card, opened from a mention: name, title, status, local time,
 * and quick actions to message them or start a huddle.
 */
import { useEffect, useState } from 'react'
import { Image, Modal, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Clock, Headphones, MessageSquare, X } from 'lucide-react-native'
import { teamChatApi, type Mentionables } from '../../lib/team-chat-api'
import { joinHuddleCall } from '../../lib/huddle-call'
import { huddleMediaSupported } from '../../lib/huddle-media'
import { useMentionables } from '../../hooks/useTeamChat'
import { PresenceDot } from './PresenceDot'

const api = teamChatApi()

type Person = Mentionables['people'][number]

export interface PersonProfileCardProps {
  workspaceId: string
  person: Person
  status?: { emoji: string | null; text: string | null } | null
  me: string | null
  onClose: () => void
}

/** "3:04 PM" in `tz`, or null when the zone is unknown. */
export function localTimeIn(tz: string | null | undefined, now = new Date()): string | null {
  if (!tz) return null
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(now)
  } catch {
    return null
  }
}

export function PersonProfileCard({ workspaceId, person, status, me, onClose }: PersonProfileCardProps) {
  const router = useRouter()
  const [now, setNow] = useState(() => new Date())
  const [error, setError] = useState<string | null>(null)
  const isMe = person.id === me
  const localTime = localTimeIn(person.timezone, now)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const openDm = async (huddle: boolean) => {
    try {
      setError(null)
      const conversation = await api.openDm(workspaceId, [person.id])
      onClose()
      router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: conversation.id } } as any)
      if (huddle) void joinHuddleCall({ conversationId: conversation.id, workspaceId, label: person.name, kind: 'dm' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open a conversation')
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center p-6">
        <Pressable className="absolute inset-0 bg-black/30" onPress={onClose} accessibilityLabel="Close profile" />
        <View className="w-full max-w-[360px] rounded-xl border border-border bg-card p-4" testID="person-profile-card">
          <View className="flex-row items-start gap-3">
            {person.image ? (
              <Image source={{ uri: person.image }} style={{ width: 56, height: 56, borderRadius: 10 }} />
            ) : (
              <View className="h-14 w-14 items-center justify-center rounded-[10px] bg-muted">
                <Text className="text-lg font-semibold text-muted-foreground">{initials(person.name)}</Text>
              </View>
            )}
            <View className="min-w-0 flex-1">
              <View className="flex-row items-center gap-1.5">
                <Text className="shrink text-base font-semibold text-foreground" numberOfLines={2}>
                  {person.name}
                </Text>
                <PresenceDot userId={person.id} />
              </View>
              {person.title ? (
                <Text className="text-sm text-muted-foreground" numberOfLines={2} testID="person-title">
                  {person.title}
                </Text>
              ) : isMe ? (
                <Pressable
                  onPress={() => {
                    onClose()
                    router.push('/(app)/c/settings' as any)
                  }}
                  accessibilityRole="link"
                >
                  <Text className="text-sm text-primary">Add a title</Text>
                </Pressable>
              ) : null}
              {status?.emoji || status?.text ? (
                <Text className="mt-1 text-xs text-foreground" numberOfLines={2}>
                  {[status.emoji, status.text].filter(Boolean).join(' ')}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={onClose} accessibilityLabel="Close" className="rounded p-1 active:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          {localTime ? (
            <View className="mt-3 flex-row items-center gap-1.5">
              <Clock size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground" testID="person-local-time">
                {localTime} local time
              </Text>
            </View>
          ) : null}
          {person.email ? <Text className="mt-1 text-xs text-muted-foreground">{person.email}</Text> : null}

          {!isMe ? (
            <View className="mt-4 flex-row gap-2">
              <Pressable
                onPress={() => void openDm(false)}
                accessibilityRole="button"
                accessibilityLabel={`Message ${person.name}`}
                className="flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border py-2 active:bg-muted hover:bg-muted"
              >
                <MessageSquare size={14} className="text-foreground" />
                <Text className="text-xs font-medium text-foreground">Message</Text>
              </Pressable>
              {huddleMediaSupported ? (
                <Pressable
                  onPress={() => void openDm(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Huddle with ${person.name}`}
                  className="flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border py-2 active:bg-muted hover:bg-muted"
                >
                  <Headphones size={14} className="text-foreground" />
                  <Text className="text-xs font-medium text-foreground">Huddle</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
        </View>
      </View>
    </Modal>
  )
}

/** The card for a user id, looked up in the workspace's (cached) mentionables. */
export function PersonCardById({ workspaceId, userId, me, onClose }: { workspaceId: string; userId: string; me: string | null; onClose: () => void }) {
  const mentionables = useMentionables(workspaceId)
  const person = mentionables?.people.find((p) => p.id === userId)
  if (!person) return null
  return <PersonProfileCard workspaceId={workspaceId} person={person} status={mentionables?.statuses?.[userId]} me={me} onClose={onClose} />
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
}
