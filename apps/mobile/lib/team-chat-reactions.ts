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

/** Past this many reactors, the hover card collapses the tail into "and N others". */
export const DETAIL_NAMED_MAX = 12

/** Shortcodes for the emoji people react with most, so the hover card reads like Slack's. */
const SHORTCODES: Record<string, string> = {
  '👍': ':+1:',
  '👎': ':-1:',
  '✅': ':white_check_mark:',
  '👀': ':eyes:',
  '🎉': ':tada:',
  '❤️': ':heart:',
  '❤': ':heart:',
  '😂': ':joy:',
  '🙏': ':pray:',
  '🔥': ':fire:',
  '🚀': ':rocket:',
  '😮': ':open_mouth:',
  '😢': ':cry:',
}

/** `:heart:` for a known unicode emoji; custom `:name:` codes and anything else pass through. */
export function emojiShortcode(emoji: string): string {
  return SHORTCODES[emoji] ?? emoji
}

export interface ReactionDetail {
  /** The reactors, e.g. "Ana, Bob, You and 9 others". */
  who: string
  /** What they did, e.g. "reacted with :heart:". */
  verb: string
}

/**
 * Hover-card text for one reaction. Others come first and "You" last, as in
 * Slack; the viewer is always named, and the tail collapses past `DETAIL_NAMED_MAX`.
 */
export function reactionDetail(
  emoji: string,
  userIds: string[],
  me: string | null,
  names: ReactorNames,
): ReactionDetail {
  const viewerReacted = !!me && userIds.includes(me)
  const others = userIds.filter((id) => id !== me).map((id) => reactorName(id, me, names))
  const slots = viewerReacted ? DETAIL_NAMED_MAX - 1 : DETAIL_NAMED_MAX
  const shown = others.length + (viewerReacted ? 1 : 0) <= DETAIL_NAMED_MAX ? others : others.slice(0, slots - 1)
  const named = viewerReacted ? [...shown, 'You'] : shown
  const rest = userIds.length - named.length
  const who = rest > 0 ? `${named.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}` : joinNames(named)
  return { who, verb: `reacted with ${emojiShortcode(emoji)}` }
}
