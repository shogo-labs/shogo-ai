// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace-agent chats list on the device (SHO-391).
 *
 * Clicking Home mounts a fresh `WorkspaceChatsPanel`, so the list used to be
 * `useState([])` + `loading = true` on every visit: a "Loading…" flash, a full
 * `GET /sessions`, and — worse — a blank list whenever that one request failed.
 * Team chat already paints from the device (`team-chat-cache.ts`); this is the
 * same deal for the workspace chats list, with two additions:
 *
 *   - a **synchronous mirror**, so a remount inside the same JS session paints
 *     on its first frame instead of waiting for a storage read;
 *   - a **single-flight fetch**, so the panel, the phone drawer, the island and
 *     the landing chat joining in the same moment cost one request, not four.
 *
 * Keys are scoped by user + origin + workspace: the same scoping chat history
 * uses, so a paired computer's workspace never reads a cloud one's list.
 * Everything is cleared on sign-out and on an env switch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HttpClient } from '@shogo-ai/sdk'
import { api } from './api'
import type { SideChatItem } from './side-chats'

const PREFIX = 'shogo:workspace-chats:v1:'
const INDEX_KEY = `${PREFIX}index`
/** Most rows one workspace keeps — a long list is still one paint. */
export const MAX_CACHED_CHATS = 200
export const MAX_CACHED_WORKSPACES = 20
const WRITE_DELAY_MS = 1_000
/**
 * A screen that asks this soon after another screen's fetch settled takes that
 * answer instead of starting a second request. One Home click mounts the panel,
 * the drawer, the island and the landing chat a few milliseconds apart; without
 * this they each fire their own `GET /sessions`. Short enough that a real
 * revalidation is never skipped for long — and a list that changed on this
 * device in the meantime is never served from it (see `generation`).
 */
export const JOIN_WINDOW_MS = 750

/**
 * One row of the list as every surface holds it: the API's answer, and the
 * optimistic row a create builds before the server confirms it (that is why
 * `workspaceId` is optional here and required there).
 */
export type WorkspaceChatRow = SideChatItem & {
  workspaceId?: string
  isPrimary?: boolean
  messageCount?: number
}

interface StoredChats {
  sessions: WorkspaceChatRow[]
  savedAt: number
}

/**
 * `${userId}:${origin}:${workspaceId}`, or null when the list cannot be scoped
 * (signed out, no workspace) — callers then fetch without caching rather than
 * share one anonymous list.
 */
export function workspaceChatsKey(
  userId: string | null | undefined,
  origin: string | null | undefined,
  workspaceId: string | null | undefined,
): string | null {
  if (!userId || !workspaceId) return null
  return `${userId}:${origin ?? 'local'}:${workspaceId}`
}

const storageKey = (key: string) => `${PREFIX}${key}`

// ─── Synchronous mirror ──────────────────────────────────────────────────────
// The list a remount paints from before anything async has answered.

const mirror = new Map<string, WorkspaceChatRow[]>()

/**
 * Bumped by every local write. A fetch answer may only be handed to a later
 * caller if nothing was written since it landed: a rename writes the cache and
 * then refreshes, and that refresh must not be told the pre-rename answer.
 */
let generation = 0

/** The list this JS session already holds for that scope, if any. */
export function peekWorkspaceChats(key: string | null): WorkspaceChatRow[] | null {
  if (!key) return null
  return mirror.get(key) ?? null
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** What the device holds from an earlier run of the app, or null. */
export async function readWorkspaceChats(
  key: string | null,
): Promise<WorkspaceChatRow[] | null> {
  if (!key) return null
  const mirrored = mirror.get(key)
  if (mirrored) return mirrored
  const stored = await readJson<StoredChats>(storageKey(key))
  if (!stored?.sessions?.length) return null
  mirror.set(key, stored.sessions)
  return stored.sessions
}

// ─── Device writes ───────────────────────────────────────────────────────────

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

function writeLater(key: string, value: unknown): void {
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key)
      AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {})
    }, WRITE_DELAY_MS),
  )
}

let index: string[] | null = null
let indexChain: Promise<void> = Promise.resolve()
const touched = new Set<string>()

/** Newest-used first, and only the last `MAX_CACHED_WORKSPACES`. */
function touchIndex(key: string): void {
  if (touched.has(key)) return
  touched.add(key)
  indexChain = indexChain.then(async () => {
    if (!index) index = (await readJson<string[]>(INDEX_KEY)) ?? []
    index = [key, ...index.filter((k) => k !== key)]
    const evicted = index.slice(MAX_CACHED_WORKSPACES)
    index = index.slice(0, MAX_CACHED_WORKSPACES)
    for (const k of evicted) {
      clearTimeout(pendingWrites.get(storageKey(k)))
      pendingWrites.delete(storageKey(k))
      touched.delete(k)
      // An evicted workspace must stop answering from the mirror too, or a
      // remount would paint rows the device no longer has.
      mirror.delete(k)
    }
    if (evicted.length) {
      await AsyncStorage.multiRemove(evicted.map(storageKey)).catch(() => {})
    }
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index)).catch(() => {})
  })
}

/**
 * Keep this list for the next mount. An empty list is ignored unless the caller
 * says the list it is holding is authoritative — a real server answer that
 * happened to be empty, after a chat was deleted. Without that, a first load
 * that failed would wipe a list the user was just looking at.
 */
export function writeWorkspaceChats(
  key: string | null,
  sessions: WorkspaceChatRow[],
  opts: { allowEmpty?: boolean } = {},
): void {
  if (!key) return
  if (!sessions.length && !opts.allowEmpty) return
  const kept = sessions.slice(0, MAX_CACHED_CHATS)
  generation += 1
  mirror.set(key, kept)
  writeLater(storageKey(key), { sessions: kept, savedAt: Date.now() } satisfies StoredChats)
  touchIndex(key)
}

// ─── Single-flight fetch ─────────────────────────────────────────────────────

interface Shared {
  promise: Promise<WorkspaceChatRow[]>
  at: number
  generation: number
}

const inFlight = new Map<string, Shared>()
const recent = new Map<string, Shared>()

/**
 * The one `GET /sessions` per workspace per moment. Callers that overlap join
 * the request already running; a caller arriving just after one settled takes
 * that answer instead of asking again. The result always comes from the
 * network (never from the cache) and is written to the device, so the next
 * mount paints it.
 */
export function fetchWorkspaceChats(
  http: HttpClient,
  workspaceId: string,
  key: string | null,
  opts: { force?: boolean } = {},
): Promise<WorkspaceChatRow[]> {
  const scope = key ?? `live:${workspaceId}`
  const running = inFlight.get(scope)
  if (running) return running.promise
  if (!opts.force) {
    const joined = recent.get(scope)
    if (
      joined &&
      joined.generation === generation &&
      Date.now() - joined.at < JOIN_WINDOW_MS
    ) {
      return joined.promise
    }
  }
  const promise = api.listWorkspaceSessions(http, workspaceId).then((sessions) => {
    // A network answer is authoritative, even when it is empty: a workspace
    // whose last chat was deleted must not keep painting a ghost row.
    if (key) writeWorkspaceChats(key, sessions, { allowEmpty: true })
    recent.set(scope, { promise: Promise.resolve(sessions), at: Date.now(), generation })
    return sessions
  })
  inFlight.set(scope, { promise, at: Date.now(), generation })
  const settle = () => {
    if (inFlight.get(scope)?.promise === promise) inFlight.delete(scope)
  }
  promise.then(settle, settle)
  return promise
}

// ─── Sign-out / env switch ───────────────────────────────────────────────────

export async function clearWorkspaceChatsCache(): Promise<void> {
  await indexChain.catch(() => {})
  pendingWrites.forEach((timer) => clearTimeout(timer))
  pendingWrites.clear()
  touched.clear()
  index = null
  mirror.clear()
  inFlight.clear()
  recent.clear()
  try {
    const keys = await AsyncStorage.getAllKeys()
    await AsyncStorage.multiRemove(keys.filter((k) => k.startsWith(PREFIX)))
  } catch {
    // Best effort; keys are user-scoped anyway.
  }
}

/** Test seam: drop the in-process state without touching the device store. */
export function resetWorkspaceChatsCacheState(): void {
  pendingWrites.forEach((timer) => clearTimeout(timer))
  pendingWrites.clear()
  touched.clear()
  index = null
  mirror.clear()
  inFlight.clear()
  recent.clear()
}
