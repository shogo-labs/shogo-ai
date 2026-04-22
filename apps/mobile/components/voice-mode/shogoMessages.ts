// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Mode persistence — read helpers for the Shogo overlay.
 *
 * All Shogo Mode state (voice transcript + translator AI-SDK thread)
 * lives in the `chat_messages` table tagged with `agent="voice"`, in
 * the same `ChatSession` as the technical thread. The `parts` column
 * on voice rows carries a tiny JSON envelope that discriminates the
 * sub-kind and (for text turns) preserves AI-SDK UIMessage parts:
 *
 *   { kind: 'shogo-text',       uiParts: [...] }   // AI-SDK turn
 *   { kind: 'voice' }                               // spoken turn
 *   { kind: 'agent-activity' }                      // narration mirror
 *
 * The client never POSTs to `/api/chat-messages` directly. All writes
 * go through purpose-built endpoints on `/api/voice/*` that do the
 * authz + envelope shaping server-side. This module only wraps the
 * read side (`GET /api/chat-messages`) + the transcript write endpoint
 * (`POST /api/voice/transcript/:chatSessionId`).
 */

import { Platform } from 'react-native'
import { API_URL } from '../../lib/api'

/** Dev-only verbose logger. No-ops in production builds. */
function debugLog(msg: string, data?: unknown) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(msg, data ?? '')
  }
}

export type ShogoMessageKind = 'shogo-text' | 'voice' | 'agent-activity'

export interface ShogoPartsEnvelope {
  kind: ShogoMessageKind
  /** Original AI-SDK UIMessage parts — only present on `shogo-text` rows. */
  uiParts?: unknown[]
}

export interface ShogoMessageRow {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  /** Parsed envelope. `null` if the row has no `parts` column value. */
  envelope: ShogoPartsEnvelope | null
  createdAt: number
}

/** Raw shape we receive from the generated /api/chat-messages endpoint. */
interface ChatMessageWire {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  parts: string | null
  agent: string
  createdAt: string
}

function credentials(): RequestCredentials {
  return Platform.OS === 'web' ? 'include' : 'omit'
}

function parseEnvelope(raw: string | null): ShogoPartsEnvelope | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed.kind === 'shogo-text' ||
        parsed.kind === 'voice' ||
        parsed.kind === 'agent-activity')
    ) {
      return parsed as ShogoPartsEnvelope
    }
  } catch {
    // Fall through — row has malformed parts; surface as null envelope.
  }
  return null
}

function wireToRow(m: ChatMessageWire): ShogoMessageRow {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    envelope: parseEnvelope(m.parts ?? null),
    createdAt: new Date(m.createdAt).getTime() || 0,
  }
}

/**
 * Load every voice-agent row for a chat session, sorted chronologically.
 *
 * Uses the generated `/api/chat-messages` route directly with a
 * `agent=voice` filter — no dedicated read endpoint needed, and this
 * keeps pagination / filtering / offset support for free if we want to
 * window long transcripts later.
 */
export async function loadShogoMessages(
  chatSessionId: string,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<ShogoMessageRow[]> {
  const base = API_URL ?? ''
  const params = new URLSearchParams({
    sessionId: chatSessionId,
    agent: 'voice',
  })
  if (typeof options.limit === 'number') {
    params.set('limit', String(options.limit))
  }
  const url = `${base}/api/chat-messages?${params.toString()}`
  debugLog('[shogoMessages] load request', { chatSessionId, url })

  const res = await fetch(url, {
    method: 'GET',
    credentials: credentials(),
    signal: options.signal,
  })
  if (!res.ok) {
    debugLog('[shogoMessages] load failed', {
      status: res.status,
      statusText: res.statusText,
    })
    throw new Error(
      `[shogoMessages] load failed (${res.status} ${res.statusText})`,
    )
  }
  const body = (await res.json()) as
    | { ok?: boolean; items?: ChatMessageWire[] }
    | undefined
  const items = Array.isArray(body?.items) ? body!.items : []
  const rows = items.map(wireToRow)
  rows.sort((a, b) => a.createdAt - b.createdAt)
  debugLog('[shogoMessages] load ok', {
    chatSessionId,
    count: rows.length,
    byKind: rows.reduce<Record<string, number>>((acc, r) => {
      const k = r.envelope?.kind ?? 'unknown'
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {}),
  })
  return rows
}

export interface PersistTranscriptArgs {
  chatSessionId: string
  kind: 'voice-user' | 'voice-agent' | 'agent-activity'
  text: string
  /**
   * Stable client-generated id. Strongly recommended — the server
   * upserts by id so retries are safe.
   */
  id?: string
  /** Epoch ms. Overrides the server clock for `createdAt`. */
  ts?: number
}

/**
 * Persist a single voice / agent-activity transcript entry. The server
 * does the envelope shaping and ownership check. Returns the persisted
 * row on success.
 */
export async function persistShogoTranscriptEntry(
  args: PersistTranscriptArgs,
  options: { signal?: AbortSignal } = {},
): Promise<ShogoMessageRow | null> {
  const base = API_URL ?? ''
  const url = `${base}/api/voice/transcript/${encodeURIComponent(args.chatSessionId)}`

  debugLog('[shogoMessages] persist POST', {
    id: args.id,
    kind: args.kind,
    chatSessionId: args.chatSessionId,
  })
  const res = await fetch(url, {
    method: 'POST',
    credentials: credentials(),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: args.kind,
      text: args.text,
      id: args.id,
      ts: args.ts,
    }),
    signal: options.signal,
  })
  if (!res.ok) {
    debugLog('[shogoMessages] persist POST failed', {
      id: args.id,
      status: res.status,
      statusText: res.statusText,
    })
    throw new Error(
      `[shogoMessages] transcript persist failed (${res.status} ${res.statusText})`,
    )
  }
  debugLog('[shogoMessages] persist POST ok', {
    id: args.id,
    status: res.status,
  })
  const body = (await res.json()) as
    | { ok?: boolean; data?: ChatMessageWire }
    | undefined
  if (!body?.data) return null
  return wireToRow(body.data)
}
