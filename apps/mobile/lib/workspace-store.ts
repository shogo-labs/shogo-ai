// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo:active-workspace-id'

let nativeActiveWorkspaceId: string | null = null
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
  if (getActiveWorkspaceId() == null) return
  persistActiveWorkspaceId(null)
  queueMicrotask(emitActiveWorkspaceId)
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
  if (fallback && fallback !== id) setActiveWorkspaceId(fallback)
  return fallback
}
