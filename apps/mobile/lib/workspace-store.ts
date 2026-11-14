// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import {
  safeGetItem,
  safeSetItem,
  safeRemoveItem,
  safeSessionGetItem,
  safeSessionSetItem,
  safeSessionRemoveItem,
} from './safe-storage'

/**
 * The active workspace — one per browser tab (SHO-390).
 *
 * On web the selection lives in `sessionStorage`, so switching workspace in
 * one tab leaves every other tab where it was. `localStorage` holds only the
 * default a *new* tab starts from: it is written when a person switches, never
 * by an automatic fallback, and copied into a tab the first time that tab has
 * no selection of its own (which is also what makes "Duplicate tab" work).
 *
 * A window that is not a tab, like the desktop island overlay, must keep
 * following the shared default instead: it calls
 * `setActiveWorkspaceFollowsShared()` at module load, reads `localStorage`
 * directly, and keeps the `storage` listener.
 */
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
 * A switch is applied in place and then reloads the page (~½s on web). In
 * that window a still-mounted screen can resolve a stale workspace — the chat
 * it has open, a projects list that has not caught up — and
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

export function isWebStorage(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined'
}

/**
 * Whether this window mirrors the workspace picked in the main app window
 * (the desktop island) instead of owning one of its own.
 *
 * A normal window is per tab: its selection lives in `sessionStorage`, and
 * `localStorage` is only the default a brand-new tab starts from. A follower
 * window has no tab of its own to keep a selection in, so it reads and writes
 * `localStorage` directly and stays subscribed to `storage` — that is how the
 * island follows a switch made in the main window (SHO-390).
 */
let followsSharedWorkspace = false
let storageListenerAttached = false

export function setActiveWorkspaceFollowsShared(follows = true): void {
  if (followsSharedWorkspace === follows) return
  followsSharedWorkspace = follows
  syncStorageListener()
  emitActiveWorkspaceId()
}

/** Another window (e.g. the desktop island's main window) switched workspace. */
function onStorage(event: StorageEvent): void {
  // A normal tab owns its selection: another tab's switch (or another tab's
  // `localStorage.clear()` on sign-out) must not move it.
  if (!followsSharedWorkspace) return
  if (event.key === null || event.key === STORAGE_KEY || event.key === KIND_STORAGE_KEY) {
    emitActiveWorkspaceId()
  }
}

function syncStorageListener(): void {
  if (!isWebStorage()) return
  const shouldWatch = followsSharedWorkspace && listeners.size > 0
  if (shouldWatch && !storageListenerAttached) {
    window.addEventListener('storage', onStorage)
    storageListenerAttached = true
  } else if (!shouldWatch && storageListenerAttached) {
    window.removeEventListener('storage', onStorage)
    storageListenerAttached = false
  }
}

export function subscribeActiveWorkspaceId(listener: () => void): () => void {
  listeners.add(listener)
  syncStorageListener()
  return () => {
    listeners.delete(listener)
    syncStorageListener()
  }
}

function emitActiveWorkspaceId(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Read the workspace selection: this tab's own on web, else the shared default
 * a fresh tab starts from. In a follower window the shared value is the only
 * one that exists, so it is read directly.
 *
 * `seed` copies the shared default into this tab the first time the tab has
 * nothing of its own, which is what makes a new tab (or a duplicated one)
 * open where the person last chose. Only the id and the kind hint seed; the
 * switch intent is this tab's own business.
 */
function readWorkspaceItem(key: string, options: { seed: boolean }): string | null {
  if (followsSharedWorkspace) return safeGetItem(key)
  const tabValue = safeSessionGetItem(key)
  if (tabValue != null) return tabValue
  if (!options.seed) return null
  const sharedValue = safeGetItem(key)
  if (sharedValue == null) return null
  safeSessionSetItem(key, sharedValue)
  return sharedValue
}

/**
 * Write the selection. `share` mirrors it into `localStorage`, which is what
 * makes it the default for the next new tab and what the island follows; it is
 * set for a person's own switch (and always in a follower window), never for
 * an automatic write, so a fallback can never move the shared default.
 */
function writeWorkspaceItem(key: string, value: string | null, share: boolean): void {
  if (!followsSharedWorkspace) {
    if (value == null) safeSessionRemoveItem(key)
    else safeSessionSetItem(key, value)
  }
  if (!followsSharedWorkspace && !share) return
  if (value == null) safeRemoveItem(key)
  else safeSetItem(key, value)
}

function persistActiveWorkspaceId(id: string | null, share: boolean): void {
  if (!isWebStorage()) {
    setNativeStorageItem(STORAGE_KEY, id)
    return
  }
  writeWorkspaceItem(STORAGE_KEY, id, share)
}

export function getActiveWorkspaceId(): string | null {
  if (!isWebStorage()) {
    return getNativeStorageItem(STORAGE_KEY) || null
  }
  return readWorkspaceItem(STORAGE_KEY, { seed: true })
}

function readSwitchIntent(): WorkspaceSwitchIntent | null {
  if (!isWebStorage()) {
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
  const raw = readWorkspaceItem(SWITCH_INTENT_STORAGE_KEY, { seed: false })
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

/**
 * This tab's own record of the switch it just made. It only has to stop a
 * screen in *this* tab from undoing it, so it never leaves the tab (SHO-390);
 * a follower window still keeps it in the shared store, where it is harmless.
 */
function persistSwitchIntent(intent: WorkspaceSwitchIntent | null): void {
  if (!isWebStorage()) {
    setNativeStorageItem(
      SWITCH_INTENT_STORAGE_KEY,
      intent == null ? null : JSON.stringify(intent),
    )
    return
  }
  writeWorkspaceItem(
    SWITCH_INTENT_STORAGE_KEY,
    intent == null ? null : JSON.stringify(intent),
    false,
  )
}

function isIntentFresh(intent: WorkspaceSwitchIntent): boolean {
  return Date.now() - intent.at < WORKSPACE_SWITCH_INTENT_TTL_MS
}

/**
 * Whether a fresh user switch outranks an automatic write of `id`: the person
 * just left that workspace, so a screen that still refers to it is stale.
 * Read from storage rather than memory so it survives the reload a switch
 * triggers. Since a switch now only moves its own tab (SHO-390), so does this
 * record: another tab never sees the switch and never needs to be protected
 * from echoing it back.
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
 *
 * Only a person's own switch is mirrored into the shared default a new tab
 * opens on; an automatic write is this tab's business alone (SHO-390).
 */
function writeActiveWorkspaceId(
  id: string | null,
  reason: ActiveWorkspaceWriteReason,
): boolean {
  if (reason === 'automatic' && isOverriddenByUserSwitch(id)) return false
  persistActiveWorkspaceId(id, reason === 'user')
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
  // Both stores, every key: account A's id must not leak to account B in this
  // tab *or* in a tab opened afterwards.
  persistActiveWorkspaceId(null, true)
  persistCachedWorkspaceKind(null, true)
  persistSwitchIntent(null)
  queueMicrotask(emitActiveWorkspaceId)
}

function readCachedWorkspaceKind(): { id: string; kind: CachedWorkspaceKind } | null {
  if (!isWebStorage()) {
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
  const raw = readWorkspaceItem(KIND_STORAGE_KEY, { seed: true })
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

/**
 * `share` mirrors the hint into `localStorage`, where the next new tab seeds
 * it from. Defaults to "yes when this is the shared default's kind", so the
 * hint a tab keeps for its own workspace never overwrites the one a new tab
 * will need; sign-out passes `true` to clear both stores.
 */
function persistCachedWorkspaceKind(
  record: { id: string; kind: CachedWorkspaceKind } | null,
  share: boolean = record != null && safeGetItem(STORAGE_KEY) === record.id,
): void {
  if (!isWebStorage()) {
    setNativeStorageItem(
      KIND_STORAGE_KEY,
      record == null ? null : JSON.stringify(record),
    )
    return
  }
  writeWorkspaceItem(
    KIND_STORAGE_KEY,
    record == null ? null : JSON.stringify(record),
    share,
  )
}

/**
 * Last known `kind` for `workspaceId`, or null when this id has never been
 * resolved on this device. Read synchronously so the first paint can use it.
 * On web that is this tab's sessionStorage (a new tab seeds it from the shared
 * default); on native it is SecureStore, cached in memory for the lifetime of
 * the current app process.
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

/**
 * The workspace a `?workspace=` link may move the person to, or `null`.
 *
 * Read-side counterpart to `resolveActiveWorkspaceId`, for links rather than
 * render paths: a link names one workspace, and either this account is a member
 * of it or the link does nothing at all. Resolving a link through
 * `resolveActiveWorkspaceId` answered `ownWorkspaceIds[0]` for a workspace the
 * person is not in and persisted it, so opening a refused file link moved them
 * out of the workspace they were reading — and switched the screen behind the
 * "you don't have access to this workspace" message (SHO-284).
 */
export function adoptableWorkspaceParam(
  ownWorkspaceIds: readonly string[],
  targetId: string | null | undefined,
): string | null {
  if (!targetId) return null
  return ownWorkspaceIds.includes(targetId) ? targetId : null
}
