// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The "Create a channel" form, shared by the modal (wide) and the `/c/new` screen (phone). */
import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { Check, Hash, Lock } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ConversationSummary } from '../../lib/team-chat-api'

export function NewChannelForm({
  workspaceId,
  autoFocus,
  onCreated,
}: {
  workspaceId: string
  autoFocus?: boolean
  onCreated: (conversation: ConversationSummary) => void
}) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await teamChatApi().createChannel(workspaceId, {
          name: name.trim(),
          kind: isPrivate ? 'private' : 'public',
          topic: topic.trim() || undefined,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="gap-3" testID="new-channel-form">
      <View>
        <Text className="mb-1 text-xs font-medium text-muted-foreground">Name</Text>
        <View className="flex-row items-center rounded-md border border-border px-3">
          {isPrivate ? <Lock size={14} className="text-muted-foreground" /> : <Hash size={14} className="text-muted-foreground" />}
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus={autoFocus}
            placeholder="e.g. launch-plan"
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Channel name"
            className="flex-1 px-2 py-2 text-sm text-foreground"
            maxLength={80}
          />
        </View>
      </View>
      <View>
        <Text className="mb-1 text-xs font-medium text-muted-foreground">Topic (optional)</Text>
        <TextInput
          value={topic}
          onChangeText={setTopic}
          placeholder="What is this channel about?"
          placeholderTextColor="#8a8a8a"
          accessibilityLabel="Channel topic"
          className="rounded-md border border-border px-3 py-2 text-sm text-foreground"
          maxLength={250}
        />
      </View>
      <Pressable onPress={() => setIsPrivate((v) => !v)} className="flex-row items-center gap-2">
        <View className={cn('h-4 w-4 items-center justify-center rounded border', isPrivate ? 'border-primary bg-primary' : 'border-border')}>
          {isPrivate && <Check size={11} className="text-primary-foreground" />}
        </View>
        <View className="flex-1">
          <Text className="text-sm text-foreground">Make private</Text>
          <Text className="text-xs text-muted-foreground">Only invited people can find and read it.</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create channel"
        disabled={!name.trim() || busy}
        onPress={() => void submit()}
        className={cn('mt-1 items-center rounded-md py-2.5', name.trim() ? 'bg-primary' : 'bg-muted')}
      >
        {busy ? (
          <ActivityIndicator size="small" />
        ) : (
          <Text className={cn('text-sm font-medium', name.trim() ? 'text-primary-foreground' : 'text-muted-foreground')}>Create channel</Text>
        )}
      </Pressable>
      {error && <Text className="text-xs text-destructive">{error}</Text>}
    </View>
  )
}
