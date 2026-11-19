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

/** The slice of a session store this module writes to. */
export interface HistorySeedSession {
  /** How many messages the session already holds (0 when it is empty). */
  messageCount(): number
  /** Write the seeded messages; returns how many were actually added. */
  appendSeed(messages: HistorySeedMessage[]): number
  /** The session's own compaction summary, if it has one. */
  currentSummary(): string | null
  setSummary(summary: string): void
}

/**
 * Give a session that holds nothing its conversation back.
 *
 * A one-message turn is the *normal* shape for an app send now: the client
 * posts only the message being sent and every typed-turn API route attaches the
 * durable seed (SHO-402). So this is how a cold, evicted or restarted runtime
 * gets its context.
 *
 * A session that already holds messages is never re-seeded. The runtime's own
 * copy is the truth — seeding over it would replay every turn a second time —
 * which is also why the client can stop sending the transcript at all.
 */
export function seedEmptySessionFromHistory(
  seed: HistorySeed | null,
  session: HistorySeedSession,
): { restored: number; summary: boolean } {
  if (!seed || session.messageCount() > 0) return { restored: 0, summary: false }
  const restored = session.appendSeed(seed.messages)
  if (seed.summary) {
    // The durable summary must win over a runtime copy that covers less. The
    // runtime has no watermark of its own (its counts are not the API's
    // `ChatMessage` counts), so the comparable signal is coverage: a longer
    // durable block folds more of the conversation. Every runtime compaction is
    // also written back to the API, so it is never the older copy for long
    // (SHO-137 round 3, R4).
    const runtimeSummary = session.currentSummary()
    if (!runtimeSummary || seed.summary.trim().length > runtimeSummary.trim().length) {
      session.setSummary(seed.summary)
    }
  }
  return { restored, summary: Boolean(seed.summary) }
}
