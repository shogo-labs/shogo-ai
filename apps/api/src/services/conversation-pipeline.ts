// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Side effects that follow a posted channel message, shared by every entry
 * point (app, agent tools, bridges, bots) so behavior can't drift between them.
 */

import { dispatchAgentsForMessage } from './conversation-agent-dispatcher'
import type { PostMessageResult } from './conversation.service'

export type MessageOrigin = 'app' | 'agent' | 'slack' | 'bot' | 'system' | 'import'

export interface AfterPostContext {
  actorUserId: string | null
  origin: MessageOrigin
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
  if (ctx.actorUserId && (ctx.origin === 'app' || ctx.origin === 'slack')) {
    await dispatchAgentsForMessage(result, ctx.actorUserId).catch((err) => {
      console.error('[Channels] agent dispatch failed:', err)
    })
  }
  for (const hook of hooks) {
    try {
      await hook(result, ctx)
    } catch (err) {
      console.error('[Channels] post hook failed:', err)
    }
  }
}
