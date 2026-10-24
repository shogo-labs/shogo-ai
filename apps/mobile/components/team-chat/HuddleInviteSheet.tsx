// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Add people" for the huddle you're in: pick teammates and ring them in.
 * They join the huddle, not the conversation it lives in, so this works for
 * people who aren't in the channel.
 */
import { useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Check, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import { cancelHuddleCallInvite, inviteToHuddleCall } from '../../lib/huddle-call'
import type { Huddle } from '../../lib/team-chat-api'
import { PresenceDot } from './PresenceDot'

export interface InvitablePerson {
  id: string
  name: string
  email: string
}

/**
 * Teammates who can be rung in: everyone but you and people already in the
 * call, matching the search. Pure so the filtering is easy to test.
 */
export function invitablePeople(
  people: InvitablePerson[],
  me: string | null,
  huddle: Pick<Huddle, 'participants'> | null,
  query: string,
): InvitablePerson[] {
  const q = query.trim().toLowerCase()
  const inCall = new Set((huddle?.participants ?? []).map((p) => p.userId))
  return people.filter(
    (p) => p.id !== me && !inCall.has(p.id) && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
  )
}

export function HuddleInviteSheet({
  workspaceId,
  huddle,
  onClose,
}: {
  workspaceId: string
  huddle: Huddle | null
  onClose: () => void
}) {
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const people = useMemo(() => invitablePeople(mentionables?.people ?? [], me, huddle, query), [mentionables, me, huddle, query])
  const ringing = new Map((huddle?.invited ?? []).filter((i) => i.status === 'ringing').map((i) => [i.userId, i]))

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const ring = async () => {
    if (!selected.length || busy) return
    setBusy(true)
    setError(null)
    try {
      await inviteToHuddleCall(selected)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not invite them')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[80%] w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}} testID="huddle-invite-sheet">
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">Add people to this huddle</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="Search people"
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Search people"
            className="mb-2 rounded-md border border-border px-3 py-2.5 text-base text-foreground"
          />
          <ScrollView className="max-h-80" keyboardShouldPersistTaps="handled">
            {people.map((p) => {
              const on = selected.includes(p.id)
              const pending = ringing.get(p.id)
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${p.name}, ${p.email}${pending ? ', ringing' : ''}`}
                  onPress={() => toggle(p.id)}
                  className="min-h-12 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                >
                  <View className={cn('h-5 w-5 items-center justify-center rounded border', on ? 'border-primary bg-primary' : 'border-border')}>
                    {on ? <Check size={13} className="text-primary-foreground" /> : null}
                  </View>
                  <View className="w-3.5 items-center">
                    <PresenceDot userId={p.id} workspaceId={workspaceId} />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm text-foreground" numberOfLines={1}>{p.name}</Text>
                    <Text className="text-xs text-muted-foreground" numberOfLines={1}>{p.email}</Text>
                  </View>
                  {pending ? (
                    <Pressable
                      onPress={() => void cancelHuddleCallInvite(p.id).catch(() => {})}
                      accessibilityRole="button"
                      accessibilityLabel={`Cancel invitation to ${p.name}`}
                      hitSlop={6}
                    >
                      <Text className="text-xs font-medium text-emerald-600">Ringing · Cancel</Text>
                    </Pressable>
                  ) : null}
                </Pressable>
              )
            })}
            {!people.length ? <Text className="px-2 py-4 text-sm text-muted-foreground">No one else to invite.</Text> : null}
          </ScrollView>
          {selected.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Ring ${selected.length} ${selected.length === 1 ? 'person' : 'people'}`}
              disabled={busy}
              onPress={() => void ring()}
              className="mt-3 items-center rounded-md bg-emerald-600 py-3 active:opacity-80"
            >
              {busy ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className="text-sm font-medium text-white">Ring {selected.length} {selected.length === 1 ? 'person' : 'people'}</Text>
              )}
            </Pressable>
          ) : null}
          {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
        </Pressable>
      </Pressable>
    </Modal>
  )
}
