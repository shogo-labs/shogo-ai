// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project list on the device (SHO-580).
 *
 * "All projects" rendered from `projectCollection.all`, which is empty until
 * `GET /api/projects` answers: on a slow network the screen sat on an empty list
 * (or a spinner, on the surfaces that show one) for the length of a round trip,
 * even though the app had drawn the same rows a minute earlier. Team chat
 * (`team-chat-cache.ts`) and the workspace chats list
 * (`workspace-chats-cache.ts`, SHO-391) already paint from the device first;
 * this is the same pattern for the project list.
 *
 * Rows are the plain snapshots the MST collections expose, so they serialize as
 * they are and the page can render them with the same `ProjectCard`. The
 * network answer always wins: the page swaps to it as soon as it arrives, and
 * only a network answer is ever written back.
 *
 * Keys are `user + origin + workspace`, like the other caches, and everything is
 * cleared on sign-out and on an environment switch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { setStorageJson } from './storage'
import { authStoragePrefixFor, getActiveEnvKey } from './env-override'

const PREFIX = 'shogo:projects:v2:'
const WRITE_DELAY_MS = 1_000
/** A very large workspace still fits; the page renders the whole list anyway. */
export const MAX_CACHED_PROJECTS = 500
export const MAX_CACHED_FOLDERS = 200

export interface CachedProjectLists<TProject = unknown, TFolder = unknown> {
  projects: TProject[]
  folders: TFolder[]
  savedAt: number
}

/**
 * `${userId}:${origin}:${workspaceId}`, or null when the list cannot be scoped
 * (signed out, no workspace, or a paired machine's own workspace) — callers then
 * fetch without caching rather than keep one anonymous list.
 */
export function projectsCacheKey(
  userId: string | null | undefined,
  origin: string | null | undefined,
  workspaceId: string | null | undefined,
): string | null {
  if (!userId || !workspaceId) return null
  return `${userId}:${origin ?? 'local'}:${workspaceId}`
}

/** Prefix and environment, so a dev-override build never reads prod's rows. */
const storageKey = (key: string) => `${PREFIX}${authStoragePrefixFor(getActiveEnvKey())}:${key}`

// ─── Synchronous mirror ──────────────────────────────────────────────────────
// What a mount inside the same JS session paints from before any storage read.

const mirror = new Map<string, CachedProjectLists>()

export function peekCachedProjects<TProject, TFolder>(
  key: string | null,
): CachedProjectLists<TProject, TFolder> | null {
  if (!key) return null
  return (mirror.get(key) as CachedProjectLists<TProject, TFolder> | undefined) ?? null
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
export async function readCachedProjects<TProject, TFolder>(
  key: string | null,
): Promise<CachedProjectLists<TProject, TFolder> | null> {
  if (!key) return null
  const mirrored = mirror.get(key)
  if (mirrored) return mirrored as CachedProjectLists<TProject, TFolder>
  const stored = await readJson<CachedProjectLists<TProject, TFolder>>(storageKey(key))
  if (!stored?.projects?.length) return null
  mirror.set(key, stored as CachedProjectLists)
  return stored
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Keep the answer for the next mount. Only a network answer is written, so an
 * empty list (a first load that failed, or a workspace with no projects) cannot
 * erase what the person was just looking at unless the caller says the empty
 * list is authoritative.
 */
export function writeCachedProjects<TProject, TFolder>(
  key: string | null,
  lists: { projects: TProject[]; folders: TFolder[] },
  opts: { allowEmpty?: boolean } = {},
): void {
  if (!key) return
  if (!lists.projects.length && !opts.allowEmpty) return
  const value: CachedProjectLists = {
    projects: lists.projects.slice(0, MAX_CACHED_PROJECTS),
    folders: lists.folders.slice(0, MAX_CACHED_FOLDERS),
    savedAt: Date.now(),
  }
  mirror.set(key, value)
  const existing = pendingWrites.get(key)
  if (existing) clearTimeout(existing)
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key)
      setStorageJson(storageKey(key), value).catch(() => {})
    }, WRITE_DELAY_MS),
  )
}

export async function clearProjectsCache(): Promise<void> {
  pendingWrites.forEach((timer) => clearTimeout(timer))
  pendingWrites.clear()
  mirror.clear()
  try {
    const keys = await AsyncStorage.getAllKeys()
    await AsyncStorage.multiRemove(keys.filter((k) => k.startsWith(PREFIX)))
  } catch {
    // Best effort; keys are user-scoped anyway.
  }
}

/** Test seam: drop the in-process state without touching the device store. */
export function resetProjectsCacheState(): void {
  pendingWrites.forEach((timer) => clearTimeout(timer))
  pendingWrites.clear()
  mirror.clear()
}
