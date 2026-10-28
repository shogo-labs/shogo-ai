// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Who is "typing" in a channel or thread: people who are typing right now, and
 * nothing else. A running agent is not typing — it gets a row in the
 * running-agents dock above the composer (`runningAgentReplies`), so the line
 * under the list and the dock never report the same run twice.
 */
import type { ChatMessage } from './team-chat-api'

/** A person shown in the typing indicator. `id` is the identity used for deduplication. */
export interface Typist {
  id: string
  name: string
}

/**
 * The agent replies still running in a timeline, oldest first — one entry per
 * reply, so two parallel runs of the same agent are two rows. The dock above
 * the composer renders these: they stay reachable there after later messages
 * have pushed their own row up the thread.
 */
export function runningAgentReplies(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.authorType === 'agent' && m.agentStatus === 'running')
}

/** Drops repeat identities, keeping the first-seen order. */
function uniqueTypists(typists: Typist[]): Typist[] {
  const seen = new Set<string>()
  return typists.filter((t) => {
    if (seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })
}

/**
 * The sentence without its ellipsis — "Ana is typing", "Ana and Billing Bot are
 * typing" — for a view that draws the three dots itself and animates them.
 * Keep the dots out of the string so they can move without re-rendering text.
 */
export function typingLabelText(typists: Typist[]): string | null {
  const names = uniqueTypists(typists).map((t) => t.name)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'} are typing`
}

/**
 * "Ana is typing…", "Ana and Billing Bot are typing…", then past two names
 * the rest are counted: "Ana, Billing Bot and 1 other are typing…".
 */
export function typingLabel(typists: Typist[]): string | null {
  const text = typingLabelText(typists)
  return text === null ? null : `${text}…`
}
