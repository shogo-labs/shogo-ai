// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * My work: open cards across every board, as a list or grouped by status.
 * `?card=<id>` opens a card beside the list on wide screens and in its place
 * on narrow ones. On web, arrows move through the list, Shift+arrows and
 * Cmd+A select, and A / P / S set the assignee, priority or status of the
 * selection. Alt+Shift+F clears the filters.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PhoneBackButton } from '../../components/layout/PhoneBackButton'
import { KanbanSquare, List, Search, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import { useTeamChatEvents } from '../../lib/team-chat-connection'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  PRIORITIES,
  workBoardsApi,
  type Board,
  type ColumnCategory,
  type InboxQuery,
  type ItemPatch,
  type Priority,
  type WorkItem,
} from '../../lib/work-boards-api'
import { assigneeOptions } from '../../lib/board-layout'
import { EMPTY_SELECTION, handleKey, targetIds, toggleSelected, type SelectionState } from '../../lib/work-selection'
import { ActivityFilterPicker } from '../../components/team-chat/ActivityFilterPicker'
import { OptionSheet } from '../../components/boards/OptionSheet'
import { WorkItemRow } from '../../components/boards/WorkItemRow'
import { CardTile } from '../../components/boards/BoardKanban'
import { CardPane } from '../../components/boards/CardPane'
import { usePhoneChromeOverlay } from '../../components/layout/PhoneChromeOverlay'
import { Lane } from '../../components/boards/Lane'
import { DraggableCard } from '../../components/boards/drag'

const api = workBoardsApi()
const SIDE_PANE_MIN_WIDTH = 1024
const OPEN_CATEGORIES: ColumnCategory[] = ['backlog', 'active', 'waiting', 'review']

type Sort = NonNullable<InboxQuery['sort']>
type Sheet = 'assignee' | 'board' | 'sort' | 'bulk-assign' | 'bulk-priority' | 'bulk-status' | null

interface Filters {
  assignee: string
  board: string | null
  priority: Priority[]
  category: ColumnCategory[]
  sort: Sort
  q: string
}

const DEFAULT_FILTERS: Filters = { assignee: 'me', board: null, priority: [], category: [], sort: 'priority', q: '' }

const SORT_LABELS: Record<Sort, string> = { priority: 'Priority', activity: 'Last activity', due: 'Due date', created: 'Newest' }

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default observer(function MyWorkScreen() {
  const params = useLocalSearchParams<{ card?: string }>()
  const cardId = first(params.card) ?? null
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const chrome = usePhoneChromeOverlay()
  const { width } = useWindowDimensions()
  const sidePane = width >= SIDE_PANE_MIN_WIDTH
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? null
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [mode, setMode] = useState<'list' | 'board'>('list')
  const [items, setItems] = useState<WorkItem[]>([])
  const [boards, setBoards] = useState<Board[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focused, setFocused] = useState(true)
  const [dragging, setDragging] = useState<string | null>(null)

  const query = useMemo<InboxQuery>(() => ({
    assignee: filters.assignee === 'anyone' ? undefined : filters.assignee,
    board: filters.board ?? undefined,
    priority: filters.priority.length ? filters.priority : undefined,
    category: filters.category.length ? filters.category : mode === 'board' ? [...OPEN_CATEGORIES, 'done'] : undefined,
    sort: filters.sort,
    q: filters.q.trim() || undefined,
  }), [filters, mode])

  const latest = useRef(0)
  const load = useCallback(async () => {
    if (!workspaceId) return
    const ticket = ++latest.current
    try {
      const result = await api.inbox(workspaceId, query)
      if (ticket !== latest.current) return
      setItems(result.items)
      setBoards(result.boards)
      setError(null)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof Error ? err.message : 'Could not load your work')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [workspaceId, query])

  useEffect(() => {
    void load()
  }, [load])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useTeamChatEvents(workspaceId, (event) => {
    if (event.type !== 'board.changed' && event.type !== 'ready') return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(), 250)
  })

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, []),
  )

  const ids = useMemo(() => items.map((i) => i.id), [items])
  const openCard = useCallback((id: string) => router.setParams({ card: id } as any), [router])
  const closeCard = useCallback(() => router.setParams({ card: undefined } as any), [router])

  const bulk = useCallback(async (patch: ItemPatch & { column?: string }) => {
    if (!workspaceId) return
    const targets = targetIds(selection, ids)
    if (!targets.length) return
    try {
      const result = await api.bulk(workspaceId, targets, patch)
      const failed = result.results.filter((r) => !r.ok)
      setNotice(failed.length ? `${failed.length} of ${targets.length} could not be changed: ${failed[0]!.error}` : null)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not update the cards')
    }
    void load()
  }, [workspaceId, selection, ids, load])

  useEffect(() => {
    if (Platform.OS !== 'web' || !focused || sheet || typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const result = handleKey(selection, ids, e)
      if (!result.handled) return
      e.preventDefault()
      setSelection(result.state)
      if (result.action === 'assign') setSheet('bulk-assign')
      else if (result.action === 'priority') setSheet('bulk-priority')
      else if (result.action === 'status') setSheet('bulk-status')
      else if (result.action === 'clearFilters') setFilters(DEFAULT_FILTERS)
      else if (result.action === 'open') {
        const id = ids[result.state.cursor]
        if (id) openCard(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, sheet, selection, ids, openCard])

  const assigneeChoices = useMemo(() => [
    { id: 'me', label: 'Me' },
    { id: 'anyone', label: 'Anyone' },
    { id: 'none', label: 'Unassigned' },
    ...assigneeOptions(mentionables).filter((o) => o.id !== 'none').map((o) => ({
      id: o.patch.assigneeUserId ? `user:${o.patch.assigneeUserId}` : o.patch.assigneeAgentRef!,
      label: o.label,
    })),
  ], [mentionables])
  const assigneeLabel = assigneeChoices.find((c) => c.id === filters.assignee)?.label ?? 'Someone'
  const boardLabel = filters.board ? boards.find((b) => b.id === filters.board)?.name ?? 'Board' : 'All boards'
  const filtered = filters.assignee !== 'me' || filters.board || filters.priority.length || filters.category.length || filters.q
  const showList = sidePane || !cardId
  const targets = targetIds(selection, ids)

  const grouped = useMemo(() => {
    const out = new Map<ColumnCategory, WorkItem[]>(CATEGORIES.map((c) => [c, []]))
    for (const item of items) out.get(item.column?.category ?? 'backlog')?.push(item)
    return out
  }, [items])
  const lanes = (filters.category.length ? filters.category : [...OPEN_CATEGORIES, 'done' as const]).filter((c) => CATEGORIES.includes(c))

  const list = (
    <View className="min-w-0 flex-1">
      <View className="flex-row items-center gap-2 px-4 pb-2" style={{ paddingTop: insets.top + 8 }}>
        <PhoneBackButton />
        <Text className="flex-1 text-[28px] font-bold leading-9 text-foreground" accessibilityRole="header">My work</Text>
        <View className="flex-row rounded-md border border-border" accessibilityRole="tablist">
          <ModeButton label="List" active={mode === 'list'} onPress={() => setMode('list')} icon={<List size={14} className={mode === 'list' ? 'text-foreground' : 'text-muted-foreground'} />} />
          <ModeButton label="Board" active={mode === 'board'} onPress={() => setMode('board')} icon={<KanbanSquare size={14} className={mode === 'board' ? 'text-foreground' : 'text-muted-foreground'} />} />
        </View>
      </View>
      <View className="px-4 pb-2">
        <View className="flex-row items-center gap-2 rounded-md border border-border px-2">
          <Search size={14} className="text-muted-foreground" />
          <TextInput
            value={filters.q}
            onChangeText={(q) => setFilters((f) => ({ ...f, q }))}
            placeholder="Search cards"
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Search cards"
            className="flex-1 py-2 text-sm text-foreground"
          />
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-11 shrink-0 grow-0" contentContainerClassName="items-center gap-2 px-4 pb-2" testID="work-filters">
        <FilterChip label={`Assignee: ${assigneeLabel}`} active={filters.assignee !== 'me'} onPress={() => setSheet('assignee')} />
        <FilterChip label={boardLabel} active={!!filters.board} onPress={() => setSheet('board')} />
        <ActivityFilterPicker
          label="Priority"
          value={filters.priority}
          options={PRIORITIES.map((p) => ({ id: p, label: p === 'none' ? 'No priority' : p[0]!.toUpperCase() + p.slice(1) }))}
          onChange={(priority) => setFilters((f) => ({ ...f, priority: priority as Priority[] }))}
        />
        <ActivityFilterPicker
          label="Status"
          value={filters.category}
          options={CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] }))}
          onChange={(category) => setFilters((f) => ({ ...f, category: category as ColumnCategory[] }))}
        />
        <FilterChip label={`Sort: ${SORT_LABELS[filters.sort]}`} active={false} onPress={() => setSheet('sort')} />
        {filtered ? (
          <Pressable onPress={() => setFilters(DEFAULT_FILTERS)} accessibilityRole="button" className="flex-row items-center gap-1 px-2 py-1">
            <X size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Clear</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      {selection.selected.length ? (
        <View className="flex-row items-center gap-2 border-y border-border bg-muted/40 px-4 py-1.5" testID="work-bulk-bar">
          <Text className="flex-1 text-xs text-foreground">{selection.selected.length} selected</Text>
          <BulkButton label="Assign" shortcut="A" onPress={() => setSheet('bulk-assign')} />
          <BulkButton label="Priority" shortcut="P" onPress={() => setSheet('bulk-priority')} />
          <BulkButton label="Status" shortcut="S" onPress={() => setSheet('bulk-status')} />
          <Pressable onPress={() => setSelection(EMPTY_SELECTION)} accessibilityLabel="Clear selection" className="p-1">
            <X size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      ) : null}
      {notice ? (
        <Pressable onPress={() => setNotice(null)} className="bg-amber-500/10 px-4 py-1.5">
          <Text className="text-xs text-amber-800 dark:text-amber-300">{notice}</Text>
        </Pressable>
      ) : null}
      {loading && !items.length ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator /></View>
      ) : error && !items.length ? (
        <View className="flex-1 items-center justify-center gap-2 p-6">
          <Text className="text-center text-sm text-muted-foreground">{error}</Text>
          <Pressable onPress={() => void load()} className="rounded-md bg-muted px-3 py-1.5"><Text className="text-sm text-foreground">Try again</Text></Pressable>
        </View>
      ) : !items.length ? (
        <View className="flex-1 items-center justify-center p-8">
          <Text className="text-center text-sm text-muted-foreground">
            {filtered ? 'No cards match these filters.' : 'Nothing is assigned to you. Cards you own on any board show up here.'}
          </Text>
        </View>
      ) : mode === 'list' ? (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: chrome.bottom }} testID="work-list">
          {items.map((item, index) => (
            <WorkItemRow
              key={item.id}
              item={item}
              mentionables={mentionables}
              showBoard
              selected={selection.selected.includes(item.id)}
              cursor={selection.cursor === index}
              open={cardId === item.id}
              onPress={() => {
                setSelection((s) => ({ ...s, cursor: index }))
                openCard(item.id)
              }}
              onToggle={() => setSelection((s) => toggleSelected(s, item.id, index))}
            />
          ))}
        </ScrollView>
      ) : (
        <ScrollView horizontal className="flex-1" contentContainerClassName="gap-3 p-3" style={{ marginBottom: chrome.bottom }} testID="work-board">
          {lanes.map((category) => {
            const laneItems = grouped.get(category) ?? []
            return (
              <Lane
                key={category}
                title={CATEGORY_LABELS[category]}
                count={laneItems.length}
                dragging={!!dragging}
                onDropCard={(id) => {
                  setDragging(null)
                  const item = items.find((i) => i.id === id)
                  if (!item || item.column?.category === category) return
                  setItems((list) => list.map((i) => (i.id === id && i.column ? { ...i, column: { ...i.column, category } } : i)))
                  api.move(id, { column: category })
                    .catch((err: Error) => setNotice(`${item.key}: ${err.message}`))
                    .finally(() => void load())
                }}
                testID={`work-lane-${category}`}
              >
                {laneItems.map((item) => (
                  <DraggableCard key={item.id} id={item.id} onDragStart={setDragging} onDragEnd={() => setDragging(null)}>
                    <CardTile
                      item={item}
                      issues={[]}
                      mentionables={mentionables}
                      selected={cardId === item.id}
                      faded={dragging === item.id}
                      onPress={() => openCard(item.id)}
                      onLongPress={() => {
                        setSelection({ cursor: index(ids, item.id), anchor: -1, selected: [item.id] })
                        setSheet('bulk-status')
                      }}
                    />
                  </DraggableCard>
                ))}
              </Lane>
            )
          })}
        </ScrollView>
      )}
    </View>
  )

  return (
    <View className="flex-1 flex-row bg-background">
      {showList ? list : null}
      {cardId && workspaceId ? (
        <View className={sidePane ? 'w-[460px] shrink-0 border-l border-border' : 'flex-1'} style={sidePane ? undefined : { paddingTop: insets.top, paddingBottom: chrome.bottom }}>
          <CardPane key={cardId} itemId={cardId} workspaceId={workspaceId} me={me} mentionables={mentionables} visible={focused} onClose={closeCard} />
        </View>
      ) : null}
      {sheet === 'assignee' ? (
        <OptionSheet title="Assignee" searchable value={filters.assignee} options={assigneeChoices} onSelect={(assignee) => setFilters((f) => ({ ...f, assignee }))} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'board' ? (
        <OptionSheet
          title="Board"
          searchable={boards.length > 6}
          value={filters.board ?? 'all'}
          options={[{ id: 'all', label: 'All boards' }, ...boards.map((b) => ({ id: b.id, label: b.name, hint: b.channelName ? `#${b.channelName}` : undefined }))]}
          onSelect={(id) => setFilters((f) => ({ ...f, board: id === 'all' ? null : id }))}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'sort' ? (
        <OptionSheet
          title="Sort by"
          value={filters.sort}
          options={(Object.keys(SORT_LABELS) as Sort[]).map((s) => ({ id: s, label: SORT_LABELS[s] }))}
          onSelect={(sort) => setFilters((f) => ({ ...f, sort: sort as Sort }))}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'bulk-assign' ? (
        <OptionSheet
          title={`Assign ${targets.length === 1 ? 'card' : `${targets.length} cards`}`}
          searchable
          options={assigneeOptions(mentionables)}
          onSelect={(id) => {
            const option = assigneeOptions(mentionables).find((o) => o.id === id)
            if (option) void bulk(option.patch)
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'bulk-priority' ? (
        <OptionSheet
          title="Set priority"
          options={PRIORITIES.map((p) => ({ id: p, label: p === 'none' ? 'No priority' : p[0]!.toUpperCase() + p.slice(1) }))}
          onSelect={(priority) => void bulk({ priority: priority as Priority })}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'bulk-status' ? (
        <OptionSheet
          title="Move to"
          options={CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c], hint: 'The first column of this kind on each card\u2019s board' }))}
          onSelect={(category) => void bulk({ column: category })}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </View>
  )
})

function index(ids: string[], id: string): number {
  return ids.indexOf(id)
}

function ModeButton({ label, active, onPress, icon }: { label: string; active: boolean; onPress: () => void; icon: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      aria-selected={active}
      accessibilityLabel={`${label} view`}
      className={cn('flex-row items-center gap-1 px-2.5 py-1.5', active ? 'bg-muted' : 'hover:bg-muted/50')}
    >
      {icon}
      <Text className={cn('text-xs', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</Text>
    </Pressable>
  )
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={cn('rounded-full border px-3 py-1', active ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50')}
    >
      <Text className={cn('text-xs', active ? 'font-medium text-primary' : 'text-muted-foreground')} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

function BulkButton({ label, shortcut, onPress }: { label: string; shortcut: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} className="flex-row items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
      <Text className="text-xs text-foreground">{label}</Text>
      {Platform.OS === 'web' ? <Text className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{shortcut}</Text> : null}
    </Pressable>
  )
}
