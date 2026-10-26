// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read the final state of a company simulation the same way in every arm.
 *
 * Arms A and C keep state on cards. Arm B has no boards: a card is the
 * top-level `[KEY]` message in its channel, and the agent records changes as
 * thread replies with `Status:`, `Priority:` and `Owner:` lines (the
 * convention the arm B instructions teach). `cardView` folds both into one
 * shape so a criterion like "SUP-12 is back in Open" grades every arm alike.
 */
import type { Category, SimMessage, WorldSnapshot } from './world'

export interface CardView {
  key: string
  exists: boolean
  board: string
  column: string
  category: Category | null
  priority: string
  /** Assigned person id or name, or agent key. */
  assignee: string | null
  /** Due date as YYYY-MM-DD. */
  due: string | null
  /** Everything the agent wrote about the card: comments, and posts that name it. */
  notes: string[]
}

export function cardView(s: WorldSnapshot, key: string): CardView {
  const item = s.items.find((i) => i.key === key)
  if (!item) return { key, exists: false, board: '', column: '', category: null, priority: 'none', assignee: null, due: null, notes: [] }
  const board = s.boards.find((b) => b.id === item.board)!
  const categoryOf = (col: string) => board.columns.find((c) => c.name.toLowerCase() === col.toLowerCase())?.category ?? null

  if (s.arm !== 'B') {
    const notes = [
      ...item.history.filter((e) => e.author === s.me && e.kind === 'comment').map((e) => e.text),
      ...myMessages(s).filter((m) => mentionsKey(m.text, key)).map((m) => m.text),
    ]
    return {
      key, exists: true, board: board.name, column: item.column, category: categoryOf(item.column), priority: item.priority,
      assignee: item.assigneeUser ?? item.assigneeAgent ?? null, due: dayOf(item.dueAt), notes,
    }
  }

  const rootId = `card-${key}`
  const replies = myMessages(s).filter((m) => m.threadId === rootId)
  const elsewhere = myMessages(s).filter((m) => m.threadId !== rootId && mentionsKey(m.text, key))
  let column = item.column
  let priority = item.priority as string
  let assignee = item.assigneeUser ?? item.assigneeAgent ?? null
  let due = dayOf(item.dueAt)
  for (const r of replies) {
    const status = lastMatch(r.text, /^\s*\**status\**\s*[:\-]\s*\**(.+?)\**\s*$/gim)
    if (status) {
      const col = board.columns.find((c) => status.toLowerCase().startsWith(c.name.toLowerCase()))
      if (col) column = col.name
    }
    const pri = lastMatch(r.text, /^\s*\**priority\**\s*[:\-]\s*\**(urgent|high|medium|low|none)\b/gim)
    if (pri) priority = pri.toLowerCase()
    const owner = lastMatch(r.text, /^\s*\**owner\**\s*[:\-]\s*\**(.+?)\**\s*$/gim)
    if (owner) assignee = owner
    const dueLine = lastMatch(r.text, /^\s*\**due( date)?\**\s*[:\-]\s*\**(.+?)\**\s*$/gim, 2)
    if (dueLine && dayOf(dueLine)) due = dayOf(dueLine)
  }
  return { key, exists: true, board: board.name, column, category: categoryOf(column), priority, assignee, due, notes: [...replies, ...elsewhere].map((m) => m.text) }
}

/** Cards the agent opened on a board (arm B: top-level "New request" posts in the board's channel). */
export function newCards(s: WorldSnapshot, boardName: string): Array<{ title: string; text: string }> {
  const board = s.boards.find((b) => b.name.toLowerCase() === boardName.toLowerCase())
  if (!board) return []
  if (s.arm !== 'B') {
    return s.items
      .filter((i) => i.board === board.id && i.history[0]?.kind === 'created' && i.history[0]?.author === s.me)
      .map((i) => ({ title: i.title, text: `${i.title}\n${i.description ?? ''}` }))
  }
  return myMessages(s)
    .filter((m) => m.channel === board.channel && !m.threadId && /^\W*new request\b/i.test(m.text))
    .map((m) => ({ title: m.text.split('\n')[0], text: m.text }))
}

/** Messages the agent posted, optionally in one channel (`dm:<personId>` for DMs). */
export function myMessages(s: WorldSnapshot, channel?: string): SimMessage[] {
  return s.messages.filter((m) => m.author === s.me && (!channel || m.channel === channel.replace(/^#/, '')))
}

/** Everything the agent wrote anywhere: posts, DMs and card comments. */
export function allAgentText(s: WorldSnapshot): string {
  const comments = s.items.flatMap((i) => i.history.filter((e) => e.author === s.me && e.kind === 'comment').map((e) => e.text))
  return [...myMessages(s).map((m) => m.text), ...comments].join('\n\n')
}

/** Calls the agent made to an external system tool. */
export function systemActions(s: WorldSnapshot, tool: string): Array<Record<string, unknown>> {
  return s.log.filter((l) => l.tool === tool && l.ok).map((l) => l.params)
}

export function systemRecord(s: WorldSnapshot, system: string, id: string): Record<string, unknown> | undefined {
  return s.systems[system]?.records.find((r) => String(r.id) === id)
}

/** True when the text names any of the terms (case-insensitive; strings or regexes). */
export function mentions(text: string, ...terms: Array<string | RegExp>): boolean {
  return terms.some((t) => typeof t === 'string' ? text.toLowerCase().includes(t.toLowerCase()) : t.test(text))
}

export function isClosed(c: CardView): boolean {
  return c.category === 'done' || c.category === 'dismissed'
}

function mentionsKey(text: string, key: string): boolean {
  return new RegExp(`\\b${key}\\b`, 'i').test(text)
}

function lastMatch(text: string, re: RegExp, group = 1): string | null {
  let out: string | null = null
  for (const m of text.matchAll(re)) out = m[group].trim()
  return out
}

/** YYYY-MM-DD for an ISO time or a written date ("Oct 27", "October 27, 2026"); the sim year is 2026. */
export function dayOf(v: string | null | undefined): string | null {
  if (!v) return null
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v)
  if (iso) return iso[1]
  if (!/\b([1-9]|[12]\d|3[01])\b/.test(v)) return null
  const t = Date.parse(/\b\d{4}\b/.test(v) ? v : `${v} 2026`)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whether the person (by id, name or first name) is the card's assignee. */
export function assignedTo(c: CardView, person: { id: string; name: string }): boolean {
  const a = (c.assignee ?? '').toLowerCase().replace(/^@/, '')
  return !!a && (a === person.id.toLowerCase() || a === person.name.toLowerCase() || a.startsWith(person.name.split(' ')[0].toLowerCase()))
}
