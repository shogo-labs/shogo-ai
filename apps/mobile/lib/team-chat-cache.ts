// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * On-device cache for team chat so the sidebar and recently opened
 * conversations render immediately on launch and while offline. The
 * network result always replaces what's cached.
 *
 * Keys are scoped by user. Only the newest messages of the most recently
 * opened conversations are kept, and everything is cleared on sign-out.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ChatMessage, ConversationSummary } from './team-chat-api'

const PREFIX = 'shogo:team-chat:v1:'
const INDEX_KEY = `${PREFIX}index`
export const CACHED_MESSAGES_PER_CONVERSATION = 50
export const MAX_CACHED_CONVERSATIONS = 30
const WRITE_DELAY_MS = 1_000

export interface CachedTimeline {
  messages: ChatMessage[]
  hasMoreOlder: boolean
  savedAt: number
}

const listKey = (userId: string, workspaceId: string) => `${PREFIX}${userId}:list:${workspaceId}`
const timelineKey = (userId: string, conversationId: string) => `${PREFIX}${userId}:tl:${conversationId}`

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

function writeLater(key: string, value: unknown): void {
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key)
    AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {})
  }, WRITE_DELAY_MS))
}

export function readCachedList(userId: string, workspaceId: string): Promise<ConversationSummary[] | null> {
  return readJson<ConversationSummary[]>(listKey(userId, workspaceId))
}

export function cacheList(userId: string, workspaceId: string, list: ConversationSummary[]): void {
  writeLater(listKey(userId, workspaceId), list)
}

export function readCachedTimeline(userId: string, conversationId: string): Promise<CachedTimeline | null> {
  return readJson<CachedTimeline>(timelineKey(userId, conversationId))
}

/** The newest confirmed messages worth keeping for a conversation. */
export function cacheableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !m.pending).slice(-CACHED_MESSAGES_PER_CONVERSATION)
}

let index: string[] | null = null
let indexChain: Promise<void> = Promise.resolve()
const touched = new Set<string>()

function touchIndex(key: string): void {
  if (touched.has(key)) return
  touched.add(key)
  indexChain = indexChain.then(async () => {
    if (!index) index = (await readJson<string[]>(INDEX_KEY)) ?? []
    index = [key, ...index.filter((k) => k !== key)]
    const evicted = index.slice(MAX_CACHED_CONVERSATIONS)
    index = index.slice(0, MAX_CACHED_CONVERSATIONS)
    for (const k of evicted) {
      clearTimeout(pendingWrites.get(k))
      pendingWrites.delete(k)
      touched.delete(k)
    }
    if (evicted.length) await AsyncStorage.multiRemove(evicted).catch(() => {})
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index)).catch(() => {})
  })
}

export function cacheTimeline(userId: string, conversationId: string, messages: ChatMessage[], hasMoreOlder: boolean): void {
  const kept = cacheableMessages(messages)
  if (!kept.length) return
  const key = timelineKey(userId, conversationId)
  writeLater(key, { messages: kept, hasMoreOlder: hasMoreOlder || kept.length < messages.filter((m) => !m.pending).length, savedAt: Date.now() })
  touchIndex(key)
}

export async function clearTeamChatCache(): Promise<void> {
  await indexChain
  pendingWrites.forEach((t) => clearTimeout(t))
  pendingWrites.clear()
  touched.clear()
  index = null
  try {
    const keys = await AsyncStorage.getAllKeys()
    await AsyncStorage.multiRemove(keys.filter((k) => k.startsWith(PREFIX)))
  } catch {
    // Best effort; keys are user-scoped anyway.
  }
}
