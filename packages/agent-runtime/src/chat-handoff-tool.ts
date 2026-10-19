// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `chat_handoff` — hand a message to another chat and start its turn, the same
 * thing a `<@c:CHAT_ID>` tag in a user message does (SHO-52).
 *
 * The receiving chat's agent runs against its own runtime, so the target may
 * live in another workspace; the API resolves the target as the acting person
 * and refuses chats they cannot open. No reply is posted back here — the
 * person's chip in the source chat shows queued / working / replied.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { textResult, type ToolContext } from './gateway-tools'
import { deliverAgentChatHandoff } from './internal-api'
import { resolveRuntimeIdentity } from './workspace-runtime-mode'

export function createChatHandoffTool(ctx: ToolContext): AgentTool {
  return {
    name: 'chat_handoff',
    label: 'Chat handoff',
    description:
      'Send a message into another chat and start that chat\'s agent turn. Use it to hand work to a chat instead of describing it. `chat` is a chat id or its exact title; only chats the person you are acting for can open are allowed. The message arrives there with a one-line origin (who sent it, from which chat) and nothing is posted back here.',
    parameters: Type.Object({
      chat: Type.String({ description: 'Target chat: its id, or its exact title.' }),
      message: Type.String({ description: 'What to send. Write it as the person would: the receiving agent acts on it.' }),
    }) as any,
    execute: async (_id, params) => {
      const input = (params ?? {}) as { chat?: string; message?: string }
      const workspaceId = resolveRuntimeIdentity().workspaceId || ctx.workspaceId
      if (!workspaceId) {
        return textResult({ error: 'This runtime has no workspace context, so chat handoff is unavailable.', code: 'no_workspace' })
      }
      if (!input.chat?.trim() || !input.message?.trim()) {
        return textResult({ error: 'Both `chat` and `message` are required.', code: 'invalid_input' })
      }
      const result = await deliverAgentChatHandoff(workspaceId, {
        chat: input.chat.trim(),
        message: input.message,
        ...(ctx.sessionId ? { sourceChatId: ctx.sessionId } : {}),
      })
      if (!result.ok) {
        return textResult({ error: result.error ?? 'chat_handoff failed', code: result.code, status: result.status })
      }
      const delivered = result.data as { delivered?: { title?: string; started?: boolean } } | undefined
      return textResult({
        ok: true,
        chat: delivered?.delivered?.title,
        queued: delivered?.delivered?.started === false,
      })
    },
  }
}
