// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `historySeed` — the conversation an API-initiated turn arrives with.
 *
 * A turn a person types resends the whole thread, so the runtime can seed an
 * empty session from it. Every server-initiated turn (background-task wake,
 * queued message, scheduled run, team-chat dispatch) sends exactly one
 * message, so that path had nothing to seed from: after a pod restart, an
 * eviction or a pruned session, the agent woke to a one-line note and had no
 * idea what the conversation was about (SHO-137).
 *
 * The API stores the same conversation in `ChatMessage`, so it sends the tail
 * of it — plus the durable summary of everything older — alongside the single
 * message, and the runtime seeds from that instead.
 */

/** One prior message, oldest first. */
export interface HistorySeedMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface HistorySeed {
  /** Everything older than `messages`, already summarised. Stable bytes. */
  summary?: string | null
  messages: HistorySeedMessage[]
}

/** Cap on what a single turn may restore; the API budgets before sending. */
export const HISTORY_SEED_MAX_MESSAGES = 200
export const HISTORY_SEED_MAX_CHARS = 120_000

/**
 * Read `historySeed` off a request body, ignoring anything malformed rather
 * than failing the turn — a bad seed must never cost the user their message.
 * Returns null when there is nothing usable.
 */
export function parseHistorySeed(raw: unknown): HistorySeed | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { summary?: unknown; messages?: unknown }
  const summary = typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : null

  const rows = Array.isArray(value.messages) ? value.messages.slice(-HISTORY_SEED_MAX_MESSAGES) : []
  // Newest first, then reversed. When a seed is over the char cap the messages
  // nearest the turn are the ones that matter: reading from the head kept
  // MSG0..MSG4 of a 10 × 20k seed and dropped the tail, so the agent restored
  // the start of a conversation and nothing about the turn it was answering.
  const kept: HistorySeedMessage[] = []
  let chars = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row || typeof row !== 'object') continue
    const { role, text } = row as { role?: unknown; text?: unknown }
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof text !== 'string' || !text.trim()) continue
    const trimmed = text.trim()
    if (chars + trimmed.length > HISTORY_SEED_MAX_CHARS) break
    chars += trimmed.length
    kept.push({ role, text: trimmed })
  }

  if (kept.length === 0 && !summary) return null
  return { summary, messages: kept.reverse() }
}
