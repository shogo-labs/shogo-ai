// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opening a chat from what the device already holds (SHO-309).
 *
 * SHO-260 made the *network* side incremental — a reopen asks only for
 * `/changes?since=` — but the screen still threw away everything it had and
 * waited for two round-trips with a loader in front of each. These are the
 * decisions that let it paint first instead:
 *
 *   - which session a workspace agent chat opens, and what its agent is called,
 *     kept per user + server (the same scoping chat history uses);
 *   - which transcript to seed the panel with on its first frame;
 *   - and, in both cases, when a loader is actually honest versus when it is
 *     just a flash of a chat that is already on the device.
 *
 * Nothing here talks to the network. The one thing worth knowing is the
 * difference between the *synchronous* mirror (what this JS session has already
 * read or written) and the device store (IndexedDB / AsyncStorage, which
 * answers a tick later): a mirror hit paints in the first frame, a store hit
 * paints as soon as the read lands — and until that read has answered, a chat
 * that might be there shows nothing rather than a loader that may be a lie.
 */
import { API_URL } from './api-url'
import {
  chatHistoryKey,
  peekChatBoot,
  peekChatHistory,
  readChatBoot,
  writeChatBoot,
  type ChatBootRecord,
} from './chat-history-store'
import { readSessionMessageCache } from './chat-panel-message-cache'

/**
 * The middle segment of every device key: the runtime a chat belongs to. A
 * paired computer's own workspace and a cloud workspace are different servers,
 * and their chats must never be read for each other.
 */
export function chatHistoryOrigin(instanceId: string | null | undefined): string {
  return String(instanceId ?? API_URL ?? 'local')
}

/**
 * The boot record's key for a workspace agent chat. `workspace-agent` keeps it
 * apart from the transcript keys that share this scope.
 */
export function workspaceChatBootKey(
  userId: string | null | undefined,
  origin: string,
  workspaceId: string | null | undefined,
): string | null {
  if (!userId || !workspaceId) return null
  return chatHistoryKey(userId, origin, `workspace-agent:${workspaceId}`)
}

/** The boot record this JS session already holds — safe to read while rendering. */
export function peekWorkspaceChatBoot<TProfile>(key: string | null): ChatBootRecord<TProfile> | null {
  return peekChatBoot<TProfile>(key)
}

/** The boot record the device holds, from the previous run of the app. */
export async function loadWorkspaceChatBoot<TProfile>(
  key: string | null,
): Promise<ChatBootRecord<TProfile> | null> {
  if (!key) return null
  return readChatBoot<TProfile>(key)
}

/**
 * Remember part of a chat's opening identity. A surface that only knows the
 * profile (the island's name, a side chat) must not wipe the session, and a
 * load that only knows the session must not wipe the profile.
 */
export function rememberWorkspaceChatBoot<TProfile>(
  key: string | null,
  patch: { sessionId?: string | null; profile?: TProfile | null },
): Promise<void> {
  return writeChatBoot<TProfile>(key, patch)
}

export interface TranscriptSeed {
  /** The transcript this device already holds for the chat, in paint order. */
  messages: any[] | null
  /** Where it came from — the memory cache is always the fresher of the two. */
  source: 'memory' | 'device' | 'none'
}

/**
 * The transcript to paint before any request goes out. The per-session memory
 * cache wins (it is the live one this JS session last painted); the durable
 * mirror is the fallback, which is what makes a reload instant.
 */
export function seedTranscript(
  sessionId: string | null,
  storeKey: string | null,
): TranscriptSeed {
  if (!sessionId) return { messages: null, source: 'none' }
  const fromMemory = readSessionMessageCache(sessionId)
  if (fromMemory && fromMemory.length > 0) {
    return { messages: fromMemory, source: 'memory' }
  }
  if (storeKey) {
    const stored = peekChatHistory('project', storeKey)
    if (stored?.messages?.length) {
      return { messages: stored.messages, source: 'device' }
    }
  }
  return { messages: fromMemory ?? null, source: 'none' }
}

/**
 * Whether the transcript may show "Loading conversation…".
 *
 * Only when there is genuinely nothing to show and nothing left to read: a
 * device read still in flight is not loading, it is a chat that is about to
 * appear, and a flash of the loader is exactly the bug (SHO-309).
 */
export function transcriptLoaderVisible(input: {
  hasSession: boolean
  isComplete: boolean
  isStreaming: boolean
  /** The device read for this chat has not answered yet. */
  hydrationPending: boolean
}): boolean {
  if (!input.hasSession) return false
  if (input.isStreaming) return false
  if (input.hydrationPending) return false
  return !input.isComplete
}

/**
 * What a workspace agent chat renders while it has no chat to show.
 *
 *  - `error`: the load failed and nothing cached can stand in for it.
 *  - `blank`: the device read has not answered yet. A chat we have opened
 *    before lives there, so a loader would be a flash that lies (SHO-309).
 *  - `spinner`: genuinely nothing on the device — the first-ever open.
 */
export function workspaceChatLoadingView(input: {
  hasWorkspace: boolean
  hasProfile: boolean
  hasSession: boolean
  bootPending: boolean
  error: string | null
}): 'chat' | 'spinner' | 'error' | 'blank' {
  // Without a workspace there is no chat to prepare, so a spinner would be
  // describing a load that is not running — and this is the frame a reopen
  // starts on, while the collection is between answers. Show nothing (SHO-309).
  if (!input.hasWorkspace) return 'blank'
  if (input.hasProfile && input.hasSession) return 'chat'
  if (input.error) return 'error'
  if (input.bootPending) return 'blank'
  return 'spinner'
}
