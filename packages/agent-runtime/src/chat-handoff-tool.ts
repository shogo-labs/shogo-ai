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

/**
 * Every name a target chat is allowed to arrive under. The prompt names the
 * arguments now, but a model that was not shown the schema still guesses
 * `chat_id`; accepting the alias turns a rejection into a delivery (SHO-118).
 */
export function resolveChatHandoffInput(params: unknown): { chat: string; message: string } {
  const input = (params ?? {}) as {
    chat?: unknown
    chat_id?: unknown
    chatId?: unknown
    message?: unknown
  }
  const first = [input.chat, input.chat_id, input.chatId].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  return {
    chat: first?.trim() ?? '',
    message: typeof input.message === 'string' ? input.message : '',
  }
}

export function createChatHandoffTool(ctx: ToolContext): AgentTool {
  return {
    name: 'chat_handoff',
    label: 'Chat handoff',
    description:
      'Send a message into another chat and start that chat\'s agent turn. Use it to hand work to a chat instead of describing it. `chat` is a chat id or its exact title; only chats the person you are acting for can open are allowed. The message arrives there with a one-line origin (who sent it, from which chat) and nothing is posted back here. A `chat_not_found` answer lists the chats you *can* open: report it once and do not retry other ids.',
    parameters: Type.Object({
      chat: Type.Optional(Type.String({ description: 'Target chat: its id, or its exact title.' })),
      chat_id: Type.Optional(Type.String({ description: 'Same as `chat` (accepted alias).' })),
      message: Type.String({ description: 'What to send. Write it as the person would: the receiving agent acts on it.' }),
    }) as any,
    execute: async (_id, params) => {
      const input = resolveChatHandoffInput(params)
      const workspaceId = resolveRuntimeIdentity().workspaceId || ctx.workspaceId
      if (!workspaceId) {
        return textResult({ error: 'This runtime has no workspace context, so chat handoff is unavailable.', code: 'no_workspace' })
      }
      if (!input.chat || !input.message.trim()) {
        return textResult({
          error: 'Both `chat` and `message` are required.',
          code: 'invalid_input',
          hint: 'Call `chat_handoff({ chat: "<id from the chat list>", message: "…" })`.',
        })
      }
      const result = await deliverAgentChatHandoff(workspaceId, {
        chat: input.chat,
        message: input.message,
        ...(ctx.sessionId ? { sourceChatId: ctx.sessionId } : {}),
      })
      if (!result.ok) {
        // The API answers a refused id with the chats this person can actually
        // open, so one wrong id is one correction instead of a retry loop.
        const suggestion = (result.details as { reachable?: string[] } | undefined)?.reachable
        return textResult({
          error: result.error ?? 'chat_handoff failed',
          code: result.code,
          status: result.status,
          ...(result.code === 'chat_not_found'
            ? {
                reachable: suggestion ?? [],
                hint: 'Report this once and stop; do not retry with other ids.',
              }
            : {}),
        })
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
