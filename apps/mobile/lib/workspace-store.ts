// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo:active-workspace-id'
const KIND_STORAGE_KEY = 'shogo:active-workspace-kind'

export type CachedWorkspaceKind = 'personal' | 'team'

let nativeActiveWorkspaceId: string | null = null
let nativeActiveWorkspaceKind: { id: string; kind: CachedWorkspaceKind } | null = null
const listeners = new Set<() => void>()

export function subscribeActiveWorkspaceId(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emitActiveWorkspaceId(): void {
  for (const listener of [...listeners]) listener()
}

function persistActiveWorkspaceId(id: string | null): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    nativeActiveWorkspaceId = id
    return
  }
  if (id == null) safeRemoveItem(STORAGE_KEY)
  else safeSetItem(STORAGE_KEY, id)
}

export function getActiveWorkspaceId(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return nativeActiveWorkspaceId
  }
  return safeGetItem(STORAGE_KEY)
}

export function setActiveWorkspaceId(id: string): void {
  if (getActiveWorkspaceId() === id) return
  persistActiveWorkspaceId(id)
  // `resolveActiveWorkspaceId` may persist a fallback during render.
  queueMicrotask(emitActiveWorkspaceId)
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
  if (!hadId && !hadKind) return
  persistActiveWorkspaceId(null)
  persistCachedWorkspaceKind(null)
  queueMicrotask(emitActiveWorkspaceId)
}

function readCachedWorkspaceKind(): { id: string; kind: CachedWorkspaceKind } | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return nativeActiveWorkspaceKind
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
    nativeActiveWorkspaceKind = record
    return
  }
  if (record == null) safeRemoveItem(KIND_STORAGE_KEY)
  else safeSetItem(KIND_STORAGE_KEY, JSON.stringify(record))
}

/**
 * Last known `kind` for `workspaceId`, or null when this id has never been
 * resolved on this device. Read synchronously so the first paint can use it.
 * On web that is localStorage; on native it is the in-memory value kept next
 * to the active workspace id.
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
 * self-heals by returning (and persisting) the first of the user's own
 * workspaces instead.
 */
export function resolveActiveWorkspaceId(
  ownWorkspaceIds: readonly string[],
  candidateId?: string | null,
): string | null {
  const id = candidateId ?? getActiveWorkspaceId()
  if (id && (ownWorkspaceIds.length === 0 || ownWorkspaceIds.includes(id))) {
    return id
  }
  const fallback = ownWorkspaceIds[0] ?? null
  // This helper is called while React is rendering `useActiveWorkspace`.
  // Persist the self-healing fallback without emitting a subscription update;
  // notifying here schedules another render from inside render and can loop
  // indefinitely when the browser has no active workspace cached yet.
  if (fallback && fallback !== id) persistActiveWorkspaceId(fallback)
  return fallback
}
