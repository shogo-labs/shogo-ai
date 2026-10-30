// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat history on the device (SHO-260).
 *
 * Opening a chat used to mean downloading its newest page again — 50 rows with
 * their `parts` (tool inputs/outputs, often hundreds of KB) — every single
 * time, on every surface, even when nothing had changed. The Gmail model is
 * what this store exists for: paint the transcript from the device straight
 * away (survives a reload, a new window, a desktop restart) and ask the API
 * only for what changed since the cursor we saved.
 *
 * One code path for browser and desktop (IndexedDB), one for native
 * (AsyncStorage, tighter caps). Entries are keyed by user **and** origin, so a
 * machine workspace's chat never mixes with a cloud one.
 *
 * The store is deliberately dumb: it holds a transcript slice plus the cursor
 * that produced it. Deciding whether a delta may paint over a live reply is
 * `resolveHistoryPaint`'s job, not this module's.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export type ChatHistoryKind = 'project' | 'team'

/** What one chat's saved slice looks like. */
export interface ChatHistoryEntry<T = any> {
  messages: T[]
  /** Newest `updatedAt` this entry knows about, ISO. Null until a first page lands. */
  cursor: string | null
  /** Every row in the chat's scope at the cursor, so a delete is detectable. */
  total: number | null
  hasMoreOlder: boolean
  savedAt: number
}

export interface ChatHistoryLimits {
  /** How many chats keep a slice on this surface. LRU across both kinds. */
  chats: number
  /** How many messages one slice keeps. */
  messages: number
}

const WEB_LIMITS: ChatHistoryLimits = { chats: 100, messages: 300 }
const NATIVE_LIMITS: ChatHistoryLimits = { chats: 20, messages: 50 }
/** Rough ceiling for the whole web store before the oldest chats are dropped. */
const WEB_BUDGET_BYTES = 100 * 1024 * 1024
const SKEW_MS = 5_000

/**
 * Browser and the Electron renderer both have IndexedDB; native does not.
 * Deliberately not `Platform.OS`, so this module can be imported (and tested)
 * without pulling React Native in.
 */
export function isWebChatHistorySurface(): boolean {
  return typeof indexedDB !== 'undefined' && typeof window !== 'undefined'
}

export function chatHistoryLimits(): ChatHistoryLimits {
  return isWebChatHistorySurface() ? WEB_LIMITS : NATIVE_LIMITS
}

/**
 * `${userId}:${origin}:${chatKey}`. The origin segment is what keeps a machine
 * workspace's chats apart from the same user's cloud chats — the same split
 * `domainHttp`/the remote interceptor makes when it rewrites a path.
 */
export function chatHistoryKey(
  userId: string,
  origin: string,
  chatKey: string,
): string {
  return `${userId}:${origin}:${chatKey}`
}

/** The `chatKey` half of the key for a project chat. */
export function chatSessionHistoryKey(sessionId: string): string {
  return sessionId
}

/** The `chatKey` half of the key for a team channel, or one of its threads. */
export function conversationHistoryKey(
  conversationId: string,
  threadRootId?: string | null,
): string {
  return threadRootId ? `${conversationId}:${threadRootId}` : conversationId
}

/**
 * The cursor to send so no change is missed to clock skew between pods. Rows
 * the client already has are harmless — the merge is by id.
 */
export function deltaSince(cursor: string | null): string | null {
  if (!cursor) return null
  const at = new Date(cursor).getTime()
  if (Number.isNaN(at)) return null
  return new Date(at - SKEW_MS).toISOString()
}

/**
 * The newest `updatedAt` among a page of rows — the cursor a freshly downloaded
 * page implies when the server did not hand one back (SHO-260). Without it a
 * cold open stores `cursor: null` and the next open re-downloads the page.
 */
export function newestUpdatedAt(
  messages: Array<{ updatedAt?: string | null; createdAt?: string | null }> | undefined,
): string | null {
  let newest = 0
  for (const message of messages ?? []) {
    const raw = message?.updatedAt ?? message?.createdAt
    if (!raw) continue
    const at = new Date(raw).getTime()
    if (!Number.isNaN(at) && at > newest) newest = at
  }
  return newest ? new Date(newest).toISOString() : null
}

// ─── Backends ────────────────────────────────────────────────────────────────

export interface ChatHistoryBackend {
  read(kind: ChatHistoryKind, key: string): Promise<ChatHistoryEntry | null>
  write(kind: ChatHistoryKind, key: string, entry: ChatHistoryEntry): Promise<void>
  remove(kind: ChatHistoryKind, key: string): Promise<void>
  /** Every stored key of this kind, oldest saved first. */
  entries(kind: ChatHistoryKind): Promise<Array<{ key: string; savedAt: number; bytes: number }>>
  clear(): Promise<void>
}

const DB_NAME = 'shogo-chat-history'
const DB_VERSION = 1
const KIND_NAMES: Record<ChatHistoryKind, string> = {
  project: 'project',
  team: 'team',
}

function sizeOf(entry: ChatHistoryEntry): number {
  return JSON.stringify(entry).length
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of Object.values(KIND_NAMES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'key' })
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

const idbBackend: ChatHistoryBackend = {
  async read(kind, key) {
    const db = await openDb()
    if (!db) return null
    try {
      const tx = db.transaction(KIND_NAMES[kind], 'readonly')
      const row = await requestToPromise(
        tx.objectStore(KIND_NAMES[kind]).get(key) as IDBRequest<any>,
      )
      return (row?.entry as ChatHistoryEntry) ?? null
    } catch {
      return null
    }
  },

  async write(kind, key, entry) {
    const db = await openDb()
    if (!db) throw new Error('indexeddb-unavailable')
    const put = async () => {
      const tx = db.transaction(KIND_NAMES[kind], 'readwrite')
      tx.objectStore(KIND_NAMES[kind]).put({ key, entry })
      await transactionDone(tx)
    }
    try {
      await put()
    } catch (err) {
      if (!isQuotaError(err)) throw err
      // Out of room: drop the oldest chats and try once more. Losing an old
      // chat just costs one download later, which is the deal this store
      // offers anyway.
      await evictOldest(db, kind, Math.max(1, Math.ceil(chatHistoryLimits().chats / 4)))
      await put()
    }
  },

  async remove(kind, key) {
    const db = await openDb()
    if (!db) return
    try {
      const tx = db.transaction(KIND_NAMES[kind], 'readwrite')
      tx.objectStore(KIND_NAMES[kind]).delete(key)
      await transactionDone(tx)
    } catch {
      // Best effort.
    }
  },

  async entries(kind) {
    const db = await openDb()
    if (!db) return []
    try {
      const tx = db.transaction(KIND_NAMES[kind], 'readonly')
      const rows = (await requestToPromise(
        tx.objectStore(KIND_NAMES[kind]).getAll() as IDBRequest<any[]>,
      )) ?? []
      return rows.map((row) => ({
        key: row.key as string,
        savedAt: Number(row.entry?.savedAt ?? 0),
        bytes: sizeOf(row.entry),
      }))
    } catch {
      return []
    }
  },

  async clear() {
    const db = await openDb()
    if (!db) return
    for (const name of Object.values(KIND_NAMES)) {
      try {
        const tx = db.transaction(name, 'readwrite')
        tx.objectStore(name).clear()
        await transactionDone(tx)
      } catch {
        // Best effort.
      }
    }
  },
}

async function evictOldest(db: IDBDatabase, kind: ChatHistoryKind, count: number) {
  const tx = db.transaction(KIND_NAMES[kind], 'readonly')
  const rows = (await requestToPromise(
    tx.objectStore(KIND_NAMES[kind]).getAll() as IDBRequest<any[]>,
  )) ?? []
  const doomed = rows
    .sort((a, b) => Number(a.entry?.savedAt ?? 0) - Number(b.entry?.savedAt ?? 0))
    .slice(0, count)
  const del = db.transaction(KIND_NAMES[kind], 'readwrite')
  for (const row of doomed) del.objectStore(KIND_NAMES[kind]).delete(row.key)
  await transactionDone(del)
}

function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

const ASYNC_PREFIX = 'shogo:chat-history:v1:'
const ASYNC_INDEX = `${ASYNC_PREFIX}index`

const asyncIndex = (kind: ChatHistoryKind) => `${ASYNC_INDEX}:${kind}`
const asyncKey = (kind: ChatHistoryKind, key: string) => `${ASYNC_PREFIX}${kind}:${key}`

async function readIndex(kind: ChatHistoryKind): Promise<Array<{ key: string; savedAt: number }>> {
  try {
    const raw = await AsyncStorage.getItem(asyncIndex(kind))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const asyncStorageBackend: ChatHistoryBackend = {
  async read(kind, key) {
    try {
      const raw = await AsyncStorage.getItem(asyncKey(kind, key))
      return raw ? (JSON.parse(raw) as ChatHistoryEntry) : null
    } catch {
      return null
    }
  },

  async write(kind, key, entry) {
    try {
      await AsyncStorage.setItem(asyncKey(kind, key), JSON.stringify(entry))
    } catch {
      return
    }
    const index = [{ key, savedAt: entry.savedAt }, ...(await readIndex(kind)).filter((e) => e.key !== key)]
    const evicted = index.slice(chatHistoryLimits().chats)
    try {
      await AsyncStorage.setItem(asyncIndex(kind), JSON.stringify(index.slice(0, chatHistoryLimits().chats)))
      if (evicted.length) {
        await AsyncStorage.multiRemove(evicted.map((e) => asyncKey(kind, e.key)))
      }
    } catch {
      // Best effort.
    }
  },

  async remove(kind, key) {
    try {
      await AsyncStorage.removeItem(asyncKey(kind, key))
      const index = (await readIndex(kind)).filter((e) => e.key !== key)
      await AsyncStorage.setItem(asyncIndex(kind), JSON.stringify(index))
    } catch {
      // Best effort.
    }
  },

  async entries(kind) {
    const index = await readIndex(kind)
    return index.map((e) => ({ key: e.key, savedAt: e.savedAt, bytes: 0 }))
  },

  async clear() {
    try {
      const keys = await AsyncStorage.getAllKeys()
      await AsyncStorage.multiRemove(keys.filter((k) => k.startsWith(ASYNC_PREFIX)))
    } catch {
      // Best effort; keys are user-scoped anyway.
    }
  },
}

const memoryBackend: ChatHistoryBackend = (() => {
  const rows = new Map<string, ChatHistoryEntry>()
  const id = (kind: ChatHistoryKind, key: string) => `${kind}:${key}`
  return {
    async read(kind, key) {
      return rows.get(id(kind, key)) ?? null
    },
    async write(kind, key, entry) {
      rows.set(id(kind, key), entry)
    },
    async remove(kind, key) {
      rows.delete(id(kind, key))
    },
    async entries(kind) {
      return Array.from(rows.entries())
        .filter(([k]) => k.startsWith(`${kind}:`))
        .map(([k, entry]) => ({ key: k.slice(kind.length + 1), savedAt: entry.savedAt, bytes: sizeOf(entry) }))
    },
    async clear() {
      rows.clear()
    },
  }
})()

let backend: ChatHistoryBackend | null = null

/**
 * IndexedDB whenever the platform has it (browser and the Electron renderer),
 * AsyncStorage on native. The memory backend is what a test injects; it is
 * also the honest fallback if a browser has IndexedDB disabled.
 */
export function getChatHistoryBackend(): ChatHistoryBackend {
  if (backend) return backend
  backend = isWebChatHistorySurface() ? idbBackend : asyncStorageBackend
  return backend
}

/** Test seam: swap the backend, or pass null to reset to the platform default. */
export function setChatHistoryBackend(next: ChatHistoryBackend | null): void {
  backend = next
  memoryMirror.clear()
}

// ─── Synchronous mirror ──────────────────────────────────────────────────────
//
// Reads are async, but the paint has to start the moment the session switches.
// Every read/write goes through this map so a second visit in the same
// JS session is a synchronous hit (the same lifetime the in-memory
// `sessionMessageCache` has today).

const memoryMirror = new Map<string, ChatHistoryEntry>()
const mirrorId = (kind: ChatHistoryKind, key: string) => `${kind}:${key}`

/** The entry already read or written this JS session, if any. */
export function peekChatHistory(kind: ChatHistoryKind, key: string): ChatHistoryEntry | null {
  return memoryMirror.get(mirrorId(kind, key)) ?? null
}

export async function readChatHistory(
  kind: ChatHistoryKind,
  key: string,
): Promise<ChatHistoryEntry | null> {
  const cached = memoryMirror.get(mirrorId(kind, key))
  if (cached) return cached
  const entry = await getChatHistoryBackend().read(kind, key)
  if (entry) memoryMirror.set(mirrorId(kind, key), entry)
  return entry
}

/** Keep only the newest `limit` messages. */
function trim(messages: any[], limit: number): any[] {
  if (messages.length <= limit) return messages
  return messages.slice(messages.length - limit)
}

export async function writeChatHistory(
  kind: ChatHistoryKind,
  key: string,
  entry: ChatHistoryEntry,
): Promise<void> {
  if (!entry.messages.length) return
  const limits = chatHistoryLimits()
  const trimmed: ChatHistoryEntry = {
    ...entry,
    messages: trim(entry.messages, limits.messages),
    hasMoreOlder:
      entry.hasMoreOlder || entry.messages.length > limits.messages,
    savedAt: Date.now(),
  }
  memoryMirror.set(mirrorId(kind, key), trimmed)
  const target = getChatHistoryBackend()
  try {
    await target.write(kind, key, trimmed)
  } catch {
    // A cache write never fails the caller.
    return
  }
  // The mirror is what a revisit paints from, so the cap has to hold there
  // too: an entry the backend dropped must stop answering `readChatHistory`.
  // LRU across both kinds, plus a byte budget so one giant transcript cannot
  // fill the browser's origin quota.
  const rows = Array.from(memoryMirror.entries()).map(([id, stored]) => ({
    id,
    savedAt: stored.savedAt,
    bytes: sizeOf(stored),
  }))
  let bytes = rows.reduce((n, row) => n + row.bytes, 0)
  let count = rows.length
  for (const stale of [...rows].sort((a, b) => a.savedAt - b.savedAt)) {
    if (count <= limits.chats && bytes <= WEB_BUDGET_BYTES) break
    const sep = stale.id.indexOf(':')
    memoryMirror.delete(stale.id)
    await target
      .remove(stale.id.slice(0, sep) as ChatHistoryKind, stale.id.slice(sep + 1))
      .catch(() => {})
    bytes -= stale.bytes
    count -= 1
  }
}

export async function removeChatHistory(
  kind: ChatHistoryKind,
  key: string,
): Promise<void> {
  memoryMirror.delete(mirrorId(kind, key))
  await getChatHistoryBackend().remove(kind, key).catch(() => {})
}

/** Sign-out and env switches: nothing from the old identity survives. */
export async function clearChatHistory(): Promise<void> {
  memoryMirror.clear()
  await getChatHistoryBackend().clear().catch(() => {})
}
