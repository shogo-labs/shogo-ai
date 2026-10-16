// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "@" menu shared by the team chat composer and the channel doc editor.
 *
 * A bare "@" lists recent picks and then categories to drill into (People,
 * Agents, Channels, …). Typing searches every category at once, grouped under
 * section headers with a "See all" row when a group is cut short. Inside a
 * category the query only filters that category. Pure data, no UI: the
 * composer renders rows with React Native, the doc editor with the DOM.
 */
import { dateCandidate, type MentionCandidate } from './team-chat-state'
import type { Mentionables } from './team-chat-api'
import { docTokenFor, parseDateQuickPicks, relativeDateLabel, type DocRef } from './doc-tokens'

export type MentionCategory = 'people' | 'agents' | 'groups' | 'channels' | 'projects' | 'dates' | 'notify'

export const CATEGORY_LABELS: Record<MentionCategory, string> = {
  people: 'People',
  agents: 'Agents',
  groups: 'Groups',
  channels: 'Channels',
  projects: 'Projects',
  dates: 'Dates',
  notify: 'Notify',
}

export const COMPOSER_CATEGORIES: MentionCategory[] = ['people', 'agents', 'groups', 'channels', 'projects', 'dates', 'notify']
export const DOC_CATEGORIES: MentionCategory[] = ['people', 'agents', 'channels', 'projects', 'dates']

export interface MentionMenuData {
  people: Array<{ id: string; name: string; email?: string | null; image?: string | null; title?: string | null }>
  agents: Array<{ key: string; projectId: string | null; name: string; description?: string | null; image?: string | null }>
  groups?: Array<{ id: string; handle: string; name: string; memberIds: string[] }>
  channels?: Array<{ id: string; name: string | null; kind: string }>
  projects?: Array<{ id: string; name: string; description?: string | null }>
  statuses?: Record<string, { emoji?: string | null; text?: string | null } | null | undefined>
  meId?: string | null
  /** Who is in the channel, to flag everyone else; null outside channels. */
  memberIds?: ReadonlySet<string> | null
  /** Only members get notified (private channels). */
  membersOnly?: boolean
  /** Tokens picked recently, newest first. */
  recent?: string[]
  now?: Date
  timeZone?: string | null
}

export type MentionRowType = 'category' | 'item' | 'see-all' | 'back' | 'pick-date'

export interface MentionRow {
  key: string
  type: MentionRowType
  category: MentionCategory
  /** Header shown above the first row of each group. */
  section?: string
  label: string
  subtitle?: string | null
  /** Right-aligned hint, e.g. "Not in channel". */
  trailing?: string | null
  /** Opening this row shows that category instead of inserting anything. */
  drill?: MentionCategory
  candidate?: MentionCandidate
  /** Category rows: how many entries it holds. */
  count?: number
}

export interface MentionMenu {
  rows: MentionRow[]
  /** Shown under the list, e.g. who will actually be notified. */
  footer: string | null
}

const GROUP_CAP = 5
const DRILL_CAP = 50
const RECENT_CAP = 5

function score(name: string, q: string): number {
  const n = name.toLowerCase()
  if (n.startsWith(q)) return 0
  if (n.split(/[\s._#-]+/).some((w) => w.startsWith(q))) return 1
  if (n.includes(q)) return 2
  return -1
}

function rank(candidates: MentionCandidate[], query: string, extra: (c: MentionCandidate) => string[] = () => []): MentionCandidate[] {
  const q = query.trim().toLowerCase()
  if (!q) return candidates
  return candidates
    .map((c) => ({ c, s: Math.min(...[c.display, ...extra(c)].map((t) => score(t, q)).map((s) => (s < 0 ? 99 : s))) }))
    .filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.c)
}

/** Every candidate in a category, before any query filtering. */
export function categoryCandidates(data: MentionMenuData, category: MentionCategory, query = ''): MentionCandidate[] {
  switch (category) {
    case 'people':
      return data.people
        .filter((p) => p.id !== data.meId)
        .map((p) => ({
          kind: 'user' as const,
          display: p.name,
          token: docTokenFor({ kind: 'user', id: p.id }),
          subtitle: statusText(data, p.id) ?? p.title ?? p.email ?? null,
          userId: p.id,
          image: p.image ?? null,
        }))
    case 'agents':
      return data.agents.map((a) => ({
        kind: 'agent' as const,
        display: a.name,
        token: docTokenFor({ kind: 'agent', projectId: a.projectId }),
        subtitle: a.projectId ? 'Project agent' : 'Workspace agent',
        projectId: a.projectId,
        image: a.image ?? null,
      }))
    case 'groups':
      return (data.groups ?? []).map((g) => ({
        kind: 'group' as const,
        display: g.handle,
        token: `<@g:${g.id}>`,
        subtitle: `${g.name} · ${g.memberIds.length} ${g.memberIds.length === 1 ? 'person' : 'people'}`,
      }))
    case 'channels':
      return (data.channels ?? [])
        .filter((c) => (c.kind === 'public' || c.kind === 'private') && c.name)
        .map((c) => ({
          kind: 'channel' as const,
          display: c.name!,
          insert: `#${c.name}`,
          token: docTokenFor({ kind: 'channel', id: c.id }),
          subtitle: c.kind === 'private' ? 'Private channel' : 'Channel',
        }))
    case 'projects':
      return (data.projects ?? []).map((p) => ({
        kind: 'project' as const,
        display: p.name,
        insert: `@[project:${p.name}]`,
        token: docTokenFor({ kind: 'project', id: p.id }),
        subtitle: p.description || 'Project',
        projectId: p.id,
      }))
    case 'dates': {
      const picks = parseDateQuickPicks(query, data.now, data.timeZone)
      return picks.map((p) => ({ ...dateCandidate(p.value, data.now, data.timeZone), subtitle: p.label }))
    }
    case 'notify':
      return [
        { kind: 'special' as const, display: 'here', token: '<!here>', subtitle: 'Notify everyone online' },
        { kind: 'special' as const, display: 'channel', token: '<!channel>', subtitle: 'Notify everyone in this channel' },
      ]
  }
}

function statusText(data: MentionMenuData, userId: string): string | null {
  const s = data.statuses?.[userId]
  if (!s || (!s.emoji && !s.text)) return null
  return [s.emoji, s.text].filter(Boolean).join(' ')
}

function itemRow(data: MentionMenuData, category: MentionCategory, c: MentionCandidate, section?: string): MentionRow {
  const outside = c.kind === 'user' && data.memberIds && c.userId && !data.memberIds.has(c.userId)
  return {
    key: `${category}:${c.token}`,
    type: 'item',
    category,
    section,
    label: c.display,
    subtitle: c.subtitle ?? null,
    trailing: outside ? 'Not in channel' : null,
    candidate: c,
  }
}

function matches(data: MentionMenuData, category: MentionCategory, query: string): MentionCandidate[] {
  const all = categoryCandidates(data, category, query)
  if (category === 'dates') return all
  return rank(all, query, (c) => (c.kind === 'user' ? [c.subtitle ?? ''] : []))
}

/**
 * The rows to show for `query` (what follows "@") inside `drill` (an open
 * category, or null at the top level), limited to `categories`.
 */
export function buildMentionMenu(data: MentionMenuData, categories: MentionCategory[], query: string, drill: MentionCategory | null): MentionMenu {
  const footer = data.membersOnly && categories.includes('people') ? 'Only people in this channel will be notified' : null
  const q = query.trim()

  if (drill) {
    const rows: MentionRow[] = [{ key: 'back', type: 'back', category: drill, label: CATEGORY_LABELS[drill], subtitle: 'Back' }]
    const found = drill === 'dates' && !q ? categoryCandidates(data, 'dates', '') : matches(data, drill, q)
    rows.push(...found.slice(0, DRILL_CAP).map((c) => itemRow(data, drill, c)))
    if (drill === 'dates') rows.push({ key: 'pick-date', type: 'pick-date', category: 'dates', label: 'Pick a date…' })
    return { rows, footer }
  }

  if (!q) {
    const rows: MentionRow[] = []
    const recent = recentRows(data, categories)
    rows.push(...recent)
    for (const category of categories) {
      const count = category === 'dates' ? undefined : categoryCandidates(data, category).length
      if (count === 0) continue
      rows.push({
        key: `category:${category}`,
        type: 'category',
        category,
        section: rows.length === recent.length && recent.length ? 'Browse' : undefined,
        label: CATEGORY_LABELS[category],
        subtitle: count === undefined ? 'Today, tomorrow, or pick a date' : `${count}`,
        drill: category,
        count,
      })
    }
    return { rows, footer }
  }

  const rows: MentionRow[] = []
  for (const category of categories) {
    const found = matches(data, category, q)
    if (!found.length) continue
    const section = CATEGORY_LABELS[category]
    found.slice(0, GROUP_CAP).forEach((c, i) => rows.push(itemRow(data, category, c, i === 0 ? section : undefined)))
    if (found.length > GROUP_CAP) {
      rows.push({ key: `see-all:${category}`, type: 'see-all', category, label: `See all ${found.length} ${section.toLowerCase()}`, drill: category })
    }
  }
  if (categories.includes('dates') && /^(date|pick|cal)/i.test(q)) {
    rows.push({ key: 'pick-date', type: 'pick-date', category: 'dates', section: rows.some((r) => r.category === 'dates') ? undefined : 'Dates', label: 'Pick a date…' })
  }
  return { rows, footer }
}

function recentRows(data: MentionMenuData, categories: MentionCategory[]): MentionRow[] {
  if (!data.recent?.length) return []
  const byToken = new Map<string, { category: MentionCategory; c: MentionCandidate }>()
  for (const category of categories) {
    if (category === 'dates') continue
    for (const c of categoryCandidates(data, category)) byToken.set(c.token, { category, c })
  }
  const rows: MentionRow[] = []
  for (const token of data.recent) {
    const hit = byToken.get(token)
    if (!hit) continue
    rows.push(itemRow(data, hit.category, hit.c, rows.length ? undefined : 'Recent'))
    if (rows.length >= RECENT_CAP) break
  }
  return rows
}

/** In a private channel only members get notified, so the menu flags everyone else. */
export function privateMemberIds(conversation: { kind: string; members: Array<{ type: string; userId?: string }> }): string[] | null {
  if (conversation.kind !== 'private') return null
  return conversation.members.flatMap((m) => (m.type === 'user' && m.userId ? [m.userId] : []))
}

/** Menu data from the workspace's mentionables. */
export function mentionMenuData(
  mentionables: Mentionables | null,
  meId: string | null,
  extra: Pick<MentionMenuData, 'memberIds' | 'membersOnly' | 'recent' | 'now' | 'timeZone'> = {},
): MentionMenuData {
  return {
    people: mentionables?.people ?? [],
    agents: mentionables?.agents ?? [],
    groups: mentionables?.groups ?? [],
    channels: mentionables?.channels ?? [],
    projects: mentionables?.projects ?? [],
    statuses: mentionables?.statuses,
    meId,
    ...extra,
  }
}

/** Every fixed candidate (dates are made on the fly), for turning tokens back into chips. */
export function allMentionCandidates(data: MentionMenuData, categories: MentionCategory[] = COMPOSER_CATEGORIES): MentionCandidate[] {
  return categories.filter((c) => c !== 'dates').flatMap((c) => categoryCandidates(data, c))
}

/** The candidate a token stands for, including dates. */
export function candidateForToken(token: string, byToken: ReadonlyMap<string, MentionCandidate>, now?: Date, tz?: string | null): MentionCandidate | null {
  const known = byToken.get(token)
  if (known) return known
  const date = /^<!date:([^>]+)>$/.exec(token)
  return date ? dateCandidate(date[1], now, tz) : null
}

/** How a chip reads: "@Sam", "#devops", "Website", "Friday". `known` is false for deleted targets. */
export function docRefLabel(ref: DocRef, data: MentionMenuData): { text: string; known: boolean } {
  switch (ref.kind) {
    case 'user': {
      const p = data.people.find((x) => x.id === ref.id)
      return p ? { text: `@${p.name}`, known: true } : { text: '@unknown person', known: false }
    }
    case 'agent': {
      const a = data.agents.find((x) => x.projectId === ref.projectId)
      return a ? { text: `@${a.name}`, known: true } : { text: '@unknown agent', known: false }
    }
    case 'channel': {
      const c = data.channels?.find((x) => x.id === ref.id)
      return c?.name ? { text: `#${c.name}`, known: true } : { text: '#private-channel', known: false }
    }
    case 'project': {
      const p = data.projects?.find((x) => x.id === ref.id)
      return p ? { text: p.name, known: true } : { text: 'Unknown project', known: false }
    }
    case 'date':
      return { text: relativeDateLabel(ref.value, data.now, data.timeZone), known: true }
  }
}

// ─── Recent picks ────────────────────────────────────────────────────────────

const RECENT_KEY = 'shogo:mention-recent:'
const memoryRecent = new Map<string, string[]>()

export function recentMentions(workspaceId: string): string[] {
  const cached = memoryRecent.get(workspaceId)
  if (cached) return cached
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY + workspaceId)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    memoryRecent.set(workspaceId, parsed)
    return parsed
  } catch {
    return []
  }
}

export function rememberMention(workspaceId: string, token: string): void {
  if (token.startsWith('<!date:')) return
  const next = [token, ...recentMentions(workspaceId).filter((t) => t !== token)].slice(0, 20)
  memoryRecent.set(workspaceId, next)
  try {
    globalThis.localStorage?.setItem(RECENT_KEY + workspaceId, JSON.stringify(next))
  } catch {
    // Best effort; recents are a convenience.
  }
}
