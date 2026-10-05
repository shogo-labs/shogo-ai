// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-wide chat setup shown on the preferences screen: user groups
 * for `@team` mentions and custom emoji.
 */
import { useEffect, useRef, useState } from 'react'
import { Image, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Trash2, Users, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type Mentionables, type UserGroup } from '../../lib/team-chat-api'
import { useCustomEmoji } from '../../hooks/useCustomEmoji'

const api = teamChatApi()

export function UserGroupsCard({ workspaceId, mentionables }: { workspaceId: string; mentionables: Mentionables | null }) {
  const [groups, setGroups] = useState<UserGroup[]>(mentionables?.groups ?? [])
  const [editing, setEditing] = useState<UserGroup | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mentionables?.groups) setGroups(mentionables.groups)
  }, [mentionables?.groups])

  const people = mentionables?.people ?? []
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Someone'

  return (
    <View>
      {groups.map((g) => (
        <Pressable
          key={g.id}
          onPress={() => setEditing(g)}
          className="mb-1 flex-row items-center gap-3 rounded-md px-1 py-1.5 active:bg-accent/50 web:hover:bg-accent/40"
        >
          <Users size={14} className="text-muted-foreground" />
          <View className="flex-1">
            <Text className="text-sm text-foreground">@{g.handle} <Text className="text-xs text-muted-foreground">{g.name}</Text></Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {g.memberIds.length ? g.memberIds.map(nameOf).join(', ') : 'No members yet'}
            </Text>
          </View>
        </Pressable>
      ))}
      {!groups.length ? (
        <Text className="mb-2 text-xs text-muted-foreground">Create groups like @design or @oncall to notify several people at once.</Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => setEditing('new')} className="mt-1 self-start rounded-md border border-border px-3 py-1.5 active:bg-accent/50">
        <Text className="text-xs text-foreground">New group</Text>
      </Pressable>
      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
      {editing ? (
        <GroupEditor
          group={editing === 'new' ? null : editing}
          people={people}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            try {
              setError(null)
              const saved = editing === 'new'
                ? await api.createGroup(workspaceId, input)
                : await api.updateGroup(editing.id, input)
              setGroups((list) => [...list.filter((g) => g.id !== saved.id), saved].sort((a, b) => a.handle.localeCompare(b.handle)))
              setEditing(null)
            } catch (err: any) {
              setError(err?.message ?? 'Could not save the group')
            }
          }}
          onDelete={editing === 'new' ? undefined : async () => {
            try {
              await api.deleteGroup(editing.id)
              setGroups((list) => list.filter((g) => g.id !== editing.id))
              setEditing(null)
            } catch (err: any) {
              setError(err?.message ?? 'Could not delete the group')
            }
          }}
        />
      ) : null}
    </View>
  )
}

function GroupEditor({
  group,
  people,
  onClose,
  onSave,
  onDelete,
}: {
  group: UserGroup | null
  people: Mentionables['people']
  onClose: () => void
  onSave: (input: { handle: string; name: string; memberIds: string[] }) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const [handle, setHandle] = useState(group?.handle ?? '')
  const [name, setName] = useState(group?.name ?? '')
  const [members, setMembers] = useState<Set<string>>(new Set(group?.memberIds ?? []))
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const shown = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))

  return (
    <View className="mt-3 rounded-md border border-border p-3">
      <View className="mb-2 flex-row items-center">
        <Text className="flex-1 text-sm font-semibold text-foreground">{group ? `Edit @${group.handle}` : 'New group'}</Text>
        <Pressable onPress={onClose} accessibilityLabel="Close">
          <X size={14} className="text-muted-foreground" />
        </Pressable>
      </View>
      <View className="flex-row gap-2">
        <TextInput
          value={handle}
          onChangeText={(v) => setHandle(v.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
          placeholder="handle"
          placeholderTextColor="#8a8a8a"
          accessibilityLabel="Group handle"
          className="w-36 rounded-md border border-border px-2 py-1.5 text-sm text-foreground"
        />
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Display name"
          placeholderTextColor="#8a8a8a"
          accessibilityLabel="Group name"
          className="flex-1 rounded-md border border-border px-2 py-1.5 text-sm text-foreground"
        />
      </View>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="Filter people"
        placeholderTextColor="#8a8a8a"
        className="mt-2 rounded-md border border-border px-2 py-1.5 text-xs text-foreground"
      />
      <View className="mt-1 max-h-56">
        {shown.map((p) => {
          const on = members.has(p.id)
          return (
            <Pressable
              key={p.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => setMembers((set) => {
                const next = new Set(set)
                if (on) next.delete(p.id)
                else next.add(p.id)
                return next
              })}
              className="flex-row items-center gap-2 rounded px-1 py-1 active:bg-muted"
            >
              <View className={cn('h-3.5 w-3.5 rounded border', on ? 'border-primary bg-primary' : 'border-border')} />
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>{p.name}</Text>
            </Pressable>
          )
        })}
      </View>
      <View className="mt-3 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          disabled={handle.length < 2}
          onPress={() => void onSave({ handle, name: name || handle, memberIds: [...members] })}
          className={cn('rounded-md bg-primary px-3 py-1.5', handle.length < 2 && 'opacity-50')}
        >
          <Text className="text-xs font-semibold text-primary-foreground">Save</Text>
        </Pressable>
        {onDelete ? (
          <Pressable accessibilityRole="button" onPress={() => void onDelete()} className="rounded-md px-3 py-1.5 active:bg-accent/50">
            <Text className="text-xs text-destructive">Delete group</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

export function CustomEmojiCard({ workspaceId }: { workspaceId: string }) {
  const emoji = useCustomEmoji(workspaceId)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const isWeb = Platform.OS === 'web'

  const upload = async (file: File | { uri: string; name: string; type: string }) => {
    const clean = name.trim().replace(/^:|:$/g, '').toLowerCase()
    if (!clean) {
      setError('Name the emoji first')
      return
    }
    setBusy(true)
    try {
      await api.uploadEmoji(workspaceId, clean, file)
      setName('')
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const pick = () => {
    if (isWeb) {
      fileRef.current?.click()
      return
    }
    void (async () => {
      const { getDocumentAsync } = await import('expo-document-picker')
      const result = await getDocumentAsync({ type: ['image/png', 'image/gif', 'image/jpeg', 'image/webp'], copyToCacheDirectory: true })
      if (result.canceled || !result.assets[0]) return
      const doc = result.assets[0]
      await upload({ uri: doc.uri, name: doc.name, type: doc.mimeType || 'image/png' })
    })()
  }

  return (
    <View>
      <View className="flex-row flex-wrap gap-2">
        {[...emoji.values()].map((e) => (
          <View key={e.id} className="flex-row items-center gap-1.5 rounded-md border border-border px-2 py-1">
            <Image source={{ uri: e.url }} style={{ width: 20, height: 20 }} accessibilityLabel={`:${e.name}:`} />
            <Text className="text-xs text-foreground">:{e.name}:</Text>
            <Pressable
              accessibilityLabel={`Remove :${e.name}:`}
              onPress={() => void api.deleteEmoji(e.id).catch((err) => setError(err?.message ?? 'Could not remove'))}
              hitSlop={6}
            >
              <Trash2 size={12} className="text-muted-foreground" />
            </Pressable>
          </View>
        ))}
        {!emoji.size ? <Text className="text-xs text-muted-foreground">No custom emoji yet.</Text> : null}
      </View>
      <View className="mt-3 flex-row items-center gap-2">
        <TextInput
          value={name}
          onChangeText={(v) => setName(v.toLowerCase().replace(/[^a-z0-9_+:-]/g, ''))}
          placeholder="name, e.g. shipit"
          placeholderTextColor="#8a8a8a"
          accessibilityLabel="Emoji name"
          className="w-44 rounded-md border border-border px-2 py-1.5 text-sm text-foreground"
        />
        <Pressable accessibilityRole="button" onPress={pick} disabled={busy} className={cn('rounded-md border border-border px-3 py-1.5 active:bg-accent/50', busy && 'opacity-50')}>
          <Text className="text-xs text-foreground">{busy ? 'Uploading…' : 'Upload image'}</Text>
        </Pressable>
      </View>
      <Text className="mt-1 text-[11px] text-muted-foreground">PNG, GIF, JPEG, or WebP up to 256 KB. Use it as :name: in messages and reactions.</Text>
      {error ? <Text className="mt-1 text-xs text-destructive">{error}</Text> : null}
      {isWeb ? (
        <input
          ref={fileRef as any}
          type="file"
          accept="image/png,image/gif,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            if (f) void upload(f)
          }}
        />
      ) : null}
    </View>
  )
}
