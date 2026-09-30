// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Search messages across the channels and DMs you can read.
 * Supports `in:#channel`, `in:@person`, `from:@person`, `from:me`, and `from:agent`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Bot, Hash, Lock, MessageSquare, Search as SearchIcon, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useMentionables } from '../../../hooks/useTeamChat'
import { teamChatApi, type SearchResponse } from '../../../lib/team-chat-api'
import { mentionNames, searchSnippet } from '../../../lib/team-chat-state'

const api = teamChatApi()
const DEBOUNCE_MS = 250

type Result = SearchResponse['results'][number]

function conversationLabel(c: Result['conversation']): string {
  if (c.kind === 'dm' || c.kind === 'group_dm') return 'Direct message'
  return `#${c.slug ?? c.name ?? 'channel'}`
}

function authorLabel(m: Result['message']): string {
  if (m.authorType === 'agent') return m.authorAgent?.name ?? 'Agent'
  return m.author?.name ?? 'Someone'
}

function when(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export default function TeamChatSearch() {
  const router = useRouter()
  const params = useLocalSearchParams<{ q?: string }>()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const mentionables = useMentionables(workspaceId)
  const names = useMemo(() => mentionNames(mentionables), [mentionables])

  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '')
  const [sort, setSort] = useState<'relevance' | 'recent'>('relevance')
  const [data, setData] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const run = useCallback(async (q: string, offset: number) => {
    if (!workspaceId) return
    const id = ++requestId.current
    if (!q.trim()) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await api.search(workspaceId, q, { offset, sort })
      if (id !== requestId.current) return
      setData((prev) => (offset && prev ? { ...next, results: [...prev.results, ...next.results] } : next))
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [workspaceId, sort])

  useEffect(() => {
    const t = setTimeout(() => void run(query, 0), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, run])

  const open = (r: Result) => {
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: r.conversation.id, thread: r.message.threadRootId ?? r.message.id },
    } as any)
  }

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <View className="w-full self-center px-6 pt-6" style={{ maxWidth: 820 }}>
        <Text className="text-2xl font-semibold text-foreground">Search messages</Text>
        <View className="mt-4 flex-row items-center rounded-md border border-border px-3">
          <SearchIcon size={14} className="text-muted-foreground" />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search, e.g. launch in:#general from:@ada"
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Search messages"
            className="flex-1 px-2 py-2 text-sm text-foreground"
            returnKeyType="search"
            onSubmitEditing={() => void run(query, 0)}
          />
          {query ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={8}>
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          ) : null}
        </View>
        <View className="mt-3 flex-row items-center gap-2">
          {(['relevance', 'recent'] as const).map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityState={{ selected: sort === s }}
              onPress={() => setSort(s)}
              className={cn('rounded-full border px-3 py-1', sort === s ? 'border-primary bg-primary/10' : 'border-border')}
            >
              <Text className={cn('text-xs', sort === s ? 'text-primary' : 'text-muted-foreground')}>
                {s === 'relevance' ? 'Most relevant' : 'Most recent'}
              </Text>
            </Pressable>
          ))}
          {loading ? <ActivityIndicator size="small" /> : null}
        </View>
        {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}
      </View>

      <FlatList
        data={data?.results ?? []}
        keyExtractor={(r) => r.message.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16, maxWidth: 820, width: '100%', alignSelf: 'center' }}
        ListEmptyComponent={
          !loading && query.trim() && data ? (
            <Text className="mt-8 text-center text-sm text-muted-foreground">No messages match “{query.trim()}”.</Text>
          ) : !query.trim() ? (
            <Text className="mt-8 text-center text-sm text-muted-foreground">
              Filters: in:#channel · in:@person · from:@person · from:me · from:agent · "exact phrase" · -exclude
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const ConvIcon = item.conversation.kind === 'private' ? Lock : item.conversation.kind === 'dm' || item.conversation.kind === 'group_dm' ? MessageSquare : Hash
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open message from ${authorLabel(item.message)} in ${conversationLabel(item.conversation)}`}
              onPress={() => open(item)}
              className="mb-2 rounded-md border border-border px-4 py-3 active:bg-muted/60 web:hover:bg-muted/40"
            >
              <View className="flex-row items-center gap-1.5">
                <ConvIcon size={12} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-muted-foreground">{conversationLabel(item.conversation)}</Text>
                {item.message.threadRootId ? <Text className="text-xs text-muted-foreground">· in thread</Text> : null}
                <Text className="ml-auto text-xs text-muted-foreground">{when(item.message.createdAt)}</Text>
              </View>
              <View className="mt-1 flex-row items-center gap-1.5">
                {item.message.authorType === 'agent' ? <Bot size={13} className="text-primary" /> : null}
                <Text className="text-sm font-semibold text-foreground">{authorLabel(item.message)}</Text>
              </View>
              <Text className="mt-0.5 text-sm text-foreground">
                {searchSnippet(item.message.text, data?.terms ?? [], names).map((seg, i) => (
                  <Text key={i} className={seg.match ? 'rounded bg-yellow-300/40 font-semibold' : undefined}>
                    {seg.text}
                  </Text>
                ))}
              </Text>
            </Pressable>
          )
        }}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (data?.hasMore && !loading) void run(query, data.results.length)
        }}
      />
    </View>
  )
}
