// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers for drawing a board: cards grouped by column, a local move
 * applied before the server confirms it, and the badges a column or card
 * shows for its health issues.
 */
import type { ChatMessage, Mentionables } from './team-chat-api'
import { agentRefProjectId, type BoardColumn, type BoardView, type HealthIssue, type WorkingAgent, type WorkItem } from './work-boards-api'

export function itemsByColumn(view: Pick<BoardView, 'board' | 'items'>): Map<string, WorkItem[]> {
  const out = new Map<string, WorkItem[]>(view.board.columns.map((c) => [c.id, []]))
  for (const item of view.items) {
    if (item.archivedAt) continue
    out.get(item.columnId)?.push(item)
  }
  for (const list of out.values()) list.sort((a, b) => a.position - b.position)
  return out
}

export interface MoveIntent {
  itemId: string
  columnId: string
  /** Drop above this card; null drops at the bottom of the column. */
  beforeId: string | null
}

/**
 * The board as it will look after the move, and the anchor the server takes.
 * Positions are fractional, like the server's, so the local guess and the
 * reloaded board agree.
 */
export function applyMove(items: WorkItem[], move: MoveIntent): { items: WorkItem[]; request: { column: string; before?: string } } | null {
  const moving = items.find((i) => i.id === move.itemId)
  if (!moving || move.beforeId === move.itemId) return null
  const column = items
    .filter((i) => i.columnId === move.columnId && i.id !== move.itemId && !i.archivedAt)
    .sort((a, b) => a.position - b.position)
  let position: number
  const at = move.beforeId ? column.findIndex((i) => i.id === move.beforeId) : -1
  if (at >= 0) {
    const prev = column[at - 1]
    position = prev ? (prev.position + column[at]!.position) / 2 : column[at]!.position - 1
  } else {
    position = (column[column.length - 1]?.position ?? 0) + 1
  }
  if (moving.columnId === move.columnId) {
    const current = column.findIndex((i) => i.position > moving.position)
    const nextId = current >= 0 ? column[current]!.id : null
    if (nextId === (at >= 0 ? move.beforeId : null)) return null
  }
  const next = items.map((i) => (i.id === move.itemId ? { ...i, columnId: move.columnId, position } : i))
  return { items: next, request: at >= 0 ? { column: move.columnId, before: move.beforeId! } : { column: move.columnId } }
}

/**
 * A team chat message as it arrives live. When it is an agent reply in a
 * card's thread, the card's `working` list gains it while it runs and loses it
 * once it settles. Returns null when no card changed.
 */
export function applyAgentMessage(view: BoardView, message: Pick<ChatMessage, 'id' | 'authorType' | 'threadRootId' | 'agentStatus' | 'authorAgent'>): BoardView | null {
  if (message.authorType !== 'agent' || !message.threadRootId) return null
  const card = view.items.find((i) => i.threadRootMessageId === message.threadRootId)
  if (!card) return null
  const current = card.working ?? []
  const running = message.agentStatus === 'running'
  const tracked = current.some((w) => w.messageId === message.id)
  if (running === tracked) return null
  const working = running
    ? [...current, { messageId: message.id, name: message.authorAgent?.name ?? 'Agent' }]
    : current.filter((w) => w.messageId !== message.id)
  return { ...view, items: view.items.map((i) => (i.id === card.id ? { ...i, working } : i)) }
}

/** "Billing Bot is working", or "2 agents working" when several replies run in one card. */
export function workingLabel(working: WorkingAgent[]): string {
  if (working.length === 1) return `${working[0]!.name} is working`
  return `${working.length} agents working`
}

export interface ColumnBadges {
  count: number
  wip: 'under' | 'at' | 'over' | null
  breaches: number
}

export function columnBadges(column: BoardColumn, count: number, issues: HealthIssue[]): ColumnBadges {
  let wip: ColumnBadges['wip'] = null
  if (column.wipLimit) wip = count > column.wipLimit ? 'over' : count === column.wipLimit ? 'at' : 'under'
  const breaches = issues.filter((i) => i.columnId === column.id && i.type === 'sla_breach').length
  return { count, wip, breaches }
}

/** Card-level issues (SLA, overdue, stale…) keyed by card id. */
export function issuesByItem(issues: HealthIssue[]): Map<string, HealthIssue[]> {
  const out = new Map<string, HealthIssue[]>()
  for (const issue of issues) {
    if (!issue.itemId) continue
    const list = out.get(issue.itemId) ?? []
    list.push(issue)
    out.set(issue.itemId, list)
  }
  return out
}

export const ISSUE_LABEL: Record<HealthIssue['type'], string> = {
  sla_breach: 'SLA',
  wip_exceeded: 'WIP',
  stale: 'Stale',
  unassigned: 'Unassigned',
  overdue: 'Overdue',
  needs_attention: 'Attention',
}

/** Who a card is with: a teammate's name, an agent's name, or null. */
export function assigneeName(item: Pick<WorkItem, 'assigneeUserId' | 'assigneeAgentRef'>, mentionables: Mentionables | null): string | null {
  if (item.assigneeUserId) {
    return mentionables?.people.find((p) => p.id === item.assigneeUserId)?.name ?? 'Teammate'
  }
  if (item.assigneeAgentRef) return agentName(item.assigneeAgentRef, mentionables)
  return null
}

export function agentName(ref: string, mentionables: Mentionables | null): string {
  const projectId = agentRefProjectId(ref)
  const agent = mentionables?.agents.find((a) => (a.projectId ?? null) === projectId)
  return agent?.name ?? (projectId ? 'Agent' : 'Workspace agent')
}

export interface AssigneeOption {
  id: string
  label: string
  patch: { assigneeUserId: string | null; assigneeAgentRef: string | null }
}

/** People first, then agents. `none` clears the assignee. */
export function assigneeOptions(mentionables: Mentionables | null): AssigneeOption[] {
  const out: AssigneeOption[] = [{ id: 'none', label: 'Unassigned', patch: { assigneeUserId: null, assigneeAgentRef: null } }]
  for (const p of mentionables?.people ?? []) {
    out.push({ id: `u:${p.id}`, label: p.name || p.email, patch: { assigneeUserId: p.id, assigneeAgentRef: null } })
  }
  for (const a of mentionables?.agents ?? []) {
    if (a.boards === false) continue
    const ref = a.projectId ? `project:${a.projectId}` : 'workspace'
    out.push({ id: `a:${ref}`, label: `${a.name} (agent)`, patch: { assigneeUserId: null, assigneeAgentRef: ref } })
  }
  return out
}

export function assigneeOptionId(item: Pick<WorkItem, 'assigneeUserId' | 'assigneeAgentRef'>): string {
  if (item.assigneeUserId) return `u:${item.assigneeUserId}`
  if (item.assigneeAgentRef) return `a:${item.assigneeAgentRef}`
  return 'none'
}

/** "3d", "5h", "12m" since a timestamp. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
