// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One card: title, column, priority, assignee and fields up top, then
 * Thread (the card's channel thread, live), History (thread, card events and
 * other conversations that mention it), and Agent runs.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Archive, Bell, BellOff, Bot, ExternalLink, MessageSquare, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ConversationDetail, type Mentionables } from '../../lib/team-chat-api'
import {
  PRIORITIES,
  workBoardsApi,
  type HistoryEntry,
  type HistoryFilter,
  type ItemPatch,
  type Priority,
  type WorkItemDetail,
} from '../../lib/work-boards-api'
import { agentName, assigneeName, assigneeOptionId, assigneeOptions } from '../../lib/board-layout'
import { describeEvent, when } from '../../lib/work-history'
import { useWorkItem } from '../../hooks/useWorkBoards'
import { TimelinePane } from '../team-chat/TimelinePane'
import { OptionSheet } from './OptionSheet'
import { PRIORITY_DOT } from './priority'

const api = workBoardsApi()
const chat = teamChatApi()

type Tab = 'thread' | 'history' | 'runs'
type Sheet = 'column' | 'priority' | 'assignee' | null

export interface CardPaneProps {
  itemId: string
  workspaceId: string
  me: string | null
  mentionables: Mentionables | null
  /** The channel already on screen; the pane fetches the card's own channel otherwise. */
  conversation?: ConversationDetail | null
  visible: boolean
  onClose: () => void
}

export function CardPane({ itemId, workspaceId, me, mentionables, conversation, visible, onClose }: CardPaneProps) {
  const { detail, error, reload, setDetail } = useWorkItem(itemId, workspaceId)
  const [tab, setTab] = useState<Tab>('thread')
  const [sheet, setSheet] = useState<Sheet>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const patch = useCallback(async (change: ItemPatch) => {
    if (!detail) return
    setDetail({ ...detail, item: { ...detail.item, ...change } })
    try {
      await api.updateItem(detail.item.id, change)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not save')
      void reload()
    }
  }, [detail, reload, setDetail])

  const moveTo = useCallback(async (columnId: string) => {
    if (!detail) return
    try {
      const r = await api.move(detail.item.id, { column: columnId })
      setNotice(r.warnings.length ? r.warnings.join(' · ') : null)
      void reload()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not move the card')
    }
  }, [detail, reload])

  if (!detail) {
    return (
      <View className="flex-1 bg-background">
        <PaneHeader title="Card" onClose={onClose} />
        <View className="flex-1 items-center justify-center p-6">
          {error ? <Text className="text-center text-sm text-muted-foreground">{error}</Text> : <ActivityIndicator />}
        </View>
      </View>
    )
  }

  const { item, board } = detail
  const columns = board.columns ?? []
  const fieldEntries = Object.entries(item.fields ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
  return (
    <View className="flex-1 bg-background" testID="card-pane">
      <PaneHeader
        title={`${item.key} · ${board.name}`}
        onClose={onClose}
        actions={(
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={detail.following ? 'Stop following' : 'Follow'}
              onPress={async () => {
                const next = !detail.following
                setDetail({ ...detail, following: next })
                await api.follow(item.id, next).catch(() => reload())
              }}
              className="rounded-md p-1.5 hover:bg-muted active:bg-muted"
            >
              {detail.following ? <Bell size={15} className="text-primary" /> : <BellOff size={15} className="text-muted-foreground" />}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Archive card"
              onPress={async () => {
                await api.archiveItem(item.id).catch((err: Error) => setNotice(err.message))
                onClose()
              }}
              className="rounded-md p-1.5 hover:bg-muted active:bg-muted"
            >
              <Archive size={15} className="text-muted-foreground" />
            </Pressable>
          </>
        )}
      />
      <ScrollView className="max-h-[45%] shrink-0 grow-0" contentContainerClassName="gap-3 px-4 py-3">
        <EditableText
          key={`title:${item.id}`}
          value={item.title}
          className="text-base font-semibold text-foreground"
          label="Card title"
          onSave={(title) => title && patch({ title })}
        />
        <View className="flex-row flex-wrap gap-1.5">
          <Chip label={detail.column.name} hint="Column" onPress={() => setSheet('column')} testID="card-column" />
          <Chip
            label={item.priority === 'none' ? 'No priority' : item.priority}
            hint="Priority"
            dot={PRIORITY_DOT[item.priority]}
            onPress={() => setSheet('priority')}
          />
          <Chip
            label={assigneeName(item, mentionables) ?? 'Unassigned'}
            hint="Assignee"
            icon={item.assigneeAgentRef ? <Bot size={11} className="text-muted-foreground" /> : undefined}
            onPress={() => setSheet('assignee')}
            testID="card-assignee"
          />
          {item.dueAt ? <Chip label={`Due ${new Date(item.dueAt).toLocaleDateString()}`} hint="Due" /> : null}
        </View>
        <EditableText
          key={`desc:${item.id}`}
          value={item.description ?? ''}
          multiline
          placeholder="Add a description"
          className="text-sm text-foreground"
          label="Description"
          onSave={(description) => patch({ description: description || null })}
        />
        {item.historySummary ? (
          <View className="rounded-md bg-muted/60 p-2.5">
            <Text className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Summary</Text>
            <Text className="text-sm text-foreground">{item.historySummary}</Text>
          </View>
        ) : null}
        {fieldEntries.length ? (
          <View className="gap-1">
            {fieldEntries.map(([key, value]) => {
              const label = board.fieldsSchema?.find((f) => f.key === key)?.label ?? key
              return (
                <View key={key} className="flex-row gap-2">
                  <Text className="w-28 text-xs text-muted-foreground" numberOfLines={1}>{label}</Text>
                  <Text className="flex-1 text-xs text-foreground" numberOfLines={2}>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</Text>
                </View>
              )
            })}
          </View>
        ) : null}
        {notice ? <Text className="text-xs text-amber-700 dark:text-amber-400">{notice}</Text> : null}
      </ScrollView>
      <View className="flex-row gap-1 border-b border-t border-border px-3" accessibilityRole="tablist">
        <TabButton label="Thread" active={tab === 'thread'} onPress={() => setTab('thread')} />
        <TabButton label="History" active={tab === 'history'} onPress={() => setTab('history')} />
        <TabButton label={`Agent runs${detail.agentRuns.length ? ` (${detail.agentRuns.length})` : ''}`} active={tab === 'runs'} onPress={() => setTab('runs')} />
      </View>
      <View className="min-h-0 flex-1">
        {tab === 'thread' ? (
          <CardThread detail={detail} workspaceId={workspaceId} me={me} mentionables={mentionables} conversation={conversation ?? null} visible={visible} onCommented={reload} />
        ) : tab === 'history' ? (
          <CardHistory itemId={item.id} mentionables={mentionables} />
        ) : (
          <AgentRuns detail={detail} mentionables={mentionables} />
        )}
      </View>
      {sheet === 'column' ? (
        <OptionSheet
          title="Move to"
          value={item.columnId}
          options={columns.map((c) => ({ id: c.id, label: c.name }))}
          onSelect={(id) => void moveTo(id)}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'priority' ? (
        <OptionSheet
          title="Priority"
          value={item.priority}
          options={PRIORITIES.map((p) => ({ id: p, label: p === 'none' ? 'No priority' : p }))}
          onSelect={(id) => void patch({ priority: id as Priority })}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'assignee' ? (
        <OptionSheet
          title="Assign to"
          searchable
          value={assigneeOptionId(item)}
          options={assigneeOptions(mentionables)}
          onSelect={(id) => {
            const option = assigneeOptions(mentionables).find((o) => o.id === id)
            if (option) void patch(option.patch)
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </View>
  )
}

function PaneHeader({ title, onClose, actions }: { title: string; onClose: () => void; actions?: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-1 border-b border-border px-4 py-2.5">
      <Text className="min-w-0 flex-1 text-sm font-medium text-muted-foreground" numberOfLines={1}>{title}</Text>
      {actions}
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close card" className="rounded-md p-1.5 hover:bg-muted active:bg-muted">
        <X size={16} className="text-muted-foreground" />
      </Pressable>
    </View>
  )
}

function Chip({ label, hint, dot, icon, onPress, testID }: { label: string; hint: string; dot?: string; icon?: React.ReactNode; onPress?: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`${hint}: ${label}`}
      testID={testID}
      className="flex-row items-center gap-1.5 rounded-full border border-border px-2.5 py-1 hover:bg-muted active:bg-muted"
    >
      {dot && dot !== 'bg-transparent' ? <View className={cn('h-2 w-2 rounded-full', dot)} /> : null}
      {icon}
      <Text className="text-xs capitalize text-foreground" numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      aria-selected={active}
      className={cn('border-b-2 px-2 py-2', active ? 'border-primary' : 'border-transparent hover:bg-muted')}
    >
      <Text className={cn('text-xs font-medium', active ? 'text-foreground' : 'text-muted-foreground')}>{label}</Text>
    </Pressable>
  )
}

/** Text that saves when it loses focus (or on Enter for single-line fields). */
function EditableText({ value, onSave, className, label, placeholder, multiline }: {
  value: string
  onSave: (value: string) => void
  className: string
  label: string
  placeholder?: string
  multiline?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.trim()
    if (next !== value.trim()) onSave(next)
  }
  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={multiline ? undefined : commit}
      multiline={multiline}
      placeholder={placeholder}
      placeholderTextColor="#8a8a8a"
      accessibilityLabel={label}
      className={cn('rounded-md px-1 py-1 hover:bg-muted/50 focus:bg-muted/50', className)}
      style={Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : undefined}
    />
  )
}

function CardThread({ detail, workspaceId, me, mentionables, conversation, visible, onCommented }: {
  detail: WorkItemDetail
  workspaceId: string
  me: string | null
  mentionables: Mentionables | null
  conversation: ConversationDetail | null
  visible: boolean
  onCommented: () => void
}) {
  const { item } = detail
  const conversationId = item.conversationId
  const [channel, setChannel] = useState<ConversationDetail | null>(conversation?.id === conversationId ? conversation : null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!conversationId) return
    if (conversation?.id === conversationId) return setChannel(conversation)
    let live = true
    chat.get(conversationId).then((c) => live && setChannel(c)).catch((err: Error) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [conversationId, conversation])

  if (conversationId && item.threadRootMessageId) {
    if (!channel) {
      return (
        <View className="flex-1 items-center justify-center p-6">
          {error ? <Text className="text-center text-sm text-muted-foreground">{error}</Text> : <ActivityIndicator />}
        </View>
      )
    }
    return (
      <TimelinePane
        key={`${channel.id}:${item.threadRootMessageId}`}
        workspaceId={workspaceId}
        conversation={channel}
        threadRootId={item.threadRootMessageId}
        me={me}
        mentionables={mentionables}
        visible={visible}
      />
    )
  }
  return <CommentBox itemId={item.id} onCommented={onCommented} />
}

function CommentBox({ itemId, onCommented }: { itemId: string; onCommented: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await api.comment(itemId, body)
      setText('')
      onCommented()
    } finally {
      setBusy(false)
    }
  }
  return (
    <View className="flex-1 gap-2 p-4">
      <View className="flex-row items-center gap-2">
        <MessageSquare size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">No thread yet. A comment starts one.</Text>
      </View>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Write a comment"
        placeholderTextColor="#8a8a8a"
        accessibilityLabel="Comment"
        className="min-h-20 rounded-md border border-border px-3 py-2 text-sm text-foreground"
      />
      <Pressable accessibilityRole="button" onPress={() => void send()} disabled={busy || !text.trim()} className={cn('self-end rounded-md bg-primary px-3 py-1.5', (busy || !text.trim()) && 'opacity-50')}>
        <Text className="text-sm text-primary-foreground">Comment</Text>
      </Pressable>
    </View>
  )
}

const FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'comments', label: 'Comments' },
  { id: 'status', label: 'Status' },
  { id: 'agent', label: 'Agents' },
  { id: 'links', label: 'Links' },
]

function CardHistory({ itemId, mentionables }: { itemId: string; mentionables: Mentionables | null }) {
  const router = useRouter()
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (before?: string) => {
    setLoading(true)
    try {
      const page = await api.history(itemId, { filter, before, limit: 50 })
      setEntries((current) => (before ? [...current, ...page.entries] : page.entries))
      setNext(page.nextBefore)
    } finally {
      setLoading(false)
    }
  }, [itemId, filter])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <View className="flex-1">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-11 shrink-0 grow-0" contentContainerClassName="items-center gap-1.5 px-3 py-2">
        {FILTERS.map((f) => (
          <Pressable
            key={f.id}
            accessibilityRole="button"
            aria-selected={filter === f.id}
            onPress={() => setFilter(f.id)}
            className={cn('rounded-full border px-2.5 py-0.5', filter === f.id ? 'border-primary bg-primary/10' : 'border-border')}
          >
            <Text className={cn('text-xs', filter === f.id ? 'font-medium text-primary' : 'text-muted-foreground')}>{f.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView className="flex-1" contentContainerClassName="gap-2.5 px-4 pb-4" testID="card-history">
        {entries.map((entry, i) => {
          const key = `${entry.type}:${i}:${entry.at}`
          if (entry.type === 'message') {
            const m = entry.message
            return (
              <View key={key} className="gap-0.5">
                <Text className="text-[11px] text-muted-foreground">
                  <Text className="font-medium text-foreground">{m.author}</Text> · {when(entry.at)}
                </Text>
                <Text className="text-sm text-foreground" numberOfLines={6}>{m.text}</Text>
              </View>
            )
          }
          if (entry.type === 'event') {
            const line = describeEvent(entry.event, mentionables)
            if (!line) return null
            return (
              <View key={key} className="flex-row gap-2">
                <Text className="w-16 text-[11px] text-muted-foreground">{when(entry.at)}</Text>
                <Text className="flex-1 text-xs text-muted-foreground">{line}</Text>
              </View>
            )
          }
          const link = entry.link
          const open = link.conversationId && link.refId && !link.private
            ? () => router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: link.conversationId!, msg: link.refId! } } as any)
            : undefined
          return (
            <Pressable key={key} onPress={open} disabled={!open} className="flex-row items-start gap-2 rounded-md border border-border p-2 hover:bg-muted">
              <ExternalLink size={12} className="mt-0.5 text-muted-foreground" />
              <View className="flex-1">
                <Text className="text-[11px] text-muted-foreground">
                  {link.private ? 'Mentioned in a private conversation' : `Mentioned (${link.reason.replace(/_/g, ' ')})`} · {when(entry.at)}
                </Text>
                {link.snippet && !link.private ? <Text className="text-xs text-foreground" numberOfLines={3}>{link.snippet}</Text> : null}
              </View>
            </Pressable>
          )
        })}
        {loading ? <ActivityIndicator /> : null}
        {!loading && !entries.length ? <Text className="py-4 text-center text-sm text-muted-foreground">Nothing here yet.</Text> : null}
        {!loading && next ? (
          <Pressable accessibilityRole="button" onPress={() => void load(next)} className="self-center rounded-md bg-muted px-3 py-1.5">
            <Text className="text-xs text-foreground">Load older</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  )
}

function AgentRuns({ detail, mentionables }: { detail: WorkItemDetail; mentionables: Mentionables | null }) {
  const router = useRouter()
  if (!detail.agentRuns.length) {
    return <Text className="p-6 text-center text-sm text-muted-foreground">No agent has worked on this card yet.</Text>
  }
  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-2 p-4" testID="card-agent-runs">
      {detail.agentRuns.map((run) => (
        <Pressable
          key={run.sessionId}
          onPress={() =>
            router.push(
              (run.projectId
                ? { pathname: '/(app)/projects/[id]', params: { id: run.projectId, chatSessionId: run.sessionId } }
                : { pathname: '/(app)/agent', params: { chatSessionId: run.sessionId } }) as any,
            )
          }
          className="flex-row items-center gap-2.5 rounded-md border border-border p-2.5 hover:bg-muted active:bg-muted"
        >
          <Bot size={14} className="text-muted-foreground" />
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-foreground" numberOfLines={1}>{run.name}</Text>
            <Text className="text-[11px] text-muted-foreground">
              {run.agentRef ? `${agentName(run.agentRef, mentionables)} · ` : ''}
              {when(run.startedAt)}
            </Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  )
}
