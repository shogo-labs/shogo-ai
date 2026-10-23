// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat tags in composer text (SHO-52).
 *
 * The composer shows a chat tag as `@Chat title` so it reads like the chat it
 * names; the wire form is `<@c:CHAT_ID>`, which is what the API delivers on.
 * These helpers are the only place that swap between the two, so the label a
 * user sees and the id the server routes on cannot drift apart.
 */

/** Max characters of a chat title used as the composer pill's label. */
export const CHAT_MENTION_LABEL_MAX = 60

/**
 * A chat title as a composer label: one line, no token brackets, capped. Two
 * chats with the same title still resolve through their own reference label,
 * so a duplicate label is a display ambiguity, never a misroute.
 */
export function sanitizeChatMentionLabel(title: string): string {
  const clean = title
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean || 'chat').slice(0, CHAT_MENTION_LABEL_MAX).trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Swap each selected chat's display label for its wire token so the sent
 * message, the persisted transcript and the agent's prompt all carry an
 * address instead of a decorative name. Only whole-label occurrences are
 * replaced: a label the user edited away sends no token.
 */
export function encodeChatMentionTokens(
  text: string,
  references: { type: string; id?: string; label?: string }[] | undefined,
): string {
  if (!text || !references?.length) return text
  let out = text
  for (const ref of references) {
    if (ref.type !== 'chat' || !ref.id || !ref.label) continue
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(ref.label)}(?=$|\\s|[,.;!?])`, 'g')
    out = out.replace(pattern, `$1<@c:${ref.id}>`)
  }
  return out
}

const CHAT_TOKEN_RE = /<@c:([A-Za-z0-9_-]+)>/g

/** Chat ids addressed by `text`, in first-seen order, deduped. */
export function chatIdsIn(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(CHAT_TOKEN_RE)) {
    if (!ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}
