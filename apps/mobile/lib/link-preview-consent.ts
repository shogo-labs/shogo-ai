// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The sender's half of shared-link previews.
 *
 * A preview of one of our own messages is rendered read-only, and only for a
 * reader the server agrees can open the conversation it came from. That makes
 * it safe — but not necessarily obvious. Sharing a link out of a *private*
 * channel into another one means the people reading it may not be able to open
 * it, and may not realise what they are being shown came from somewhere they
 * cannot see. Slack asks before doing that; so do we.
 *
 * The answer is recorded as an *opt-out* on the message — the URLs, not the
 * content. Nothing about the linked conversation is ever stored on the message
 * that carries the link, so a reader without access still gets nothing.
 */
import { teamChatApi, type LinkPreviewConversation } from './team-chat-api'
import { chatLinkHref, chatLinksInText } from './team-chat-links'

export interface LinkPreviewConsentDeps {
  /** Resolves a link's conversation as *this* sender may see it. Throws when they cannot. */
  loadConversation: (conversationId: string) => Promise<{ conversation: LinkPreviewConversation }>
  /** Asks the sender. Resolves true to attach previews. */
  ask: (names: string[]) => Promise<boolean>
}

/**
 * Whether sharing this link needs the sender's decision. Only a private
 * conversation needs asking about, and only when the link is going somewhere
 * else — quoting a private channel into itself discloses nothing new.
 */
export function needsLinkPreviewConsent(
  linked: { id: string; private: boolean },
  postingTo: string,
): boolean {
  return linked.private && linked.id !== postingTo
}

const api = teamChatApi()

const defaultDeps: LinkPreviewConsentDeps = {
  loadConversation: (conversationId: string) => api.conversationPreview(conversationId),
  ask: async (names: string[]) => {
    const { requestLinkPreviewConsent } = await import('../components/team-chat/LinkPreviewConsent')
    return requestLinkPreviewConsent(names)
  },
}

/**
 * The URLs to withhold a preview for, ready to send as `linkPreviewsOff`.
 *
 * Best-effort by design: if a link cannot be resolved (the sender cannot see
 * it either, or the network is down) nothing is asked and nothing is withheld.
 * A failure here must never stop the message from being sent.
 */
export async function resolveLinkPreviewOptOuts(
  text: string,
  postingTo: string,
  deps: LinkPreviewConsentDeps = defaultDeps,
): Promise<string[]> {
  const targets = chatLinksInText(text)
  if (!targets.length) return []

  const needsConsent: Array<{ href: string; name: string }> = []
  for (const target of targets) {
    let linked: LinkPreviewConversation
    try {
      linked = (await deps.loadConversation(target.conversationId)).conversation
    } catch {
      continue
    }
    if (!needsLinkPreviewConsent(linked, postingTo)) continue
    needsConsent.push({ href: chatLinkHref(target), name: linked.name ?? 'a private channel' })
  }
  if (!needsConsent.length) return []

  const share = await deps.ask(needsConsent.map((entry) => entry.name))
  if (share) return []
  return Array.from(new Set(needsConsent.map((entry) => entry.href)))
}
