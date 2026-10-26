// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo:active-workspace-id'
const KIND_STORAGE_KEY = 'shogo:active-workspace-kind'
const SWITCH_INTENT_STORAGE_KEY = 'shogo:active-workspace-switch'
const NATIVE_STORAGE_KEYS: Record<string, string> = {
  [STORAGE_KEY]: 'shogo_active_workspace_id',
  [KIND_STORAGE_KEY]: 'shogo_active_workspace_kind',
  [SWITCH_INTENT_STORAGE_KEY]: 'shogo_active_workspace_switch',
}

export type CachedWorkspaceKind = 'personal' | 'team'

/**
 * How long a person's own switch outranks an automatic writer.
 *
 * A switch is applied in place and then reloads the page (~½s on web), and
 * every other tab sees the new id through `storage` at the same moment. In
 * that window a still-mounted screen can resolve a stale workspace — the chat
 * it has open, a projects list that has not caught up, a cross-tab echo — and
 * write the workspace the person just left back. That write is the whole bug
 * SHO-157: staging landed in the old workspace every time, ~10 ms after the
 * switch and before the reload. Long enough to cover the reload plus the
 * first renders after it; short enough that an automatic self-heal (a stale id
 * from another account, a deleted workspace) is only deferred, never lost.
 */
export const WORKSPACE_SWITCH_INTENT_TTL_MS = 10_000

/**
 * Who is writing the active workspace.
 *
 * - `user` (default): the person picked it — the switcher, `openInWorkspace`,
 *   a chat chip, onboarding, creating or deleting a workspace. Records the
 *   switch intent below, so it wins over everything for its TTL.
 * - `automatic`: a screen reacting to data it already has (`adoptChatWorkspace`,
 *   the ChatPanel restore, `resolveActiveWorkspaceId`'s fallback). It cannot put
 *   back a workspace the person just left. A third workspace it has a real
 *   reason to select — a chip, a newly created workspace — is still allowed, so
 *   only the ids the person switched *away from* are blocked.
 */
export type ActiveWorkspaceWriteReason = 'user' | 'automatic'

interface WorkspaceSwitchIntent {
  id: string
  /** Workspaces the person switched away from while this intent has been live. */
  left: string[]
  at: number
}

// SecureStore's synchronous API makes the selected workspace available to
// useSyncExternalStore on the first render. Cache values to avoid repeat native
// bridge reads during renders; SecureStore restores them after a restart.
const nativeStorageCache = new Map<string, string | null>()
const listeners = new Set<() => void>()

function getNativeStorageItem(key: string): string | null {
  if (nativeStorageCache.has(key)) return nativeStorageCache.get(key) ?? null

  const nativeKey = NATIVE_STORAGE_KEYS[key]
  if (!nativeKey) return null
  let value: string | null = null
  try {
    value = SecureStore.getItem(nativeKey)
  } catch {
    // Keep the native store usable for this session if SecureStore is unavailable.
  }
  nativeStorageCache.set(key, value)
  return value
}

function setNativeStorageItem(key: string, value: string | null): void {
  nativeStorageCache.set(key, value)
  const nativeKey = NATIVE_STORAGE_KEYS[key]
  if (!nativeKey) return
  try {
    // SecureStore has no synchronous delete method. An empty value is treated
    // as absent by readers and preserves the store's synchronous API.
    SecureStore.setItem(nativeKey, value ?? '')
  } catch {
    // Keep the native store usable for this session if SecureStore is unavailable.
  }
}

/** Another window (e.g. the desktop island) switched workspace. */
function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === STORAGE_KEY || event.key === KIND_STORAGE_KEY) {
    emitActiveWorkspaceId()
  }
}

export function subscribeActiveWorkspaceId(listener: () => void): () => void {
  const watchOtherWindows = Platform.OS === 'web' && typeof window !== 'undefined'
  if (watchOtherWindows && listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (watchOtherWindows && listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

function emitActiveWorkspaceId(): void {
  for (const listener of [...listeners]) listener()
}

function persistActiveWorkspaceId(id: string | null): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    setNativeStorageItem(STORAGE_KEY, id)
    return
  }
  if (id == null) safeRemoveItem(STORAGE_KEY)
  else safeSetItem(STORAGE_KEY, id)
}

export function getActiveWorkspaceId(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return getNativeStorageItem(STORAGE_KEY) || null
  }
  return safeGetItem(STORAGE_KEY)
}

function readSwitchIntent(): WorkspaceSwitchIntent | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    const raw = getNativeStorageItem(SWITCH_INTENT_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; left?: unknown; at?: unknown }
      if (typeof parsed.id === 'string' && typeof parsed.at === 'number') {
        const left = Array.isArray(parsed.left)
          ? parsed.left.filter((value): value is string => typeof value === 'string')
          : []
        return { id: parsed.id, left, at: parsed.at }
      }
    } catch {
      // Ignore a corrupt record; it must never block a write.
    }
    return null
  }
  const raw = safeGetItem(SWITCH_INTENT_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; left?: unknown; at?: unknown }
    if (typeof parsed.id === 'string' && typeof parsed.at === 'number') {
      const left = Array.isArray(parsed.left)
        ? parsed.left.filter((value): value is string => typeof value === 'string')
        : []
      return { id: parsed.id, left, at: parsed.at }
    }
  } catch {
    // Ignore a corrupt record; it must never block a write.
  }
  return null
}

function persistSwitchIntent(intent: WorkspaceSwitchIntent | null): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    setNativeStorageItem(
      SWITCH_INTENT_STORAGE_KEY,
      intent == null ? null : JSON.stringify(intent),
    )
    return
  }
  if (intent == null) safeRemoveItem(SWITCH_INTENT_STORAGE_KEY)
  else safeSetItem(SWITCH_INTENT_STORAGE_KEY, JSON.stringify(intent))
}

function isIntentFresh(intent: WorkspaceSwitchIntent): boolean {
  return Date.now() - intent.at < WORKSPACE_SWITCH_INTENT_TTL_MS
}

/**
 * Whether a fresh user switch outranks an automatic write of `id`: the person
 * just left that workspace, so a screen that still refers to it is stale.
 * Read from storage rather than memory so every tab agrees, including the one
 * that did not make the switch.
 */
function isOverriddenByUserSwitch(id: string | null): boolean {
  if (id == null) return false
  const intent = readSwitchIntent()
  if (!intent || !isIntentFresh(intent)) return false
  return intent.left.includes(id)
}

/**
 * Persist the active workspace, refusing an automatic write that would undo a
 * switch the person just made. Returns whether the id was accepted. The one
 * place the id is written, so no caller has to remember this rule.
 */
function writeActiveWorkspaceId(
  id: string | null,
  reason: ActiveWorkspaceWriteReason,
): boolean {
  if (reason === 'automatic' && isOverriddenByUserSwitch(id)) return false
  persistActiveWorkspaceId(id)
  return true
}

export interface SetActiveWorkspaceIdOptions {
  /** Defaults to `user`; see `ActiveWorkspaceWriteReason`. */
  reason?: ActiveWorkspaceWriteReason
}

/**
 * Make `id` the active workspace. Returns false when the write was refused
 * because a switch the person made a moment ago outranks it.
 */
export function setActiveWorkspaceId(
  id: string,
  options: SetActiveWorkspaceIdOptions = {},
): boolean {
  const reason = options.reason ?? 'user'
  const previous = getActiveWorkspaceId()
  if (previous === id) return true
  if (!writeActiveWorkspaceId(id, reason)) return false
  if (reason === 'user') {
    // Carry the chain of workspaces this person has left while the intent is
    // live, so a fast second switch does not reopen the first one to a stale
    // automatic writer.
    const pending = readSwitchIntent()
    const left = [
      ...(pending && isIntentFresh(pending) ? pending.left : []),
      ...(previous ? [previous] : []),
    ].filter((leftId) => leftId !== id)
    persistSwitchIntent({ id, left: [...new Set(left)], at: Date.now() })
  }
  // `resolveActiveWorkspaceId` may persist a fallback during render.
  queueMicrotask(emitActiveWorkspaceId)
  return true
}

/** Drop the switch intent. Tests, and anything that abandons a switch. */
export function clearWorkspaceSwitchIntent(): void {
  persistSwitchIntent(null)
}

/**
 * Clear the persisted "active workspace" pointer.
 *
 * Call this on sign-out. `STORAGE_KEY` is a bare (unscoped-by-user) key, so
 * signing out of account A and into account B on the same browser/device
 * otherwise leaves account A's workspace id cached — the UI then tries to
 * load that workspace for account B, who isn't a member, and every
 * workspace-scoped fetch (`/api/projects`, `/api/workspaces/:id/visible-models`,
 * …) 400/403s with "Access denied to this workspace" until the user manually
 * switches workspaces. See `resolveActiveWorkspaceId` for the read-side guard
 * against the same stale-id class of bug.
 */
export function clearActiveWorkspaceId(): void {
  const hadId = getActiveWorkspaceId() != null
  const hadKind = readCachedWorkspaceKind() != null
  // A pending switch belongs to the account that made it: clear it with the id
  // or it would outrank the next account's first resolution.
  const hadIntent = readSwitchIntent() != null
  if (!hadId && !hadKind && !hadIntent) return
  persistActiveWorkspaceId(null)
  persistCachedWorkspaceKind(null)
  persistSwitchIntent(null)
  queueMicrotask(emitActiveWorkspaceId)
}

function readCachedWorkspaceKind(): { id: string; kind: CachedWorkspaceKind } | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    const raw = getNativeStorageItem(KIND_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; kind?: unknown }
      if (
        typeof parsed.id === 'string' &&
        (parsed.kind === 'personal' || parsed.kind === 'team')
      ) {
        return { id: parsed.id, kind: parsed.kind }
      }
    } catch {
      // Ignore a corrupt cache and treat the kind as unknown.
    }
    return null
  }
  const raw = safeGetItem(KIND_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; kind?: unknown }
    if (
      typeof parsed.id === 'string' &&
      (parsed.kind === 'personal' || parsed.kind === 'team')
    ) {
      return { id: parsed.id, kind: parsed.kind }
    }
  } catch {
    // Ignore a corrupt cache and treat the kind as unknown.
  }
  return null
}

function persistCachedWorkspaceKind(
  record: { id: string; kind: CachedWorkspaceKind } | null,
): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    setNativeStorageItem(
      KIND_STORAGE_KEY,
      record == null ? null : JSON.stringify(record),
    )
    return
  }
  if (record == null) safeRemoveItem(KIND_STORAGE_KEY)
  else safeSetItem(KIND_STORAGE_KEY, JSON.stringify(record))
}

/**
 * Last known `kind` for `workspaceId`, or null when this id has never been
 * resolved on this device. Read synchronously so the first paint can use it.
 * On web that is localStorage; on native it is SecureStore, cached in memory
 * for the lifetime of the current app process.
 */
export function getCachedWorkspaceKind(
  workspaceId: string | null | undefined,
): CachedWorkspaceKind | null {
  if (!workspaceId) return null
  const cached = readCachedWorkspaceKind()
  return cached?.id === workspaceId ? cached.kind : null
}

/**
 * Remember `kind` for `workspaceId` without notifying subscribers.
 * Safe to call while rendering: the value is only needed on the next load.
 */
export function rememberWorkspaceKind(
  workspaceId: string,
  kind: CachedWorkspaceKind,
): void {
  const cached = readCachedWorkspaceKind()
  if (cached?.id === workspaceId && cached.kind === kind) return
  persistCachedWorkspaceKind({ id: workspaceId, kind })
}

export interface ActiveWorkspaceResolutionOptions {
  /**
   * Whether `ownWorkspaceIds` came from a completed, authoritative load.
   * Resolution during an initial or in-flight load must not replace the
   * persisted workspace with the first item in a partial list.
   */
  listLoaded?: boolean
  /**
   * React render paths should not persist a fallback. Callers that have
   * explicitly awaited a complete workspace load may opt into that cleanup.
   */
  persistFallback?: boolean
}

/**
 * Resolve the workspace id to use, validating the persisted/candidate id
 * against the caller's *own* loaded workspace list before trusting it.
 *
 * A bare `getActiveWorkspaceId() ?? workspaces[0]` (the pattern this replaces)
 * blindly trusts whatever is cached — including a stale id left over from a
 * different account that was previously signed in on this browser/device, or
 * one poked in via a `?workspace=` link. If that id isn't one of the current
 * user's own workspaces, every subsequent fetch scoped to it is denied by the
 * server, and the UI silently shows "no projects" with no recovery.
 *
 * When `ownWorkspaceIds` is non-empty and `candidateId` isn't in it, this
 * returns the first of the user's own workspaces. Persistence is only done
 * for an authoritative load, and render callers can disable it entirely.
 */
export function resolveActiveWorkspaceId(
  ownWorkspaceIds: readonly string[],
  candidateId?: string | null,
  options: ActiveWorkspaceResolutionOptions = {},
): string | null {
  const id = candidateId ?? getActiveWorkspaceId()
  if (id && (ownWorkspaceIds.length === 0 || ownWorkspaceIds.includes(id))) {
    return id
  }

  // A workspace collection can be empty or temporarily partial while its
  // initial request is in flight. Never turn that transient state into a
  // persisted switch to `ownWorkspaceIds[0]` (normally Personal).
  if (options.listLoaded === false) {
    return id ?? null
  }

  const fallback = ownWorkspaceIds[0] ?? null
  // This helper is called while React is rendering `useActiveWorkspace`.
  // Persist the self-healing fallback without emitting a subscription update;
  // notifying here schedules another render from inside render and can loop
  // indefinitely when the browser has no active workspace cached yet.
  //
  // An automatic write: a fallback derived from a list that has not caught up
  // must not undo a workspace the person picked a moment ago (SHO-157).
  if (
    options.persistFallback !== false &&
    fallback &&
    fallback !== id
  ) {
    writeActiveWorkspaceId(fallback, 'automatic')
  }
  return fallback
}
