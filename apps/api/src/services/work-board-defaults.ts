// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure parts of work boards: the allowed values, the columns each item type
 * starts with, and the small parsers shared by the routes, the service and the
 * manifest apply path.
 */

export const ITEM_TYPES = ['task', 'problem', 'ticket', 'deal', 'candidate', 'approval', 'content', 'custom'] as const
export type ItemType = (typeof ITEM_TYPES)[number]

export const COLUMN_CATEGORIES = ['backlog', 'active', 'waiting', 'review', 'done', 'dismissed'] as const
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number]

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const
export type Priority = (typeof PRIORITIES)[number]

export const POST_TO_CHANNEL = ['all', 'done_only', 'none'] as const
export type PostToChannel = (typeof POST_TO_CHANNEL)[number]

export const LINK_KINDS = ['message', 'thread', 'chat_session', 'agent_task', 'external_thread', 'pr', 'doc'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_REASONS = ['origin', 'mention', 'agent_run', 'tool_call', 'escalation', 'manual', 'sync'] as const
export type LinkReason = (typeof LINK_REASONS)[number]

export const ITEM_SOURCES = ['manual', 'message', 'trigger', 'agent', 'api', 'problem'] as const
export type ItemSource = (typeof ITEM_SOURCES)[number]

export interface ColumnPreset {
  name: string
  category: ColumnCategory
}

const col = (name: string, category: ColumnCategory): ColumnPreset => ({ name, category })

/** Columns a new board gets when none are given. Problem columns follow Interfere's lifecycle. */
export const DEFAULT_COLUMNS: Record<ItemType, ColumnPreset[]> = {
  task: [col('Backlog', 'backlog'), col('In progress', 'active'), col('Review', 'review'), col('Done', 'done')],
  problem: [
    col('Detected', 'backlog'),
    col('Investigating', 'active'),
    col('In recovery', 'active'),
    col('Needs attention', 'waiting'),
    col('Resolved', 'done'),
    col('Dismissed', 'dismissed'),
  ],
  ticket: [col('New', 'backlog'), col('Open', 'active'), col('Waiting on customer', 'waiting'), col('Solved', 'done')],
  deal: [
    col('Lead', 'backlog'),
    col('Qualified', 'active'),
    col('Proposal', 'active'),
    col('Negotiation', 'review'),
    col('Won', 'done'),
    col('Lost', 'dismissed'),
  ],
  candidate: [
    col('Applied', 'backlog'),
    col('Screen', 'active'),
    col('Interview', 'active'),
    col('Offer', 'review'),
    col('Hired', 'done'),
    col('Rejected', 'dismissed'),
  ],
  approval: [col('Requested', 'backlog'), col('In review', 'review'), col('Approved', 'done'), col('Rejected', 'dismissed')],
  content: [col('Ideas', 'backlog'), col('Drafting', 'active'), col('Review', 'review'), col('Scheduled', 'waiting'), col('Published', 'done')],
  custom: [col('To do', 'backlog'), col('Doing', 'active'), col('Done', 'done')],
}

export function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'board'
}

/** "Support Tickets" -> "ST", "Sales" -> "SAL", "Bug triage" -> "BT". */
export function keyPrefixFor(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return 'CARD'
  if (words.length === 1) return words[0].slice(0, 3)
  return words.slice(0, 4).map((w) => w[0]).join('')
}

export function normalizeKeyPrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  return /^[A-Z][A-Z0-9]*$/.test(cleaned) ? cleaned : undefined
}

/** Card keys mentioned in free text, e.g. "see SUP-42 and ENG-7". */
export const CARD_KEY_RE = /\b([A-Z][A-Z0-9]{0,5})-(\d{1,7})\b/g

export function cardKeysIn(text: string | null | undefined): string[] {
  if (!text) return []
  const keys = new Set<string>()
  for (const m of text.matchAll(CARD_KEY_RE)) keys.add(`${m[1]}-${m[2]}`)
  return [...keys].slice(0, 20)
}

/** "workspace" or "project:<id>"; also accepts a bare project id. */
export function normalizeAgentRef(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!v) return null
  if (v === 'workspace' || v === 'ws') return 'workspace'
  if (v.startsWith('project:')) return v.length > 8 ? v : undefined
  return /^[A-Za-z0-9_-]{8,}$/.test(v) ? `project:${v}` : undefined
}

export function agentRefProjectId(ref: string): string | null {
  return ref.startsWith('project:') ? ref.slice('project:'.length) : null
}

export function agentRefFor(projectId: string | null): string {
  return projectId ? `project:${projectId}` : 'workspace'
}

export type CardStatus = 'working' | 'blocked' | 'done' | 'failed'

export function cardStatusFor(category: ColumnCategory | string): CardStatus {
  if (category === 'done' || category === 'dismissed') return 'done'
  if (category === 'waiting') return 'blocked'
  return 'working'
}

export function isClosed(category: string): boolean {
  return category === 'done' || category === 'dismissed'
}

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'money' | 'date' | 'select' | 'user' | 'url' | 'boolean'
  options?: string[]
  required?: boolean
}

const FIELD_TYPES = ['text', 'number', 'money', 'date', 'select', 'user', 'url', 'boolean'] as const

export function normalizeFieldsSchema(value: unknown): FieldDef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: FieldDef[] = []
  const seen = new Set<string>()
  for (const raw of value.slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const key = typeof r.key === 'string' ? r.key.trim().replace(/[^\w]/g, '_').slice(0, 40) : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    const type = oneOf(FIELD_TYPES, r.type) ?? 'text'
    const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string').slice(0, 50) : undefined
    out.push({
      key,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : key,
      type,
      ...(type === 'select' && options?.length ? { options } : {}),
      ...(r.required === true ? { required: true } : {}),
    })
  }
  return out
}

/** Hours from `from` to `to`, for SLA and staleness. */
export function hoursBetween(from: Date | string, to: Date | string = new Date()): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000
}

/**
 * Read a dotted path out of an event payload ("ticket.subject"). Used by
 * trigger card targets to map event fields onto a card.
 */
export function readPath(payload: unknown, path: string): unknown {
  let cur: any = payload
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** "{{ticket.subject}} from {{requester.email}}" filled from the payload; a bare path reads the value. */
export function renderTemplate(template: string, payload: unknown): string {
  if (!template.includes('{{')) {
    const v = readPath(payload, template)
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  }
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = readPath(payload, path)
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  })
}
