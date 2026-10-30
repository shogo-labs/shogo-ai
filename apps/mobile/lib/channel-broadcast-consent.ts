// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The confirmation Slack puts in front of a broadcast.
 *
 * `<!channel>` and `<!here>` reach a whole conversation at once, and nothing in
 * the composer says so: the token is inserted by picking `@channel` from the
 * `@` menu, it renders as an ordinary mention chip beside a person's name, and
 * its reach only becomes apparent once the message is already out. Slack asks
 * before sending; so do we.
 *
 * Only these two tokens broadcast. A `#channel` reference is a link, and a
 * `@group` expands to a handful of members, so neither is asked about.
 */

export type BroadcastToken = 'channel' | 'here'

/**
 * Matched exactly where the server matches it (`parseMentions` in
 * `apps/api/src/services/conversation-mentions.ts`): anywhere in the text.
 *
 * That includes a token inside backticks, which looks inert but still notifies.
 * Mirroring the server is what keeps the question honest — asking about less
 * than what the server acts on is how a confirmation becomes theatre.
 */
const TOKEN_RE = /<!(here|channel)>/g

/**
 * Kinds where a broadcast token addresses a crowd.
 *
 * In a DM `<!channel>` only reaches the two people already in the conversation,
 * so a warning would invent an audience that does not exist.
 */
const CROWD_KINDS = new Set(['public', 'private'])

/** The broadcast tokens in `text` that deserve a confirmation, in first-seen order. */
export function broadcastsNeedingConsent(text: string, kind: string | null | undefined): BroadcastToken[] {
  if (!text || !kind || !CROWD_KINDS.has(kind)) return []
  const seen = new Set<BroadcastToken>()
  for (const match of text.matchAll(TOKEN_RE)) seen.add(match[1] as BroadcastToken)
  return [...seen]
}

export interface BroadcastCopy {
  title: string
  body: string
}

/** A channel name reads better than "this channel", but is never required. */
function channelLabel(name: string | null | undefined): string {
  const trimmed = name?.trim()
  if (!trimmed) return 'this channel'
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

/**
 * What the reader is about to do, in their own terms.
 *
 * `<!channel>` wins when both are present: `<!here>` only reaches a subset of
 * the same people (those active right now), so naming the channel is the
 * stronger and still accurate warning.
 *
 * Copy describes who gets a *notification*, which is what the server delivers:
 * `<!channel>` skips members who muted the channel, and `<!here>` only reaches
 * members whose presence is active. Both are recipient choices, so the plain
 * phrasing holds — but neither is a promise of a push to every account.
 */
export function broadcastConfirmCopy(
  tokens: BroadcastToken[],
  channelName?: string | null,
): BroadcastCopy {
  if (tokens.includes('channel')) {
    const label = channelLabel(channelName)
    return {
      title: tokens.includes('here') ? 'Notify everyone?' : `Notify everyone in ${label}?`,
      body: `Everyone in ${label} will get a notification for this message.`,
    }
  }
  return {
    title: 'Notify everyone online?',
    body: 'Everyone who is online right now will get a notification for this message.',
  }
}

export interface ChannelBroadcastConsentDeps {
  /** Asks the sender. Resolves true to send. */
  ask: (copy: BroadcastCopy) => Promise<boolean>
}

const defaultDeps: ChannelBroadcastConsentDeps = {
  ask: async (copy) => {
    const { requestChannelBroadcastConfirm } = await import('../components/team-chat/ChannelBroadcastConfirm')
    return requestChannelBroadcastConfirm(copy)
  },
}

export interface BroadcastTarget {
  /** `public`, `private`, `dm` or `group_dm`. */
  kind: string | null
  name: string | null
}

/**
 * Whether the message may go out as written.
 *
 * Called before anything is cleared, so a `false` leaves the composer exactly
 * as the reader left it — the draft, the text and the caret all survive a
 * change of mind.
 */
export async function confirmsChannelBroadcast(
  wire: string,
  target: BroadcastTarget | null | undefined,
  deps: ChannelBroadcastConsentDeps = defaultDeps,
): Promise<boolean> {
  const tokens = broadcastsNeedingConsent(wire, target?.kind)
  if (!tokens.length) return true
  return deps.ask(broadcastConfirmCopy(tokens, target?.name))
}
