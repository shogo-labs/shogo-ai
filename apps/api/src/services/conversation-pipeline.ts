// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Side effects that follow a posted channel message, shared by every entry
 * point (app, agent tools, bridges, bots) so behavior can't drift between them.
 */

import { dispatchAgentsForMessage, dispatchAgentsFromAgentMessage } from './conversation-agent-dispatcher'
import type { PostMessageResult } from './conversation.service'

export type MessageOrigin = 'app' | 'agent' | 'slack' | 'teams' | 'google_chat' | 'bot' | 'system' | 'import'

const HUMAN_ORIGINS = new Set<MessageOrigin>(['app', 'slack', 'teams', 'google_chat'])

export interface AfterPostContext {
  actorUserId: string | null
  origin: MessageOrigin
  /** A streamed agent reply just finished; the row was posted earlier as a placeholder. */
  settled?: boolean
}

type Hook = (result: PostMessageResult, ctx: AfterPostContext) => Promise<void> | void

const hooks: Hook[] = []

/** Register an additional post-message effect (notifications, bridges, webhooks). */
export function registerAfterPostHook(hook: Hook): () => void {
  hooks.push(hook)
  return () => {
    const i = hooks.indexOf(hook)
    if (i >= 0) hooks.splice(i, 1)
  }
}

export async function afterMessagePosted(result: PostMessageResult, ctx: AfterPostContext): Promise<void> {
  if (result.duplicate) return
  if (ctx.actorUserId && HUMAN_ORIGINS.has(ctx.origin)) {
    await dispatchAgentsForMessage(result, ctx.actorUserId).catch((err) => {
      console.error('[Channels] agent dispatch failed:', err)
    })
  } else if (ctx.origin === 'agent') {
    await dispatchAgentsFromAgentMessage(result).catch((err) => {
      console.error('[Channels] agent chain dispatch failed:', err)
    })
  }
  // Mirrored channels live on the external platform, which does its own
  // notifications and link previews.
  const provider = result.conversation?.provider
  if (provider && provider !== 'shogo') return
  for (const hook of hooks) {
    try {
      await hook(result, ctx)
    } catch (err) {
      console.error('[Channels] post hook failed:', err)
    }
  }
}
