// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop routing for the user's cloud workspaces (team and Personal), which
 * are listed alongside the local ones while signed in.
 *
 * The desktop's local API relays `/api/cloud/<workspaceId>/<path>` to Shogo
 * Cloud with that workspace's key. While a cloud workspace is active, API
 * calls for it are rewritten to that prefix; everything that belongs to this
 * computer (auth, local settings, the workspace list, AI proxy, ...) stays
 * local. A path that names a workspace (`/api/workspaces/<id>/...` or
 * `?workspaceId=<id>`) follows that workspace, whichever one is active.
 */
import { useSyncExternalStore } from 'react'
import { clearActiveWorkspaceId, getActiveWorkspaceId } from './workspace-store'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

export interface CloudWorkspaceInfo {
  id: string
  name: string
  slug: string | null
  kind: 'personal' | 'team'
}

export interface CloudUser {
  id: string
  name: string | null
  email: string | null
}

export interface CloudWorkspacesState {
  signedIn: boolean
  cloudUrl: string | null
  reachable: boolean
  user: CloudUser | null
  workspaces: CloudWorkspaceInfo[]
}

const STORAGE_KEY = 'shogo:cloud-workspaces'
const EMPTY: CloudWorkspacesState = { signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] }

const LOCAL_ONLY = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/local(\/|$)/,
  /^\/api\/cloud(\/|$)/,
  /^\/api\/workspaces\/?$/,
  /^\/api\/users(\/|$)/,
  /^\/api\/me(\/|$)/,
  /^\/api\/onboarding(\/|$)/,
  /^\/api\/config(\/|$)/,
  /^\/api\/platform(\/|$)/,
  /^\/api\/health(\/|$)/,
  /^\/api\/ai(\/|$)/,
  /^\/api\/voice(\/|$)/,
  /^\/api\/tools(\/|$)/,
  /^\/api\/tech-stacks(\/|$)/,
  /^\/api\/api-keys(\/|$)/,
  /^\/api\/cli(\/|$)/,
  /^\/api\/marketplace(\/|$)/,
]

let state: CloudWorkspacesState = loadCached()
let cloudIds = new Set(state.workspaces.map((w) => w.id))
const listeners = new Set<() => void>()

function loadCached(): CloudWorkspacesState {
  const raw = safeGetItem(STORAGE_KEY)
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.workspaces) ? { ...EMPTY, ...parsed } : EMPTY
  } catch {
    return EMPTY
  }
}

export function setCloudWorkspacesState(next: CloudWorkspacesState): void {
  state = next
  cloudIds = new Set(next.workspaces.map((w) => w.id))
  if (next.workspaces.length) safeSetItem(STORAGE_KEY, JSON.stringify(next))
  else safeRemoveItem(STORAGE_KEY)
  for (const listener of [...listeners]) listener()
}

export function getCloudWorkspacesState(): CloudWorkspacesState {
  return state
}

/** Another window (e.g. the desktop island) refreshed the list. */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  state = loadCached()
  cloudIds = new Set(state.workspaces.map((w) => w.id))
  for (const listener of [...listeners]) listener()
}

export function subscribeCloudWorkspaces(listener: () => void): () => void {
  const watchOtherWindows = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (watchOtherWindows && listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (watchOtherWindows && listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

export function useCloudWorkspaces(): CloudWorkspacesState {
  return useSyncExternalStore(subscribeCloudWorkspaces, getCloudWorkspacesState, getCloudWorkspacesState)
}

export function isCloudWorkspace(id: string | null | undefined): boolean {
  return !!id && cloudIds.has(id)
}

export function isActiveWorkspaceCloud(): boolean {
  return isCloudWorkspace(getActiveWorkspaceId())
}

function targetWorkspace(pathname: string, search: string): string | null {
  const inPath = /^\/api\/workspaces\/([^/?#]+)/.exec(pathname)
  if (inPath) return decodeURIComponent(inPath[1]!)
  const inQuery = new URLSearchParams(search).get('workspaceId')
  if (inQuery) return inQuery
  if (LOCAL_ONLY.some((re) => re.test(pathname))) return null
  return getActiveWorkspaceId()
}

/**
 * Rewrite an API path (`/api/...`, optionally with a querystring) so it
 * reaches the workspace it belongs to.
 */
export function routePath(path: string): string {
  if (!cloudIds.size || !path.startsWith('/api/')) return path
  const q = path.search(/[?#]/)
  const pathname = q === -1 ? path : path.slice(0, q)
  const search = q === -1 ? '' : path.slice(q)
  if (/^\/api\/cloud(\/|$)/.test(pathname)) return path
  const target = targetWorkspace(pathname, search.startsWith('?') ? search : '')
  if (!target || !cloudIds.has(target)) return path
  return `/api/cloud/${encodeURIComponent(target)}${path.slice('/api'.length)}`
}

/** `routePath` for an absolute URL on `apiBase`; other URLs pass through. */
export function routeUrl(url: string, apiBase: string): string {
  if (!cloudIds.size) return url
  const base = apiBase.replace(/\/+$/, '')
  if (!url.startsWith(`${base}/api/`)) return url
  return `${base}${routePath(url.slice(base.length))}`
}

let installed = false

/**
 * Route every `fetch` to `apiBase` through `routeUrl`. This covers the SDK
 * `HttpClient` behind the domain stores as well as direct fetches.
 */
export function installWorkspaceFetchRouter(apiBase: string): void {
  if (installed || typeof globalThis.fetch !== 'function') return
  installed = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!cloudIds.size) return original(input, init)
    if (typeof input === 'string') return original(routeUrl(input, apiBase), init)
    if (input instanceof URL) return original(routeUrl(input.toString(), apiBase), init)
    const routed = routeUrl(input.url, apiBase)
    return original(routed === input.url ? input : new Request(routed, input), init)
  }) as typeof fetch
}

/**
 * The active cloud workspace went away (signed out, or the user left it):
 * fall back to the local workspaces.
 */
function leaveRemovedCloudWorkspace(previous: CloudWorkspacesState): void {
  const activeId = getActiveWorkspaceId()
  if (!activeId || cloudIds.has(activeId)) return
  if (previous.workspaces.some((w) => w.id === activeId)) clearActiveWorkspaceId()
}

/** Load which cloud workspaces this desktop can open from the local API. */
export async function refreshCloudWorkspaces(apiBase: string, opts: { sync?: boolean } = {}): Promise<CloudWorkspacesState> {
  try {
    const base = apiBase.replace(/\/+$/, '')
    if (opts.sync) {
      await fetch(`${base}/api/local/cloud-workspaces/sync`, { method: 'POST', credentials: 'include' }).catch(() => {})
    }
    const res = await fetch(`${base}/api/local/cloud-workspaces`, { credentials: 'include' })
    if (!res.ok) {
      if (res.status === 401 || res.status === 404) setCloudWorkspacesState(EMPTY)
      return state
    }
    const body = (await res.json()) as Partial<CloudWorkspacesState>
    const workspaces = (Array.isArray(body.workspaces) ? body.workspaces : []).map((w) => ({
      ...w,
      kind: w.kind === 'personal' ? ('personal' as const) : ('team' as const),
    }))
    const previous = state
    setCloudWorkspacesState({
      signedIn: !!body.signedIn,
      cloudUrl: body.cloudUrl ?? null,
      reachable: body.reachable !== false,
      user: body.user ?? null,
      workspaces,
    })
    leaveRemovedCloudWorkspace(previous)
  } catch {
    // Keep the last known list; the relay reports cloud outages per request.
  }
  return state
}

/** Re-reads the cached list, as a fresh page load would. */
export function _resetWorkspaceRouteForTests(): void {
  state = loadCached()
  cloudIds = new Set(state.workspaces.map((w) => w.id))
  listeners.clear()
}
