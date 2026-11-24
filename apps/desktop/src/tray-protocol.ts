// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Wire types shared by the app renderer and the main process for the menu-bar
// dropdown, plus the validation every publish goes through. The app side
// (apps/mobile/lib/desktop-tray.ts) mirrors these shapes; nothing here may
// include text or a count the main process has not re-derived itself.

import { parseAppPath } from './island-protocol'

/** A chat row's dot. Absent means the row carries no dot at all. */
export type TrayRowStatus = 'running' | 'needs_you' | 'new'

export const TRAY_ROW_STATUSES: readonly TrayRowStatus[] = ['running', 'needs_you', 'new']

export interface TrayRow {
  sessionId: string
  /** null for a workspace-agent chat, the projectId for a project chat. */
  projectId: string | null
  title: string
  status: TrayRowStatus | null
  /** In-app route that opens this chat when no window already has it open. */
  path: string
}

export interface TrayGroup {
  /** Agent or project name, e.g. "Shogo Dev 5" or "Shogo". */
  title: string
  rows: TrayRow[]
}

export interface TrayModel {
  pinned: TrayRow[]
  /** One section per agent/project that has something worth a dot. */
  groups: TrayGroup[]
  /** The 5 newest chats, used only when no chat has a dot. */
  recent: TrayRow[]
  /** Chats that need you or have a reply you have not opened. */
  attentionCount: number
  /** At least one blue dot is showing, so "Clear All Notifications" can act. */
  canClear: boolean
}

export const EMPTY_TRAY_MODEL: TrayModel = {
  pinned: [],
  groups: [],
  recent: [],
  attentionCount: 0,
  canClear: false,
}

/** Sections the dropdown will show at most (matches the plan's 6×5 cap). */
export const TRAY_MAX_GROUPS = 6
export const TRAY_MAX_ROWS_PER_GROUP = 5
export const TRAY_MAX_PINNED = 5
export const TRAY_MAX_RECENT = 5
/** A chat title is menu text, not a paragraph. */
export const TRAY_MAX_TITLE_CHARS = 80
export const TRAY_MAX_GROUP_TITLE_CHARS = 60
export const TRAY_MAX_ATTENTION_COUNT = 999

const MAX_SESSION_ID_CHARS = 200
const MAX_PATH_CHARS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseDescription(value: unknown, maxChars: number): string | null {
  const text = str(value)?.trim()
  if (!text) return null
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text
}

function parseStatus(value: unknown): TrayRowStatus | null {
  return TRAY_ROW_STATUSES.includes(value as TrayRowStatus) ? (value as TrayRowStatus) : null
}

function parseRow(value: unknown): TrayRow | null {
  if (!isRecord(value)) return null
  const sessionId = str(value.sessionId)?.trim()
  const path = parseAppPath(value.path)
  const title = parseDescription(value.title, TRAY_MAX_TITLE_CHARS)
  if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS) return null
  if (!path || path.length > MAX_PATH_CHARS) return null
  const projectId = str(value.projectId)?.trim()
  return {
    sessionId,
    projectId: projectId ? projectId.slice(0, MAX_SESSION_ID_CHARS) : null,
    title: title ?? 'Untitled chat',
    status: parseStatus(value.status),
    path,
  }
}

function parseRows(value: unknown, max: number, seen: Set<string> = new Set()): TrayRow[] {
  if (!Array.isArray(value)) return []
  const rows: TrayRow[] = []
  for (const raw of value) {
    const row = parseRow(raw)
    if (!row || seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    rows.push(row)
    if (rows.length >= max) break
  }
  return rows
}

function parseGroups(value: unknown, seen: Set<string>): TrayGroup[] {
  if (!Array.isArray(value)) return []
  const groups: TrayGroup[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const title = parseDescription(raw.title, TRAY_MAX_GROUP_TITLE_CHARS)
    const rows = parseRows(raw.rows, TRAY_MAX_ROWS_PER_GROUP, seen)
    if (!title || rows.length === 0) continue
    groups.push({ title, rows })
    if (groups.length >= TRAY_MAX_GROUPS) break
  }
  return groups
}

/** Chats that want a person: one waiting on them, or a reply they have not read. */
export function trayAttentionRows(model: Pick<TrayModel, 'pinned' | 'groups' | 'recent'>): TrayRow[] {
  const rows = [
    ...model.pinned,
    ...model.groups.flatMap((group) => group.rows),
    ...model.recent,
  ]
  const seen = new Set<string>()
  const out: TrayRow[] = []
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    if (row.status === 'needs_you' || row.status === 'new') out.push(row)
  }
  return out
}

/**
 * Everything the dropdown draws comes from this one call: drop malformed rows
 * and groups, cap the lengths, and derive the count and the "can clear" flag
 * from the rows themselves so the number beside the icon can never disagree
 * with the dots in the menu.
 */
export function parseTrayModel(value: unknown): TrayModel {
  if (!isRecord(value)) return EMPTY_TRAY_MODEL
  // One chat, one row: a pinned chat is not repeated under its agent, and a
  // section does not repeat a chat an earlier section already showed.
  const seen = new Set<string>()
  const model: TrayModel = {
    pinned: parseRows(value.pinned, TRAY_MAX_PINNED, seen),
    groups: parseGroups(value.groups, seen),
    recent: parseRows(value.recent, TRAY_MAX_RECENT, seen),
    attentionCount: 0,
    canClear: false,
  }
  const attention = trayAttentionRows(model)
  model.attentionCount = Math.min(attention.length, TRAY_MAX_ATTENTION_COUNT)
  model.canClear = model.pinned
    .concat(model.groups.flatMap((group) => group.rows), model.recent)
    .some((row) => row.status === 'new')
  return model
}

/** Same contents → keep the previous menu (guards the rebuild on every publish). */
export function trayModelChanged(a: TrayModel, b: TrayModel): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}
