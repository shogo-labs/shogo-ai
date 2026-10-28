// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Effective RBAC permissions for the signed-in user on a workspace or project.
 *
 * Results are cached per scope and shared across every mounted hook, so many
 * components can ask about the same project without extra requests. The API
 * is the gate; this only drives what the UI offers. `can()` is false while
 * loading so privileged actions never flash in.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  PROJECT_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  WORKSPACE_TO_PROJECT_ROLE,
  isPermission,
  type Permission,
  type ProjectRole,
  type WorkspaceRole,
} from '@shogo/authz'
import type { HttpClient } from '@shogo-ai/sdk'
import { useDomainHttp } from '../contexts/domain'
import {
  api,
  type ProjectPermissionsData,
  type ProjectVisibility,
  type WorkspacePermissionsData,
} from '../lib/api'

export type PermissionScope =
  | { workspaceId: string | null | undefined }
  | { projectId: string | null | undefined }

interface ScopeAccess {
  permissions: Permission[]
  workspaceRole: WorkspaceRole | null
  projectRole: ProjectRole | null
  visibility: ProjectVisibility | null
  isGuest: boolean
  isSuperAdmin: boolean
}

interface CacheEntry {
  data: ScopeAccess | null
  fetchedAt: number
  promise: Promise<ScopeAccess | null> | null
  /** Earliest time a failed fetch may be retried (backoff while offline). */
  retryAt: number
}

const STALE_MS = 30_000
/** How long to wait before retrying a scope whose fetch failed on the wire. */
export const PERMISSIONS_RETRY_MS = 5_000
const NO_ACCESS: ScopeAccess = {
  permissions: [],
  workspaceRole: null,
  projectRole: null,
  visibility: null,
  isGuest: false,
  isSuperAdmin: false,
}

const cache = new Map<string, CacheEntry>()
const listeners = new Map<string, Set<() => void>>()

function scopeKey(scope: PermissionScope): string | null {
  if ('projectId' in scope) return scope.projectId ? `project:${scope.projectId}` : null
  return scope.workspaceId ? `workspace:${scope.workspaceId}` : null
}

function fromWorkspace(data: WorkspacePermissionsData | null): ScopeAccess {
  if (!data) return NO_ACCESS
  return {
    permissions: (data.permissions ?? []).filter(isPermission),
    workspaceRole: data.role ?? null,
    projectRole: null,
    visibility: null,
    isGuest: false,
    isSuperAdmin: !!data.isSuperAdmin,
  }
}

function fromProject(data: ProjectPermissionsData | null): ScopeAccess {
  if (!data) return NO_ACCESS
  return {
    permissions: (data.permissions ?? []).filter(isPermission),
    workspaceRole: data.workspaceRole ?? null,
    projectRole: data.projectRole ?? null,
    visibility: data.visibility ?? null,
    isGuest: !!data.isGuest,
    isSuperAdmin: !!data.isSuperAdmin,
  }
}

function notify(key: string) {
  listeners.get(key)?.forEach((fn) => fn())
}

/**
 * True only when the server itself said the caller cannot see this scope.
 * Anything else (dropped connection, abort, timeout, 5xx) is transient and
 * must not be cached as "no access" — that would leave a fully-privileged
 * user looking at a read-only project until the cache went stale.
 */
export function isAccessDenial(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return status === 401 || status === 403 || status === 404
  const code = (error as { code?: unknown } | null)?.code
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND'
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleRetry(key: string) {
  if (retryTimers.has(key)) return
  const timer = setTimeout(() => {
    retryTimers.delete(key)
    notify(key)
  }, PERMISSIONS_RETRY_MS + 50)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  retryTimers.set(key, timer)
}

function clearRetry(key: string) {
  const timer = retryTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(key)
  }
}

function load(http: HttpClient, key: string, force = false): Promise<ScopeAccess | null> {
  const entry = cache.get(key)
  if (entry?.promise) return entry.promise
  if (!force && entry?.data && Date.now() - entry.fetchedAt < STALE_MS) {
    return Promise.resolve(entry.data)
  }
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  const promise = Promise.resolve()
    .then(() =>
      kind === 'project'
        ? api.getProjectPermissions(http, id).then(fromProject)
        : api.getWorkspacePermissions(http, id).then(fromWorkspace),
    )
    .then((data) => {
      clearRetry(key)
      cache.set(key, { data, fetchedAt: Date.now(), promise: null, retryAt: 0 })
      notify(key)
      return data
    })
    .catch((error: unknown) => {
      // 401/403/404 mean "no access to this scope", not a transient failure.
      if (isAccessDenial(error)) {
        clearRetry(key)
        cache.set(key, { data: NO_ACCESS, fetchedAt: Date.now(), promise: null, retryAt: 0 })
        notify(key)
        return NO_ACCESS
      }
      // Transient: keep what we already knew, stay stale, retry after the backoff.
      cache.set(key, {
        data: entry?.data ?? null,
        fetchedAt: entry?.fetchedAt ?? 0,
        promise: null,
        retryAt: Date.now() + PERMISSIONS_RETRY_MS,
      })
      scheduleRetry(key)
      notify(key)
      return entry?.data ?? null
    })
  cache.set(key, {
    data: entry?.data ?? null,
    fetchedAt: entry?.fetchedAt ?? 0,
    promise,
    retryAt: entry?.retryAt ?? 0,
  })
  return promise
}

/** Drop cached permissions (e.g. after changing roles or visibility) and refetch for mounted hooks. */
export function invalidatePermissions(scope?: PermissionScope) {
  const keys = scope ? [scopeKey(scope)].filter((k): k is string => !!k) : [...cache.keys()]
  for (const key of keys) {
    const entry = cache.get(key)
    if (entry) cache.set(key, { ...entry, fetchedAt: 0, retryAt: 0 })
    clearRetry(key)
    notify(key)
  }
}

export function usePermissions(scope: PermissionScope) {
  const http = useDomainHttp()
  const key = scopeKey(scope)
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!key) return
    const set = listeners.get(key) ?? new Set()
    const listener = () => setVersion((v) => v + 1)
    set.add(listener)
    listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  }, [key])

  const entry = key ? cache.get(key) : undefined
  const isStale =
    !entry ||
    (!entry.promise && Date.now() - entry.fetchedAt >= STALE_MS && Date.now() >= entry.retryAt)

  useEffect(() => {
    if (!key || !http || !isStale) return
    void load(http, key)
  }, [http, key, isStale])

  const data = entry?.data ?? null
  const loading = !!key && !data

  const permissions = useMemo(() => new Set<Permission>(data?.permissions ?? []), [data])
  const can = useCallback((p: Permission) => permissions.has(p), [permissions])

  const refetch = useCallback(async () => {
    if (!key || !http) return
    await load(http, key, true)
  }, [http, key])

  return {
    permissions,
    can,
    role: data ? data.projectRole ?? data.workspaceRole : null,
    workspaceRole: data?.workspaceRole ?? null,
    projectRole: data?.projectRole ?? null,
    visibility: data?.visibility ?? null,
    isGuest: data?.isGuest ?? false,
    isSuperAdmin: data?.isSuperAdmin ?? false,
    loading,
    refetch,
  }
}

/**
 * Project permissions for a list item. Prefers the server-computed
 * `myPermissions` from the project payload; falls back to what the caller's
 * workspace role confers when the payload doesn't carry it.
 */
export function projectPermissionsFor(
  project: { myPermissions?: unknown } | null | undefined,
  workspace: { workspaceRole: WorkspaceRole | null; isSuperAdmin: boolean },
): ReadonlySet<Permission> {
  const own = project?.myPermissions
  if (Array.isArray(own)) return new Set(own.filter(isPermission))
  if (workspace.isSuperAdmin) return new Set<Permission>(PROJECT_PERMISSIONS)
  if (!workspace.workspaceRole) return new Set()
  return new Set<Permission>(PROJECT_ROLE_PERMISSIONS[WORKSPACE_TO_PROJECT_ROLE[workspace.workspaceRole]])
}
