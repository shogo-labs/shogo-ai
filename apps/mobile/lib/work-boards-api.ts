// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Work boards: Kanban boards in team channels and the cards on them. Each
 * card has a thread in its channel; `history` merges that thread with card
 * events and the other conversations that mention the card.
 */
import { createHttpClient } from './api'

export type ColumnCategory = 'backlog' | 'active' | 'waiting' | 'review' | 'done' | 'dismissed'
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none'
export type ItemType = 'task' | 'problem' | 'ticket' | 'deal' | 'candidate' | 'approval' | 'content' | 'custom'

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  task: 'Tasks',
  ticket: 'Support tickets',
  deal: 'Sales pipeline',
  candidate: 'Hiring',
  approval: 'Approvals',
  content: 'Content calendar',
  problem: 'Problems',
  custom: 'Custom',
}

export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

export const CATEGORIES: ColumnCategory[] = ['backlog', 'active', 'waiting', 'review', 'done', 'dismissed']

/** What each column category means on a cross-board view. */
export const CATEGORY_LABELS: Record<ColumnCategory, string> = {
  backlog: 'To do',
  active: 'In progress',
  waiting: 'Waiting',
  review: 'Review',
  done: 'Done',
  dismissed: 'Dismissed',
}

export interface BoardColumn {
  id: string
  name: string
  position: number
  category: ColumnCategory
  wipLimit: number | null
  agentRef: string | null
  slaHours: number | null
  /** `{ allowAutoMerge?: boolean }` — a card's PR may be armed/merged here. */
  rules?: ColumnRules
}

export interface ColumnRules {
  allowAutoMerge?: boolean
}

/** A card's linked pull request, as the server last read it from GitHub. */
export interface CardPullRequest {
  number: number
  repo: string
  url: string | null
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergedAt: string | null
  headSha: string | null
  headRef: string | null
  mergeableState: string | null
  checks: { total: number; passing: number; failing: number; pending: number }
  failing: Array<{ name: string; url: string | null }>
  armed: boolean
  queued: boolean
  ok: boolean
  /** A blocking check is red. */
  red: boolean
  /** Armed while its column does not allow arming — reported, never un-armed. */
  armingWarning?: boolean
  syncedAt: string | null
}

export interface BoardField {
  key: string
  label?: string
  type?: 'text' | 'number' | 'money' | 'date' | 'select' | 'user' | 'url' | 'boolean'
  options?: string[]
  required?: boolean
}

export interface Board {
  id: string
  workspaceId: string
  conversationId: string | null
  channelName?: string | null
  name: string
  slug: string
  keyPrefix: string
  position: number
  itemType: ItemType
  description: string | null
  fieldsSchema: BoardField[]
  postToChannel: 'all' | 'done_only' | 'none'
  requiresHumanReview: boolean
  defaultAssigneeAgentRef: string | null
  managedBy: string
  archivedAt: string | null
  columns: BoardColumn[]
  itemCount?: number
}

/** An agent reply still running in a card's thread. */
export interface WorkingAgent {
  messageId: string
  name: string
}

export interface WorkItem {
  id: string
  key: string
  number: number
  boardId: string
  columnId: string
  position: number
  title: string
  description: string | null
  fields: Record<string, unknown>
  priority: Priority
  assigneeUserId: string | null
  assigneeAgentRef: string | null
  dueAt: string | null
  conversationId: string | null
  threadRootMessageId: string | null
  source: string
  externalRef: string | null
  historySummary: string | null
  columnEnteredAt: string
  lastActivityAt: string
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  column?: { id: string; name: string; category: ColumnCategory }
  board?: { id: string; name: string; slug: string; conversationId: string | null; itemType: ItemType }
  /** The card's linked pull request, when it has one. */
  pr?: CardPullRequest
  /** Agent replies running in the card's thread right now (board views only). */
  working?: WorkingAgent[]
}

export interface HealthIssue {
  type: 'sla_breach' | 'wip_exceeded' | 'stale' | 'unassigned' | 'overdue' | 'needs_attention'
  itemId?: string
  key?: string
  title?: string
  columnId?: string
  column?: string
  detail: string
}

export interface BoardView {
  board: Board
  items: WorkItem[]
  health: { issues: HealthIssue[] }
}

export interface WorkItemEvent {
  id: string
  type: string
  actorUserId: string | null
  actorAgentRef: string | null
  sessionId: string | null
  data: Record<string, any> | null
  createdAt: string
}

export interface WorkItemLink {
  id: string
  kind: string
  refId: string | null
  conversationId: string | null
  reason: string
  snippet: string | null
  url: string | null
  /** Live state of what the link points at (a `pr` link's checks, armed, state). */
  metadata?: Record<string, unknown> | null
  syncedAt?: string | null
  private?: boolean
  createdAt: string
}

/** A card-thread message as history returns it: the author is already a display name. */
export interface CardMessage {
  id: string
  author: string
  authorType: 'user' | 'agent' | 'bot' | 'system'
  text: string
  agentSessionId: string | null
  agentStatus: string | null
  createdAt: string
}

export interface AgentRun {
  sessionId: string
  name: string
  /** The agent's project; null for the workspace agent. */
  projectId: string | null
  agentRef: string | null
  startedAt: string
  lastActiveAt: string
}

export interface WorkItemDetail {
  item: WorkItem
  board: Pick<Board, 'id' | 'name' | 'slug' | 'itemType' | 'conversationId' | 'fieldsSchema' | 'columns'>
  column: BoardColumn
  url: string
  following: boolean
  recentMessages: CardMessage[]
  links: WorkItemLink[]
  agentRuns: AgentRun[]
  events: WorkItemEvent[]
}

export type HistoryFilter = 'all' | 'comments' | 'status' | 'agent' | 'links'

export type HistoryEntry =
  | { type: 'message'; at: string; message: CardMessage }
  | { type: 'event'; at: string; event: WorkItemEvent }
  | { type: 'link'; at: string; link: WorkItemLink }

export interface InboxQuery {
  assignee?: string
  board?: string
  conversationId?: string
  category?: ColumnCategory[]
  priority?: Priority[]
  itemType?: ItemType
  q?: string
  sort?: 'priority' | 'activity' | 'due' | 'created'
  includeClosed?: boolean
}

export interface ItemPatch {
  title?: string
  description?: string | null
  fields?: Record<string, unknown>
  priority?: Priority
  assigneeUserId?: string | null
  assigneeAgentRef?: string | null
  dueAt?: string | null
}

/** True for columns whose cards are finished. */
export function isClosedCategory(category: ColumnCategory | undefined): boolean {
  return category === 'done' || category === 'dismissed'
}

/** "workspace" or "project:<id>" → the project id, or null for the workspace agent. */
export function agentRefProjectId(ref: string | null | undefined): string | null {
  return ref && ref.startsWith('project:') ? ref.slice('project:'.length) : null
}

export function agentRefFor(projectId: string | null): string {
  return projectId ? `project:${projectId}` : 'workspace'
}

export function workBoardsApi() {
  const http = createHttpClient()
  const ws = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`
  const board = (id: string) => `/api/boards/${encodeURIComponent(id)}`
  const item = (id: string) => `/api/work-items/${encodeURIComponent(id)}`
  return {
    async list(workspaceId: string, opts: { conversationId?: string; includeArchived?: boolean } = {}): Promise<Board[]> {
      const params = new URLSearchParams()
      if (opts.conversationId) params.set('conversationId', opts.conversationId)
      if (opts.includeArchived) params.set('includeArchived', 'true')
      return (await http.get<{ boards: Board[] }>(`${ws(workspaceId)}/boards?${params}`)).data.boards ?? []
    },
    async create(workspaceId: string, input: { conversationId: string; name: string; itemType: ItemType; description?: string }): Promise<Board> {
      return (await http.post<{ board: Board }>(`${ws(workspaceId)}/boards`, input)).data.board
    },
    async reorder(workspaceId: string, conversationId: string, boardIds: string[]) {
      return (await http.request<{ order: string[] }>(`${ws(workspaceId)}/boards/order`, { method: 'PUT', body: { conversationId, boardIds } })).data
    },
    async view(boardId: string, opts: { q?: string } = {}): Promise<BoardView> {
      const params = new URLSearchParams()
      if (opts.q) params.set('q', opts.q)
      return (await http.get<BoardView>(`${board(boardId)}?${params}`)).data
    },
    async update(boardId: string, patch: Partial<Pick<Board, 'name' | 'description' | 'postToChannel' | 'requiresHumanReview' | 'defaultAssigneeAgentRef'>>): Promise<Board> {
      return (await http.patch<{ board: Board }>(board(boardId), patch)).data.board
    },
    async archive(boardId: string, archived = true): Promise<Board> {
      return (await http.post<{ board: Board }>(`${board(boardId)}/archive`, { archived })).data.board
    },
    async createColumn(boardId: string, input: { name: string; category?: ColumnCategory; after?: string }) {
      return (await http.post<Board>(`${board(boardId)}/columns`, input)).data
    },
    async updateColumn(boardId: string, columnId: string, patch: Partial<Pick<BoardColumn, 'name' | 'category' | 'wipLimit' | 'agentRef' | 'slaHours' | 'rules'>>) {
      return (await http.patch<Board>(`${board(boardId)}/columns/${encodeURIComponent(columnId)}`, patch)).data
    },
    async createItem(boardId: string, input: ItemPatch & { title: string; column?: string }): Promise<WorkItem> {
      return (await http.post<{ item: WorkItem }>(`${board(boardId)}/items`, input)).data.item
    },
    async cardFromMessage(messageId: string, input: { boardId: string; title?: string }): Promise<WorkItem> {
      return (await http.post<{ item: WorkItem }>(`/api/conversation-messages/${encodeURIComponent(messageId)}/card`, input)).data.item
    },
    async inbox(workspaceId: string, query: InboxQuery = {}): Promise<{ items: WorkItem[]; boards: Board[] }> {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        params.set(k, Array.isArray(v) ? v.join(',') : String(v))
      }
      return (await http.get<{ items: WorkItem[]; boards: Board[] }>(`${ws(workspaceId)}/work-items?${params}`)).data
    },
    async bulk(workspaceId: string, ids: string[], patch: ItemPatch & { column?: string; archived?: boolean }) {
      return (await http.post<{ results: Array<{ id: string; ok: boolean; error?: string }> }>(`${ws(workspaceId)}/work-items/bulk`, { ids, patch })).data
    },
    async get(itemId: string): Promise<WorkItemDetail> {
      return (await http.get<WorkItemDetail>(item(itemId))).data
    },
    async updateItem(itemId: string, patch: ItemPatch): Promise<WorkItem> {
      return (await http.patch<{ item: WorkItem }>(item(itemId), patch)).data.item
    },
    async move(itemId: string, input: { column: string; board?: string; after?: string; before?: string }): Promise<{ item: WorkItem; warnings: string[] }> {
      return (await http.post<{ item: WorkItem; warnings: string[] }>(`${item(itemId)}/move`, input)).data
    },
    async comment(itemId: string, text: string) {
      return (await http.post(`${item(itemId)}/comments`, { text })).data
    },
    async archiveItem(itemId: string, archived = true): Promise<WorkItem> {
      return (await http.post<{ item: WorkItem }>(`${item(itemId)}/archive`, { archived })).data.item
    },
    async history(itemId: string, opts: { filter?: HistoryFilter; before?: string; limit?: number } = {}): Promise<{ entries: HistoryEntry[]; nextBefore: string | null }> {
      const params = new URLSearchParams()
      if (opts.filter) params.set('filter', opts.filter)
      if (opts.before) params.set('before', opts.before)
      if (opts.limit) params.set('limit', String(opts.limit))
      return (await http.get<{ entries: HistoryEntry[]; nextBefore: string | null }>(`${item(itemId)}/history?${params}`)).data
    },
    async follow(itemId: string, following: boolean) {
      return (await http.post<{ following: boolean }>(`${item(itemId)}/follow`, { following })).data
    },
    /** Link a PR by number (the server fills in repo/number from the URL). */
    async linkPullRequest(itemId: string, url: string, refId: string) {
      return (await http.post<{ link: WorkItemLink }>(`${item(itemId)}/links`, { kind: 'pr', refId, url, reason: 'manual' })).data
    },
  }
}

export type WorkBoardsApi = ReturnType<typeof workBoardsApi>
