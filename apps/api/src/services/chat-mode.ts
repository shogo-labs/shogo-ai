// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which surface a workspace uses for team chat.
 *
 *   off      — no team chat; agents are used from project/workspace chat only.
 *   native   — Shogo channels (the in-app chat UI).
 *   external — Slack, Teams, or Google Chat is the only chat surface. Channels
 *              are mirrored into the conversation tables as a shadow copy so
 *              agents keep transcripts, search, and memory, but the Shogo chat
 *              UI is hidden.
 *   bridged  — native channels plus two-way sync with one external provider.
 */

import { prisma } from '../lib/prisma'
import { ConversationError } from './conversation.service'

const db = prisma as any

export const CHAT_MODES = ['off', 'native', 'external', 'bridged'] as const
export type ChatMode = (typeof CHAT_MODES)[number]

export const EXTERNAL_CHAT_PROVIDERS = ['slack', 'teams', 'google_chat'] as const
export type ExternalChatProvider = (typeof EXTERNAL_CHAT_PROVIDERS)[number]

export interface WorkspaceChatConfig {
  mode: ChatMode
  provider: ExternalChatProvider | null
  /** True when `mode` was not set explicitly and comes from the workspace kind. */
  isDefault: boolean
}

const CACHE_TTL_MS = 15_000
const cache = new Map<string, { value: WorkspaceChatConfig; expiresAt: number }>()

export function isChatMode(value: unknown): value is ChatMode {
  return typeof value === 'string' && (CHAT_MODES as readonly string[]).includes(value)
}

export function isExternalChatProvider(value: unknown): value is ExternalChatProvider {
  return typeof value === 'string' && (EXTERNAL_CHAT_PROVIDERS as readonly string[]).includes(value)
}

export function defaultChatMode(kind: string | null | undefined): ChatMode {
  return kind === 'personal' ? 'off' : 'native'
}

export function resolveChatConfig(row: { kind?: string | null; chatMode?: string | null; chatProvider?: string | null }): WorkspaceChatConfig {
  const explicit = isChatMode(row.chatMode) ? row.chatMode : null
  const mode = explicit ?? defaultChatMode(row.kind)
  const provider = isExternalChatProvider(row.chatProvider) ? row.chatProvider : null
  return { mode, provider: mode === 'external' || mode === 'bridged' ? provider : null, isDefault: !explicit }
}

export async function getWorkspaceChatConfig(workspaceId: string): Promise<WorkspaceChatConfig> {
  const hit = cache.get(workspaceId)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const row = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { kind: true, chatMode: true, chatProvider: true },
  })
  const value = resolveChatConfig(row ?? {})
  cache.set(workspaceId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

/** The Shogo chat UI (channels, DMs, search, realtime) is available. */
export function nativeChatEnabled(config: WorkspaceChatConfig): boolean {
  return config.mode === 'native' || config.mode === 'bridged'
}

/** Agents can read and post to team chat (natively or through a provider). */
export function agentChatEnabled(config: WorkspaceChatConfig): boolean {
  return config.mode !== 'off'
}

export async function assertNativeChat(workspaceId: string): Promise<void> {
  const config = await getWorkspaceChatConfig(workspaceId)
  if (nativeChatEnabled(config)) return
  throw new ConversationError(403, 'chat_disabled', config.mode === 'off'
    ? 'Team chat is turned off for this workspace'
    : `This workspace uses ${providerLabel(config.provider)} for team chat`)
}

export function providerLabel(provider: ExternalChatProvider | null): string {
  switch (provider) {
    case 'slack': return 'Slack'
    case 'teams': return 'Microsoft Teams'
    case 'google_chat': return 'Google Chat'
    default: return 'an external chat app'
  }
}

export async function setWorkspaceChatConfig(
  workspaceId: string,
  input: { mode: unknown; provider?: unknown },
): Promise<WorkspaceChatConfig> {
  if (!isChatMode(input.mode)) {
    throw new ConversationError(400, 'invalid_mode', `mode must be one of ${CHAT_MODES.join(', ')}`)
  }
  const needsProvider = input.mode === 'external' || input.mode === 'bridged'
  if (needsProvider && !isExternalChatProvider(input.provider)) {
    throw new ConversationError(400, 'invalid_provider', `provider must be one of ${EXTERNAL_CHAT_PROVIDERS.join(', ')}`)
  }
  const provider = needsProvider ? (input.provider as ExternalChatProvider) : null
  await db.workspace.update({ where: { id: workspaceId }, data: { chatMode: input.mode, chatProvider: provider } })
  cache.delete(workspaceId)
  return getWorkspaceChatConfig(workspaceId)
}

export function invalidateWorkspaceChatConfig(workspaceId: string): void {
  cache.delete(workspaceId)
}

export function _resetChatModeCacheForTests(): void {
  cache.clear()
}
