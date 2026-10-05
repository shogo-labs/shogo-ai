// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What an agent did before its final channel message.
 *
 * A channel reply shows only the agent's closing words. The turn that produced it is already
 * stored in the agent session as one assistant message (narration, tool calls, timing), the same
 * record project chat folds under "Worked for X". The reply points at it (`blocks.work`) and the
 * app loads it on demand through `loadWorkLog`.
 *
 * Channel members see this log, and tool output can hold secrets, so it is trimmed here rather
 * than in the app: reasoning is dropped, tool inputs keep short values, tool output keeps its
 * first lines, and anything that looks like a credential is masked. Which account a call acted
 * as is kept whole, as `credential` on the part.
 */

import { prisma } from '../lib/prisma'
import type { AgentWork } from './conversation-message-kind'

const db = prisma as any

const TEXT_LIMIT = 4_000
const VALUE_LIMIT = 300
const OUTPUT_LIMIT = 240

/** Fields that carry whole files or diffs; their size is the information, not their content. */
const BULKY_KEYS = new Set(['content', 'new_string', 'old_string', 'newString', 'oldString', 'diff', 'patch', 'text', 'body'])

const SECRET_PATTERNS: RegExp[] = [
  /shogo_sk_[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

/** Mask anything that looks like a credential. */
export function redactSecrets(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  out = out.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [redacted]')
  out = out.replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[=:]\s*["']?)[^\s"',;&]{6,}/gi, '$1[redacted]')
  return out
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function redactInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (BULKY_KEYS.has(key) && typeof raw === 'string' && raw.length > VALUE_LIMIT) {
      out[key] = `[${raw.length} characters]`
    } else if (typeof raw === 'string') {
      out[key] = clip(redactSecrets(raw), VALUE_LIMIT)
    } else if (typeof raw === 'number' || typeof raw === 'boolean' || raw == null) {
      out[key] = raw
    } else {
      out[key] = clip(redactSecrets(JSON.stringify(raw)), VALUE_LIMIT)
    }
  }
  return out
}

function redactOutput(output: unknown): string | undefined {
  if (output == null) return undefined
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return clip(redactSecrets(text), OUTPUT_LIMIT)
}

type Part = { type?: string; [key: string]: unknown }

const CREDENTIAL_SOURCES = new Set(['shared', 'personal', 'delegate', 'approved'])

/** Which account a tool call used ("as @bob"). Kept apart from the clipped output so channels still see it. */
function credentialUseOf(output: unknown): { source: string; actingAs: string; onBehalfOf?: string } | undefined {
  const raw = (output as { credential?: Record<string, unknown> } | null)?.credential
  if (!raw || typeof raw !== 'object') return undefined
  const { source, actingAs, onBehalfOf } = raw
  if (typeof source !== 'string' || !CREDENTIAL_SOURCES.has(source) || typeof actingAs !== 'string') return undefined
  return {
    source,
    actingAs: clip(actingAs, 80),
    ...(typeof onBehalfOf === 'string' && onBehalfOf ? { onBehalfOf: clip(onBehalfOf, 80) } : {}),
  }
}

const isToolPart = (part: Part) => part.type === 'dynamic-tool' || (typeof part.type === 'string' && part.type.startsWith('tool-'))

/** The parts before the turn's last text: what folds under "Worked for X". */
export function workLogOf(parts: Part[]): Part[] {
  let lastText = -1
  parts.forEach((part, i) => { if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lastText = i })
  return lastText === -1 ? parts.filter(isToolPart) : parts.slice(0, lastText)
}

/** The work log in a form that is safe to show every member of the channel. */
export function redactWorkLog(parts: Part[]): Part[] {
  const out: Part[] = []
  for (const part of workLogOf(parts)) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.trim()) out.push({ ...part, text: clip(redactSecrets(part.text), TEXT_LIMIT) })
    } else if (isToolPart(part)) {
      const credential = credentialUseOf(part.output)
      out.push({
        ...part,
        input: redactInput(part.input),
        output: redactOutput(part.output),
        errorText: typeof part.errorText === 'string' ? clip(redactSecrets(part.errorText), OUTPUT_LIMIT) : undefined,
        ...(credential ? { credential } : {}),
      })
    }
  }
  return out
}

function parsePartsJson(value: unknown): Part[] {
  if (Array.isArray(value)) return value as Part[]
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function timingOf(parts: Part[]): { startedAt?: number; completedAt?: number } {
  const timing = parts.find((p) => p.type === 'data-turn-timing')?.data as { startedAt?: number; completedAt?: number } | undefined
  return { startedAt: timing?.startedAt, completedAt: timing?.completedAt }
}

/**
 * Point at the turn that just ran. The assistant row is written as the stream ends, so give it a
 * moment to land.
 */
export async function agentWorkOf(sessionId: string, startedAt: Date, toolCalls: number): Promise<AgentWork | null> {
  if (!toolCalls) return null
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await db.chatMessage.findFirst({
      where: { sessionId, role: 'assistant', createdAt: { gte: startedAt } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, parts: true },
    })
    if (row) {
      const timing = timingOf(parsePartsJson(row.parts))
      return {
        chatMessageId: row.id,
        startedAt: timing.startedAt ?? startedAt.getTime(),
        completedAt: timing.completedAt ?? Date.now(),
        toolCalls,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

export interface WorkLog {
  parts: Part[]
  startedAt: number
  completedAt: number
  toolCalls: number
}

/** The redacted work log a reply points at, or null when there is nothing to show. */
export async function loadWorkLog(message: { agentSessionId?: string | null; blocks?: unknown }): Promise<WorkLog | null> {
  const work = (message.blocks as { work?: AgentWork } | null | undefined)?.work
  if (!work?.chatMessageId || !message.agentSessionId) return null
  const row = await db.chatMessage.findUnique({ where: { id: work.chatMessageId }, select: { sessionId: true, parts: true } })
  // The pointer is only good for the session the reply ran in.
  if (!row || row.sessionId !== message.agentSessionId) return null
  return { parts: redactWorkLog(parsePartsJson(row.parts)), startedAt: work.startedAt, completedAt: work.completedAt, toolCalls: work.toolCalls }
}
