// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Who is "typing" in a channel or thread: people who are typing right now,
 * plus agents whose reply is still running. Both render through one label.
 */
import type { ChatMessage } from './team-chat-api'

/** A person or agent shown in the typing indicator. `id` is the identity used for deduplication. */
export interface Typist {
  id: string
  name: string
}

/**
 * The running agents in a timeline, one entry per agent. Two running replies
 * from the same agent produce the same id, so they are listed once.
 */
export function runningAgentTypists(messages: ChatMessage[]): Typist[] {
  return messages
    .filter((m) => m.authorType === 'agent' && m.agentStatus === 'running')
    .map((m) => ({
      id: `agent:${m.authorAgent?.projectId ?? m.id}`,
      name: m.authorAgent?.name ?? 'Agent',
    }))
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
 * "Ana is typing…", "Ana and Billing Bot are typing…", then past two names
 * the rest are counted: "Ana, Billing Bot and 1 other are typing…".
 */
export function typingLabel(typists: Typist[]): string | null {
  const names = uniqueTypists(typists).map((t) => t.name)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'} are typing…`
}
