// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reaction chips: whether the viewer already reacted (so a click removes the
 * reaction instead of silently adding it again), and the "who reacted" label
 * shown on hover.
 */
import type { ReactionSummary } from './team-chat-api'

/** The slice of `MentionNames` needed to name reactors, kept structural so callers can pass one. */
export interface ReactorNames {
  users: Map<string, string>
}

/** Past this many reactors, the tail is collapsed into "and N others". */
const NAMED_MAX = 3

/** Did the viewer already react with this emoji? Drives both the chip's highlight and its click. */
export function hasReacted(
  reactions: ReactionSummary[] | undefined,
  emoji: string,
  me: string | null,
): boolean {
  if (!me) return false
  return !!reactions?.some((r) => r.emoji === emoji && r.userIds.includes(me))
}

/** "You" for the viewer, the member's name otherwise, and a fallback for someone who left. */
export function reactorName(userId: string, me: string | null, names: ReactorNames): string {
  if (me && userId === me) return 'You'
  return names.users.get(userId) ?? 'Someone'
}

function joinNames(people: string[]): string {
  if (people.length === 0) return 'Someone'
  if (people.length === 1) return people[0]!
  return `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`
}

/** "You reacted with 👍", "You, Ana and Bob reacted with 👍", "You, Ana and 5 others reacted with 👍". */
export function reactionTooltip(
  emoji: string,
  userIds: string[],
  me: string | null,
  names: ReactorNames,
): string {
  const people = userIds.map((id) => reactorName(id, me, names))
  const who = people.length <= NAMED_MAX
    ? joinNames(people)
    : `${people.slice(0, NAMED_MAX - 1).join(', ')} and ${people.length - (NAMED_MAX - 1)} others`
  return `${who} reacted with ${emoji}`
}
