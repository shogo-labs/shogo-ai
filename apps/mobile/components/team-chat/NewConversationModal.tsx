// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Bot, Check, Hash, Lock, User, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ConversationSummary, type Mentionables } from '../../lib/team-chat-api'

const api = teamChatApi()

export type NewConversationMode = 'channel' | 'dm' | 'agent'

export interface NewConversationModalProps {
  workspaceId: string
  mode: NewConversationMode
  mentionables: Mentionables | null
  me: string | null
  onClose: () => void
  onCreated: (conversation: ConversationSummary) => void
}

const TITLES: Record<NewConversationMode, string> = {
  channel: 'Create a channel',
  dm: 'New message',
  agent: 'Message an agent',
}

export function NewConversationModal({ workspaceId, mode, mentionables, me, onClose, onCreated }: NewConversationModalProps) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (fn: () => Promise<ConversationSummary>) => {
    setBusy(true)
    setError(null)
    try {
      onCreated(await fn())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const q = filter.trim().toLowerCase()
  const people = (mentionables?.people ?? []).filter(
    (p) => p.id !== me && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
  )
  const agents = (mentionables?.agents ?? []).filter((a) => !q || a.name.toLowerCase().includes(q))

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[80%] w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-4 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">{TITLES[mode]}</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          {mode === 'channel' ? (
            <View className="gap-3">
              <View>
                <Text className="mb-1 text-xs font-medium text-muted-foreground">Name</Text>
                <View className="flex-row items-center rounded-md border border-border px-3">
                  {isPrivate ? <Lock size={14} className="text-muted-foreground" /> : <Hash size={14} className="text-muted-foreground" />}
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    autoFocus
                    placeholder="e.g. launch-plan"
                    placeholderTextColor="#8a8a8a"
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
                disabled={!name.trim() || busy}
                onPress={() =>
                  submit(() => api.createChannel(workspaceId, { name: name.trim(), kind: isPrivate ? 'private' : 'public', topic: topic.trim() || undefined }))
                }
                className={cn('mt-1 items-center rounded-md py-2', name.trim() ? 'bg-primary' : 'bg-muted')}
              >
                {busy ? <ActivityIndicator size="small" /> : <Text className={cn('text-sm font-medium', name.trim() ? 'text-primary-foreground' : 'text-muted-foreground')}>Create channel</Text>}
              </Pressable>
            </View>
          ) : (
            <View className="min-h-0 flex-shrink">
              <TextInput
                value={filter}
                onChangeText={setFilter}
                autoFocus
                placeholder={mode === 'agent' ? 'Search agents' : 'Search people'}
                placeholderTextColor="#8a8a8a"
                className="mb-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
              />
              <ScrollView className="max-h-80">
                {mode === 'agent'
                  ? agents.map((a) => (
                      <Pressable
                        key={a.key}
                        disabled={busy}
                        onPress={() => submit(() => api.openAgentDm(workspaceId, a.projectId))}
                        className="flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                      >
                        <Bot size={16} className="text-primary" />
                        <View className="min-w-0 flex-1">
                          <Text className="text-sm text-foreground">{a.name}</Text>
                          {a.description ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{a.description}</Text> : null}
                        </View>
                      </Pressable>
                    ))
                  : people.map((p) => {
                      const on = selected.includes(p.id)
                      return (
                        <Pressable
                          key={p.id}
                          onPress={() => setSelected((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                          className="flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                        >
                          <View className={cn('h-4 w-4 items-center justify-center rounded border', on ? 'border-primary bg-primary' : 'border-border')}>
                            {on && <Check size={11} className="text-primary-foreground" />}
                          </View>
                          <User size={14} className="text-muted-foreground" />
                          <View className="min-w-0 flex-1">
                            <Text className="text-sm text-foreground" numberOfLines={1}>{p.name}</Text>
                            <Text className="text-xs text-muted-foreground" numberOfLines={1}>{p.email}</Text>
                          </View>
                        </Pressable>
                      )
                    })}
                {mode === 'agent' && !agents.length && <Text className="px-2 py-4 text-sm text-muted-foreground">No agents match.</Text>}
                {mode === 'dm' && !people.length && <Text className="px-2 py-4 text-sm text-muted-foreground">No teammates match.</Text>}
              </ScrollView>
              {mode === 'dm' && (
                <Pressable
                  disabled={!selected.length || busy}
                  onPress={() => submit(() => api.openDm(workspaceId, selected))}
                  className={cn('mt-3 items-center rounded-md py-2', selected.length ? 'bg-primary' : 'bg-muted')}
                >
                  {busy ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text className={cn('text-sm font-medium', selected.length ? 'text-primary-foreground' : 'text-muted-foreground')}>
                      {selected.length > 1 ? `Start group message (${selected.length})` : 'Start message'}
                    </Text>
                  )}
                </Pressable>
              )}
            </View>
          )}
          {error && <Text className="mt-2 text-xs text-destructive">{error}</Text>}
        </Pressable>
      </Pressable>
    </Modal>
  )
}
