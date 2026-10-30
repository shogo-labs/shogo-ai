// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One board as columns of cards. Drag cards between columns on web; long
 * press a card for the move menu anywhere. Moves show right away and the
 * board reloads when the server (or another teammate or agent) changes it.
 */
import { useMemo, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { AlertTriangle, ArrowUpDown, Bot, Clock, GitPullRequest, KanbanSquare, List, Plus, Search, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { Mentionables } from '../../lib/team-chat-api'
import { workBoardsApi, type BoardColumn, type HealthIssue, type WorkItem } from '../../lib/work-boards-api'
import {
  BOARD_SORT_LABELS,
  BOARD_SORT_OPTIONS,
  ISSUE_LABEL,
  age,
  agentName,
  applyMove,
  assigneeName,
  columnBadges,
  issuesByItem,
  itemsByColumn,
  orderedItems,
  type BoardSort,
} from '../../lib/board-layout'
import { useBoardSort } from '../../lib/board-sort-preference'
import { useBoardView } from '../../hooks/useWorkBoards'
import { DraggableCard, DropZone, supportsDrag } from './drag'
import { OptionSheet } from './OptionSheet'
import { Lane } from './Lane'
import { PRIORITY_DOT } from './priority'
import { PullRequestChip } from './PullRequestChip'
import { WorkItemRow } from './WorkItemRow'
import { WorkingIndicator } from './WorkingIndicator'

const api = workBoardsApi()

const PHONE_BOARD_MAX_WIDTH = 640
const BOARD_GUTTER = 12
/** How much of the next column shows at the edge, so it reads as swipeable. */
const COLUMN_PEEK = 32

export interface BoardKanbanProps {
  boardId: string
  workspaceId: string
  mentionables: Mentionables | null
  selectedItemId?: string | null
  onOpenCard: (item: WorkItem) => void
}

export function BoardKanban({ boardId, workspaceId, mentionables, selectedItemId, onOpenCard }: BoardKanbanProps) {
  const [query, setQuery] = useState('')
  const { view, error, reload, setView } = useBoardView(boardId, workspaceId, query)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<WorkItem | null>(null)
  const [showIssues, setShowIssues] = useState(false)
  const [mode, setMode] = useState<'board' | 'list'>('board')
  const [sort, chooseSort] = useBoardSort(boardId)
  const [sortOpen, setSortOpen] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [page, setPage] = useState(0)
  const window = useWindowDimensions()
  // Phones get one column per swipe; the web board and wider panes keep the free-scrolling layout.
  const width = size?.width ?? window.width
  const compact = Platform.OS !== 'web' && width < PHONE_BOARD_MAX_WIDTH
  const columnWidth = Math.max(220, width - COLUMN_PEEK - 2 * BOARD_GUTTER)
  const columnSnap = columnWidth + BOARD_GUTTER

  const grouped = useMemo(() => (view ? itemsByColumn(view, sort) : new Map<string, WorkItem[]>()), [view, sort])
  const listed = useMemo(() => (view ? orderedItems(view, sort) : []), [view, sort])
  const byItem = useMemo(() => issuesByItem(view?.health.issues ?? []), [view])

  const move = (itemId: string, columnId: string, beforeId: string | null) => {
    if (!view) return
    const card = view.items.find((i) => i.id === itemId)
    // Only Manual shows an in-column order, so elsewhere a drop just changes the column.
    if (!card) return
    if (sort !== 'manual' && card.columnId === columnId) return
    const anchor = sort === 'manual' ? beforeId : null
    const result = applyMove(view.items, { itemId, columnId, beforeId: anchor })
    if (!result) return
    setView({ ...view, items: result.items })
    api.move(itemId, result.request)
      .then((r) => setNotice(r.warnings.length ? r.warnings.join(' · ') : null))
      .catch((err: unknown) => {
        setNotice(err instanceof Error ? err.message : 'Could not move the card')
        void reload()
      })
  }

  const addCard = async (column: BoardColumn, title: string) => {
    try {
      await api.createItem(boardId, { title, column: column.id })
      void reload()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not add the card')
    }
  }

  const toggleArming = async (column: BoardColumn) => {
    try {
      await api.updateColumn(boardId, column.id, { rules: { ...(column.rules ?? {}), allowAutoMerge: !column.rules?.allowAutoMerge } })
      void reload()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not change the column rule')
    }
  }

  if (!view) {
    return (
      <View className="flex-1 items-center justify-center gap-2 p-6">
        {error ? (
          <>
            <Text className="text-center text-sm text-muted-foreground">{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => void reload()} className="rounded-md bg-muted px-3 py-1.5">
              <Text className="text-sm text-foreground">Try again</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    )
  }

  const issues = view.health.issues
  return (
    <View className="flex-1" testID="board-kanban" onLayout={(e) => {
      const { width: w, height: h } = e.nativeEvent.layout
      setSize((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }))
    }}>
      <View className={cn('flex-row items-center gap-2 px-3', compact ? 'pb-1 pt-2.5' : 'border-b border-border/60 py-2')}>
        <View className={cn('flex-1 flex-row items-center gap-2 rounded-md px-2', compact ? 'bg-muted/60' : 'border border-border')}>
          <Search size={14} className="text-muted-foreground" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${view.board.name}`}
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Search cards"
            className={cn('flex-1 text-sm text-foreground', compact ? 'py-2' : 'py-1.5')}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sort cards"
          onPress={() => setSortOpen(true)}
          testID="board-sort"
          className={cn(
            'flex-row items-center gap-1 rounded-md',
            compact ? 'h-9 w-9 justify-center bg-muted/60 active:bg-muted' : 'border border-border px-2 py-1.5 hover:bg-muted',
          )}
        >
          <ArrowUpDown size={compact ? 15 : 13} className={compact ? 'text-foreground' : 'text-muted-foreground'} />
          {compact ? null : <Text className="text-xs text-foreground">{BOARD_SORT_LABELS[sort]}</Text>}
        </Pressable>
        <View className={cn('flex-row rounded-md', compact ? 'overflow-hidden bg-muted/60' : 'border border-border')} accessibilityRole="tablist">
          {(['board', 'list'] as const).map((m) => {
            const Icon = m === 'board' ? KanbanSquare : List
            return (
              <Pressable
                key={m}
                onPress={() => setMode(m)}
                accessibilityRole="tab"
                aria-selected={mode === m}
                accessibilityLabel={m === 'board' ? 'Board view' : 'List view'}
                className={cn(
                  compact ? 'h-9 w-9 items-center justify-center rounded-md' : 'px-2 py-1.5',
                  mode === m ? (compact ? 'bg-primary/15' : 'bg-muted') : 'hover:bg-muted/50',
                )}
              >
                <Icon size={14} className={mode === m ? (compact ? 'text-primary' : 'text-foreground') : 'text-muted-foreground'} />
              </Pressable>
            )
          })}
        </View>
        {issues.length ? (
          <Pressable
            accessibilityRole="button"
            aria-selected={showIssues}
            onPress={() => setShowIssues((v) => !v)}
            className="flex-row items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1"
            testID="board-health"
          >
            <AlertTriangle size={12} className="text-amber-600" />
            <Text className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {showIssues ? <IssueList issues={issues} items={view.items} onOpen={onOpenCard} /> : null}
      {notice ? (
        <View className="flex-row items-center gap-2 bg-amber-500/10 px-3 py-1.5">
          <Text className="flex-1 text-xs text-amber-800 dark:text-amber-300">{notice}</Text>
          <Pressable accessibilityRole="button" onPress={() => setNotice(null)} accessibilityLabel="Dismiss">
            <X size={12} className="text-muted-foreground" />
          </Pressable>
        </View>
      ) : null}
      {mode === 'list' ? (
        <ScrollView className="flex-1" testID="board-list">
          {listed.map((item) => (
            <WorkItemRow
              key={item.id}
              item={{ ...item, column: item.column ?? view.board.columns.find((c) => c.id === item.columnId) }}
              mentionables={mentionables}
              open={selectedItemId === item.id}
              onPress={() => onOpenCard(item)}
            />
          ))}
        </ScrollView>
      ) : (
        <ScrollView
          horizontal
          className="flex-1"
          contentContainerClassName={compact ? 'items-start gap-3 px-3 pb-2 pt-2' : 'gap-3 p-3'}
          showsHorizontalScrollIndicator={!compact}
          snapToInterval={compact ? columnSnap : undefined}
          snapToAlignment="start"
          decelerationRate={compact ? 'fast' : 'normal'}
          disableIntervalMomentum={compact}
          scrollEventThrottle={16}
          onScroll={compact ? (e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const next = Math.round(e.nativeEvent.contentOffset.x / columnSnap)
            setPage((cur) => (cur === next ? cur : Math.max(0, Math.min(view.board.columns.length - 1, next))))
          } : undefined}
        >
          {view.board.columns.map((column) => (
            <Column
              key={column.id}
              fixedWidth={compact ? columnWidth : undefined}
              maxHeight={compact && size ? Math.max(240, size.height - PHONE_BOARD_CHROME) : undefined}
              column={column}
              items={grouped.get(column.id) ?? []}
              sort={sort}
              issues={issues}
              byItem={byItem}
              mentionables={mentionables}
              dragging={dragging}
              selectedItemId={selectedItemId ?? null}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onDrop={(itemId, beforeId) => {
                setDragging(null)
                move(itemId, column.id, beforeId)
              }}
              onOpen={onOpenCard}
              onMenu={setMenuFor}
              onAdd={(title) => addCard(column, title)}
              onToggleArming={() => void toggleArming(column)}
            />
          ))}
        </ScrollView>
      )}
      {compact && mode === 'board' && view.board.columns.length > 1 ? (
        <View className="flex-row items-center justify-center gap-1.5 pb-2" accessibilityLabel={`Column ${page + 1} of ${view.board.columns.length}`} testID="board-pager">
          {view.board.columns.map((column, i) => (
            <View key={column.id} className={cn('h-1.5 rounded-full', i === page ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/30')} />
          ))}
        </View>
      ) : null}
      {sortOpen ? (
        <OptionSheet
          title="Sort cards"
          value={sort}
          options={BOARD_SORT_OPTIONS.map((s) => ({
            id: s,
            label: BOARD_SORT_LABELS[s],
            hint: s === 'manual' ? 'Drag order' : s === 'newest' ? 'Newest first' : 'Oldest first',
          }))}
          onSelect={(id) => chooseSort(id as BoardSort)}
          onClose={() => setSortOpen(false)}
        />
      ) : null}
      {menuFor ? (
        <OptionSheet
          title={`Move ${menuFor.key}`}
          value={menuFor.columnId}
          options={view.board.columns.map((c) => ({ id: c.id, label: c.name, hint: c.wipLimit ? `WIP ${c.wipLimit}` : undefined }))}
          onSelect={(columnId) => move(menuFor.id, columnId, null)}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
    </View>
  )
}

/** Room the phone board keeps free of columns: toolbar, gutters and the page dots. */
const PHONE_BOARD_CHROME = 78

interface ColumnProps {
  fixedWidth?: number
  maxHeight?: number
  column: BoardColumn
  items: WorkItem[]
  sort: BoardSort
  issues: HealthIssue[]
  byItem: Map<string, HealthIssue[]>
  mentionables: Mentionables | null
  dragging: string | null
  selectedItemId: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDrop: (itemId: string, beforeId: string | null) => void
  onOpen: (item: WorkItem) => void
  onMenu: (item: WorkItem) => void
  onAdd: (title: string) => Promise<void>
  onToggleArming: () => void
}

function Column(props: ColumnProps) {
  const { column, items } = props
  // Manual is the only sort where a drop has a visible "above this card" meaning.
  const manual = props.sort === 'manual'
  const [hoverCard, setHoverCard] = useState<string | null>(null)
  const badges = columnBadges(column, items.length, props.issues)
  const agent = column.agentRef ? agentName(column.agentRef, props.mentionables) : null
  const arming = column.rules?.allowAutoMerge === true
  return (
    <Lane
      title={column.name}
      testID={`board-column-${column.name}`}
      fixedWidth={props.fixedWidth}
      maxHeight={props.maxHeight}
      count={column.wipLimit ? `${badges.count}/${column.wipLimit}` : badges.count}
      countLabel={column.wipLimit ? `${badges.count} of ${column.wipLimit} cards` : `${badges.count} cards`}
      countClassName={badges.wip === 'over' ? 'font-semibold text-destructive' : badges.wip === 'at' ? 'text-amber-600' : undefined}
      badges={badges.breaches ? (
        <View className="flex-row items-center gap-0.5 rounded bg-destructive/10 px-1" accessibilityLabel={`${badges.breaches} past SLA`}>
          <Clock size={10} className="text-destructive" />
          <Text className="text-[10px] font-medium text-destructive">{badges.breaches}</Text>
        </View>
      ) : null}
      right={(
        <View className="flex-row items-center gap-1.5">
          {agent ? (
            <View className="flex-row items-center gap-1" accessibilityLabel={`${agent} works this column`}>
              <Bot size={12} className="text-muted-foreground" />
              <Text className="max-w-24 text-[11px] text-muted-foreground" numberOfLines={1}>{agent}</Text>
            </View>
          ) : null}
          {/* Cards here may have their PR armed and merged by an agent. */}
          <Pressable
            accessibilityRole="switch"
            aria-checked={arming}
            accessibilityLabel={`${column.name}: ${arming ? 'auto-merge allowed' : 'auto-merge not allowed'}`}
            onPress={props.onToggleArming}
            testID={`board-column-arm-${column.name}`}
            className={cn('flex-row items-center gap-1 rounded px-1 py-0.5', arming ? 'bg-emerald-500/10' : 'hover:bg-muted')}
          >
            <GitPullRequest size={11} className={arming ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'} />
            {arming ? <Text className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">arm</Text> : null}
          </Pressable>
        </View>
      )}
      dragging={!!props.dragging}
      onDropCard={(id) => props.onDrop(id, null)}
      footer={<AddCard onAdd={props.onAdd} />}
    >
      {items.map((item) => (
        <DropZone
          key={item.id}
          onDrop={(id) => {
            setHoverCard(null)
            props.onDrop(id, manual ? item.id : null)
          }}
          onHover={(on) => setHoverCard(on ? item.id : null)}
        >
          {manual && hoverCard === item.id && props.dragging && props.dragging !== item.id ? <View className="h-1 rounded bg-primary" /> : null}
          <DraggableCard id={item.id} onDragStart={props.onDragStart} onDragEnd={props.onDragEnd}>
            <CardTile
              item={item}
              issues={props.byItem.get(item.id) ?? []}
              mentionables={props.mentionables}
              selected={props.selectedItemId === item.id}
              faded={props.dragging === item.id}
              compact={!!props.fixedWidth}
              onPress={() => props.onOpen(item)}
              onLongPress={() => props.onMenu(item)}
            />
          </DraggableCard>
        </DropZone>
      ))}
    </Lane>
  )
}

export function CardTile({ item, issues, mentionables, selected, faded, compact = false, onPress, onLongPress }: {
  item: WorkItem
  issues: HealthIssue[]
  mentionables: Mentionables | null
  selected: boolean
  faded: boolean
  /** Phone board: age rides the key line and an empty chip row is dropped. */
  compact?: boolean
  onPress: () => void
  onLongPress: () => void
}) {
  const who = assigneeName(item, mentionables)
  const working = item.working
  const occurrences = typeof item.fields?.occurrences === 'number' ? (item.fields.occurrences as number) : null
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={supportsDrag ? 600 : 350}
      accessibilityRole="button"
      accessibilityLabel={`${item.key} ${item.title}`}
      accessibilityHint="Opens the card. Long press to move it."
      testID={`board-card-${item.key}`}
      className={cn(
        'gap-1.5 rounded-md border bg-card p-2.5 hover:border-primary/40',
        compact && 'active:bg-muted/60',
        selected ? 'border-primary' : working?.length ? 'border-primary/40' : 'border-border',
        faded && 'opacity-40',
      )}
    >
      <View className="flex-row items-center gap-1.5">
        {item.priority !== 'none' ? <View className={cn('h-2 w-2 rounded-full', PRIORITY_DOT[item.priority])} accessibilityLabel={`${item.priority} priority`} /> : null}
        <Text className="text-[11px] text-muted-foreground">{item.key}</Text>
        <View className="flex-1" />
        <WorkingIndicator working={working} testID={`board-card-working-${item.key}`} className="shrink" />
        {occurrences ? <Text className="text-[11px] text-muted-foreground">×{occurrences}</Text> : null}
        {compact && item.columnEnteredAt ? <Text className="text-[11px] text-muted-foreground">{age(item.columnEnteredAt)}</Text> : null}
      </View>
      <Text className="text-sm text-foreground" numberOfLines={3}>{item.title}</Text>
      <View className={cn('flex-row flex-wrap items-center gap-1.5', compact && !item.pr && !who && !issues.length && 'hidden')}>
        {item.pr ? <PullRequestChip pr={item.pr} /> : null}
        {who ? (
          <View className="flex-row items-center gap-1 rounded bg-muted px-1.5 py-0.5">
            {item.assigneeAgentRef ? <Bot size={10} className="text-muted-foreground" /> : null}
            <Text className="max-w-32 text-[11px] text-muted-foreground" numberOfLines={1}>{who}</Text>
          </View>
        ) : null}
        {!compact && item.columnEnteredAt ? <Text className="text-[11px] text-muted-foreground">{age(item.columnEnteredAt)}</Text> : null}
        {issues.map((issue) => (
          <View key={issue.type} className="rounded bg-destructive/10 px-1.5 py-0.5" accessibilityLabel={issue.detail}>
            <Text className="text-[10px] font-medium text-destructive">{ISSUE_LABEL[issue.type]}</Text>
          </View>
        ))}
      </View>
    </Pressable>
  )
}

function AddCard({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    await onAdd(t)
    setBusy(false)
    setTitle('')
  }
  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} className="flex-row items-center gap-1 rounded-md px-2 py-1.5 hover:bg-muted active:bg-muted" accessibilityRole="button">
        <Plus size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Add card</Text>
      </Pressable>
    )
  }
  return (
    <View className="gap-1.5">
      <TextInput
        value={title}
        onChangeText={setTitle}
        autoFocus
        placeholder="Card title"
        placeholderTextColor="#8a8a8a"
        accessibilityLabel="New card title"
        onSubmitEditing={() => void submit()}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === 'Escape') setOpen(false)
        }}
        className="rounded-md border border-border bg-card px-2.5 py-2 text-sm text-foreground"
      />
      <View className="flex-row gap-2">
        <Pressable accessibilityRole="button" onPress={() => void submit()} disabled={busy || !title.trim()} className={cn('rounded-md bg-primary px-3 py-1', (busy || !title.trim()) && 'opacity-50')}>
          <Text className="text-sm text-primary-foreground">Add</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setOpen(false)} className="rounded-md px-3 py-1">
          <Text className="text-sm text-muted-foreground">Cancel</Text>
        </Pressable>
      </View>
    </View>
  )
}

function IssueList({ issues, items, onOpen }: { issues: HealthIssue[]; items: WorkItem[]; onOpen: (item: WorkItem) => void }) {
  return (
    <View className="max-h-48 border-b border-border/60 bg-amber-500/5">
      <ScrollView contentContainerClassName="px-3 py-2 gap-1">
        {issues.map((issue, i) => {
          const item = issue.itemId ? items.find((x) => x.id === issue.itemId) : undefined
          return (
            <Pressable
              key={`${issue.type}:${issue.itemId ?? issue.columnId}:${i}`}
              disabled={!item}
              onPress={() => item && onOpen(item)}
              className="flex-row items-center gap-2 rounded px-1 py-1 hover:bg-muted"
            >
              <Text className="w-20 text-[11px] font-medium text-amber-700 dark:text-amber-400">{ISSUE_LABEL[issue.type]}</Text>
              <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                {issue.key ? `${issue.key} ${issue.title ?? ''} · ` : issue.column ? `${issue.column} · ` : ''}
                {issue.detail}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}
