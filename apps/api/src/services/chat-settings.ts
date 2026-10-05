// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-person, per-workspace chat settings: custom status, Do Not Disturb,
 * quiet hours, the default channel notification level, keyword alerts, and
 * the email digest opt-in.
 */

import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { ConversationError } from './conversation.service'

const db = prisma as any

export const NOTIFY_LEVELS = ['all', 'mentions', 'none'] as const
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number]
export const DIGEST_MODES = ['off', 'daily'] as const
const QUIET_HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const MAX_KEYWORDS = 20
const MAX_KEYWORD_CHARS = 40

export interface ChatSettings {
  statusEmoji: string | null
  statusText: string | null
  statusExpiresAt: string | null
  dndUntil: string | null
  quietHours: string | null
  timezone: string | null
  notifyDefault: NotifyLevel
  keywords: string[]
  emailDigest: 'off' | 'daily'
}

export interface UserStatus {
  emoji: string | null
  text: string | null
  expiresAt: string | null
  dnd: boolean
}

const DEFAULTS: ChatSettings = {
  statusEmoji: null,
  statusText: null,
  statusExpiresAt: null,
  dndUntil: null,
  quietHours: null,
  timezone: null,
  notifyDefault: 'mentions',
  keywords: [],
  emailDigest: 'off',
}

export function parseKeywords(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((k) => k.trim()).filter(Boolean)
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function statusLive(row: any, now: Date): boolean {
  if (!row?.statusEmoji && !row?.statusText) return false
  return !row.statusExpiresAt || new Date(row.statusExpiresAt) > now
}

export function serializeSettings(row: any, now = new Date()): ChatSettings {
  if (!row) return { ...DEFAULTS }
  const live = statusLive(row, now)
  return {
    statusEmoji: live ? row.statusEmoji ?? null : null,
    statusText: live ? row.statusText ?? null : null,
    statusExpiresAt: live ? iso(row.statusExpiresAt) : null,
    dndUntil: row.dndUntil && new Date(row.dndUntil) > now ? iso(row.dndUntil) : null,
    quietHours: row.quietHours ?? null,
    timezone: row.timezone ?? null,
    notifyDefault: (NOTIFY_LEVELS as readonly string[]).includes(row.notifyDefault) ? row.notifyDefault : 'mentions',
    keywords: parseKeywords(row.keywords),
    emailDigest: row.emailDigest === 'daily' ? 'daily' : 'off',
  }
}

function minutesInZone(now: Date, timezone: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now)
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return h * 60 + m
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes()
  }
}

export function inQuietHours(quietHours: string | null | undefined, timezone: string | null | undefined, now = new Date()): boolean {
  const match = quietHours ? QUIET_HOURS_RE.exec(quietHours) : null
  if (!match) return false
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start === end) return false
  const t = minutesInZone(now, timezone ?? null)
  return start < end ? t >= start && t < end : t >= start || t < end
}

/** True when alerts should be held: DND is on or it's inside quiet hours. */
export function isSilenced(row: any, now = new Date()): boolean {
  if (!row) return false
  if (row.dndUntil && new Date(row.dndUntil) > now) return true
  return inQuietHours(row.quietHours, row.timezone, now)
}

export async function getSettingsRow(workspaceId: string, userId: string) {
  return db.chatUserSettings.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } })
}

export async function getSettingsRows(workspaceId: string, userIds: string[]): Promise<Map<string, any>> {
  if (!userIds.length) return new Map()
  const rows = await db.chatUserSettings.findMany({ where: { workspaceId, userId: { in: userIds } } })
  return new Map(rows.map((r: any) => [r.userId, r]))
}

export async function getChatSettings(workspaceId: string, userId: string): Promise<ChatSettings> {
  return serializeSettings(await getSettingsRow(workspaceId, userId))
}

export function toStatus(row: any, now = new Date()): UserStatus | null {
  const s = serializeSettings(row, now)
  const dnd = !!s.dndUntil
  if (!s.statusEmoji && !s.statusText && !dnd) return null
  return { emoji: s.statusEmoji, text: s.statusText, expiresAt: s.statusExpiresAt, dnd }
}

export async function listStatuses(workspaceId: string, userIds?: string[]): Promise<Record<string, UserStatus>> {
  const now = new Date()
  const rows = await db.chatUserSettings.findMany({
    where: {
      workspaceId,
      ...(userIds ? { userId: { in: userIds } } : {}),
      OR: [{ statusEmoji: { not: null } }, { statusText: { not: null } }, { dndUntil: { gt: now } }],
    },
  })
  const out: Record<string, UserStatus> = {}
  for (const row of rows) {
    const status = toStatus(row, now)
    if (status) out[row.userId] = status
  }
  return out
}

function parseDate(value: unknown, field: string): Date | null {
  if (value === null || value === '') return null
  const d = new Date(value as any)
  if (Number.isNaN(d.getTime())) throw new ConversationError(400, 'invalid_settings', `${field} must be a date`)
  return d
}

export function validateTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function updateChatSettings(
  workspaceId: string,
  userId: string,
  patch: Record<string, unknown>,
): Promise<ChatSettings> {
  const data: Record<string, unknown> = {}
  const str = (v: unknown, max: number, field: string) => {
    if (v === null || v === '') return null
    if (typeof v !== 'string') throw new ConversationError(400, 'invalid_settings', `${field} must be text`)
    const t = v.trim()
    if (t.length > max) throw new ConversationError(400, 'invalid_settings', `${field} is too long`)
    return t || null
  }
  if ('statusEmoji' in patch) data.statusEmoji = str(patch.statusEmoji, 64, 'statusEmoji')
  if ('statusText' in patch) data.statusText = str(patch.statusText, 100, 'statusText')
  if ('statusExpiresAt' in patch) data.statusExpiresAt = parseDate(patch.statusExpiresAt, 'statusExpiresAt')
  if ('dndUntil' in patch) data.dndUntil = parseDate(patch.dndUntil, 'dndUntil')
  if ('quietHours' in patch) {
    const q = str(patch.quietHours, 11, 'quietHours')
    if (q && !QUIET_HOURS_RE.test(q)) throw new ConversationError(400, 'invalid_settings', 'quietHours must look like 22:00-08:00')
    data.quietHours = q
  }
  if ('timezone' in patch) {
    const tz = str(patch.timezone, 64, 'timezone')
    if (tz && !validateTimezone(tz)) throw new ConversationError(400, 'invalid_settings', 'Unknown timezone')
    data.timezone = tz
  }
  if ('notifyDefault' in patch) {
    if (!(NOTIFY_LEVELS as readonly unknown[]).includes(patch.notifyDefault)) {
      throw new ConversationError(400, 'invalid_settings', 'notifyDefault must be all, mentions, or none')
    }
    data.notifyDefault = patch.notifyDefault
  }
  if ('keywords' in patch) {
    const list = Array.isArray(patch.keywords) ? patch.keywords : parseKeywords(String(patch.keywords ?? ''))
    const clean = [...new Set(list.map((k) => String(k).replace(/,/g, ' ').trim().toLowerCase()).filter(Boolean))]
    if (clean.length > MAX_KEYWORDS) throw new ConversationError(400, 'invalid_settings', `At most ${MAX_KEYWORDS} keywords`)
    if (clean.some((k) => k.length > MAX_KEYWORD_CHARS)) throw new ConversationError(400, 'invalid_settings', 'Keyword is too long')
    data.keywords = clean.length ? clean.join(',') : null
  }
  if ('emailDigest' in patch) {
    if (!(DIGEST_MODES as readonly unknown[]).includes(patch.emailDigest)) {
      throw new ConversationError(400, 'invalid_settings', 'emailDigest must be off or daily')
    }
    data.emailDigest = patch.emailDigest
  }

  const row = await db.chatUserSettings.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, ...data },
    update: data,
  })
  if (['statusEmoji', 'statusText', 'statusExpiresAt', 'dndUntil'].some((k) => k in data)) {
    publishConversationEvent(workspaceId, { type: 'status.changed', userId, status: toStatus(row) })
  }
  return serializeSettings(row)
}
