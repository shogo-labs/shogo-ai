// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Search messages across the channels and DMs you can read.
 *
 * Keyword search supports `in:`, `from:`, `has:` (file, image, link, pin),
 * and `before:` / `after:` / `on:` dates. "By meaning" uses the workspace's
 * embeddings, and "Ask" has the workspace agent answer from matching
 * messages with numbered citations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Bot, Hash, Lock, MessageSquare, Search as SearchIcon, Sparkles, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useMentionables } from '../../../hooks/useTeamChat'
import { MarkdownText } from '../../../components/chat/MarkdownText'
import { teamChatApi, type AskResult, type SearchResponse } from '../../../lib/team-chat-api'
import { mentionNames, renderMentions, searchSnippet } from '../../../lib/team-chat-state'

const api = teamChatApi()
const DEBOUNCE_MS = 250

type Result = SearchResponse['results'][number]
type Mode = 'keyword' | 'semantic' | 'ask'

const MODES: { id: Mode; label: string }[] = [
  { id: 'keyword', label: 'Messages' },
  { id: 'semantic', label: 'By meaning' },
  { id: 'ask', label: 'Ask' },
]

const FILTER_CHIPS = ['has:file', 'has:link', 'has:pin', 'from:me', 'on:today', 'after:yesterday']

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
  const params = useLocalSearchParams<{ q?: string; mode?: string }>()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const mentionables = useMentionables(workspaceId)
  const names = useMemo(() => mentionNames(mentionables), [mentionables])

  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '')
  const [mode, setMode] = useState<Mode>(params.mode === 'ask' || params.mode === 'semantic' ? params.mode : 'keyword')
  const [sort, setSort] = useState<'relevance' | 'recent'>('relevance')
  const [data, setData] = useState<SearchResponse | null>(null)
  const [answer, setAnswer] = useState<AskResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    if (typeof params.q === 'string') setQuery(params.q)
    if (params.mode === 'ask' || params.mode === 'semantic' || params.mode === 'keyword') setMode(params.mode)
  }, [params.q, params.mode])

  useEffect(() => {
    if (params.mode === 'ask' && typeof params.q === 'string' && params.q.trim()) void ask(params.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q, params.mode, workspaceId])

  const run = useCallback(async (q: string, offset: number) => {
    if (!workspaceId || mode === 'ask') return
    const id = ++requestId.current
    if (!q.trim()) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await api.search(workspaceId, q, { offset, sort, mode })
      if (id !== requestId.current) return
      setData((prev) => (offset && prev ? { ...next, results: [...prev.results, ...next.results] } : next))
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [workspaceId, sort, mode])

  const ask = useCallback(async (q: string) => {
    if (!workspaceId || !q.trim()) return
    const id = ++requestId.current
    setLoading(true)
    setAnswer(null)
    try {
      const next = await api.ask(workspaceId, q)
      if (id !== requestId.current) return
      setAnswer(next)
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'Could not answer that')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (mode === 'ask') return
    const t = setTimeout(() => void run(query, 0), mode === 'semantic' ? DEBOUNCE_MS * 2 : DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, run, mode])

  const addFilter = (chip: string) => setQuery((q) => (q.includes(chip) ? q : `${q.trim()} ${chip}`.trim() + ' '))

  const open = (r: Pick<Result, 'message' | 'conversation'>) => {
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
            placeholder={
              mode === 'ask' ? 'Ask a question, e.g. when is the launch?'
                : mode === 'semantic' ? 'Describe what you are looking for'
                  : 'Search, e.g. launch in:#general from:@ada has:file'
            }
            placeholderTextColor="#8a8a8a"
            accessibilityLabel={mode === 'ask' ? 'Ask the workspace' : 'Search messages'}
            className="flex-1 px-2 py-2 text-sm text-foreground"
            returnKeyType={mode === 'ask' ? 'send' : 'search'}
            onSubmitEditing={() => void (mode === 'ask' ? ask(query) : run(query, 0))}
          />
          {query ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={8}>
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          ) : null}
        </View>
        <View className="mt-3 flex-row items-center gap-1 self-start rounded-md bg-muted p-0.5">
          {MODES.map((m) => (
            <Pressable
              key={m.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m.id }}
              onPress={() => {
                requestId.current++
                setLoading(false)
                setError(null)
                setData(null)
                setMode(m.id)
              }}
              className={cn('flex-row items-center gap-1 rounded px-3 py-1', mode === m.id && 'bg-background')}
            >
              {m.id === 'ask' ? <Sparkles size={11} className={mode === m.id ? 'text-primary' : 'text-muted-foreground'} /> : null}
              <Text className={cn('text-xs', mode === m.id ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
        {mode === 'keyword' ? (
          <View className="mt-3 flex-row flex-wrap items-center gap-2">
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
            <View className="mx-1 h-4 w-px bg-border" />
            {FILTER_CHIPS.map((chip) => (
              <Pressable key={chip} onPress={() => addFilter(chip)} className="rounded-full border border-dashed border-border px-2 py-0.5 active:bg-muted">
                <Text className="text-[11px] text-muted-foreground">{chip}</Text>
              </Pressable>
            ))}
            {loading ? <ActivityIndicator size="small" /> : null}
          </View>
        ) : (
          <View className="mt-3 flex-row items-center gap-2">
            {mode === 'ask' ? (
              <Pressable
                accessibilityRole="button"
                disabled={!query.trim() || loading}
                onPress={() => void ask(query)}
                className={cn('rounded-md bg-primary px-3 py-1.5', (!query.trim() || loading) && 'opacity-50')}
              >
                <Text className="text-xs font-semibold text-primary-foreground">Ask</Text>
              </Pressable>
            ) : null}
            {loading ? <ActivityIndicator size="small" /> : null}
            {mode === 'semantic' && data?.semantic === false ? (
              <Text className="text-xs text-muted-foreground">Search by meaning isn't set up on this server yet.</Text>
            ) : null}
          </View>
        )}
        {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}
      </View>

      {mode === 'ask' ? (
        <AskPanel answer={answer} loading={loading} names={names} onOpen={open} />
      ) : (
        <FlatList
          data={data?.results ?? []}
          keyExtractor={(r) => r.message.id}
          contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16, maxWidth: 820, width: '100%', alignSelf: 'center' }}
          ListEmptyComponent={
            !loading && query.trim() && data ? (
              <Text className="mt-8 text-center text-sm text-muted-foreground">No messages match “{query.trim()}”.</Text>
            ) : !query.trim() && mode === 'keyword' ? (
              <Text className="mt-8 text-center text-sm text-muted-foreground">
                Filters: in:#channel · in:@person · from:@person · from:me · from:agent · has:file · has:image · has:link · has:pin ·
                before:2026-01-31 · after:yesterday · on:today · "exact phrase" · -exclude
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
      )}
    </View>
  )
}

function AskPanel({
  answer,
  loading,
  names,
  onOpen,
}: {
  answer: AskResult | null
  loading: boolean
  names: ReturnType<typeof mentionNames>
  onOpen: (r: Pick<Result, 'message' | 'conversation'>) => void
}) {
  if (loading && !answer) {
    return (
      <View className="w-full self-center px-6 py-8" style={{ maxWidth: 820 }}>
        <Text className="text-sm text-muted-foreground">Reading your conversations…</Text>
      </View>
    )
  }
  if (!answer) {
    return (
      <View className="w-full self-center px-6 py-8" style={{ maxWidth: 820 }}>
        <Text className="text-sm text-muted-foreground">
          Ask about anything discussed in channels and DMs you can read. The answer cites the messages it used.
        </Text>
      </View>
    )
  }
  const shown = answer.citations.some((c) => c.cited) ? answer.citations.filter((c) => c.cited) : answer.citations
  return (
    <FlatList
      data={shown}
      keyExtractor={(c) => c.message.id}
      contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16, maxWidth: 820, width: '100%', alignSelf: 'center' }}
      ListHeaderComponent={
        <View className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3">
          <View className="mb-1 flex-row items-center gap-1.5">
            <Sparkles size={12} className="text-primary" />
            <Text className="text-xs font-semibold text-primary">Answer</Text>
          </View>
          <MarkdownText>{answer.answer}</MarkdownText>
          {shown.length ? <Text className="mt-3 text-xs font-semibold text-muted-foreground">Sources</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open source ${item.n}`}
          onPress={() => onOpen(item)}
          className="mb-2 flex-row gap-3 rounded-md border border-border px-4 py-3 active:bg-muted/60 web:hover:bg-muted/40"
        >
          <Text className="text-xs font-semibold text-primary">[{item.n}]</Text>
          <View className="flex-1">
            <Text className="text-xs text-muted-foreground">
              {authorLabel(item.message)} · {conversationLabel(item.conversation)} · {when(item.message.createdAt)}
            </Text>
            <Text className="mt-0.5 text-sm text-foreground" numberOfLines={3}>{renderMentions(item.message.text, names)}</Text>
          </View>
        </Pressable>
      )}
    />
  )
}
