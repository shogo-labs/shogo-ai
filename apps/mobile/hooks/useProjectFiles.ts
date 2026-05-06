// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useProjectFiles — fetch + cache the list of files in a project for the
 * @-mention picker.
 *
 * Backed by `GET /api/projects/:projectId/files`. The list is cached in a
 * module-level Map for 30s, deduped across hook callers, and invalidated
 * when:
 *   1. AppState transitions to "active" (foreground refresh).
 *   2. consumers call invalidateProjectFiles(projectId) — wired into the
 *      runtime file-changed event in a follow-up; safe no-op for now.
 *
 * Returned `status` lets the picker show distinct empty states for
 * "no project connected" vs. "loading" vs. "error".
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { AppState, type AppStateStatus } from "react-native"
import { API_URL } from "../lib/api"

export interface ProjectFileEntry {
  path: string
  name: string
  type: "file" | "directory"
  extension?: string
  size?: number
}

export type ProjectFilesStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "no-project"

export interface UseProjectFilesResult {
  status: ProjectFilesStatus
  files: ProjectFileEntry[]
  error?: string
  refresh: () => Promise<void>
}

const TTL_MS = 30_000

interface CacheEntry {
  fetchedAt: number
  files: ProjectFileEntry[]
  inflight?: Promise<ProjectFileEntry[]>
}

const cache = new Map<string, CacheEntry>()
const subscribers = new Map<string, Set<(entry: CacheEntry) => void>>()

function notify(projectId: string, entry: CacheEntry) {
  subscribers.get(projectId)?.forEach((cb) => cb(entry))
}

export function invalidateProjectFiles(projectId?: string) {
  if (projectId) {
    cache.delete(projectId)
  } else {
    cache.clear()
  }
}

async function fetchProjectFiles(
  projectId: string,
): Promise<ProjectFileEntry[]> {
  const url = `${API_URL}/api/projects/${encodeURIComponent(projectId)}/files`
  const res = await fetch(url, {
    credentials: "include",
    headers: { accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(`files list failed: ${res.status}`)
  }
  const data = (await res.json()) as { files?: ProjectFileEntry[] }
  return Array.isArray(data.files) ? data.files : []
}

/**
 * Server-side fuzzy search for large projects. Bypasses the local cache
 * and delegates filtering to `GET /api/projects/:id/files?q=...&limit=50`.
 * Returns an empty array on error so the UI can fall back to local ranking.
 */
export async function searchProjectFiles(
  projectId: string,
  query: string,
  limit = 50,
): Promise<ProjectFileEntry[]> {
  if (!query) return []
  try {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const url = `${API_URL}/api/projects/${encodeURIComponent(projectId)}/files?${params}`
    const res = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json" },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { files?: ProjectFileEntry[] }
    return Array.isArray(data.files) ? data.files : []
  } catch {
    return []
  }
}

async function loadInto(projectId: string): Promise<ProjectFileEntry[]> {
  const existing = cache.get(projectId)
  if (existing?.inflight) return existing.inflight
  const inflight = fetchProjectFiles(projectId)
    .then((files) => {
      const entry: CacheEntry = { fetchedAt: Date.now(), files }
      cache.set(projectId, entry)
      notify(projectId, entry)
      return files
    })
    .catch((err) => {
      // Drop inflight so next call retries.
      const cur = cache.get(projectId)
      if (cur?.inflight === inflight) {
        cache.delete(projectId)
      }
      throw err
    })
  cache.set(projectId, { fetchedAt: 0, files: existing?.files ?? [], inflight })
  return inflight
}

export function useProjectFiles(
  projectId: string | null | undefined,
  options: { enabled?: boolean } = {},
): UseProjectFilesResult {
  const enabled = options.enabled !== false && !!projectId
  const [status, setStatus] = useState<ProjectFilesStatus>(() =>
    !projectId ? "no-project" : "idle",
  )
  const [files, setFiles] = useState<ProjectFileEntry[]>(() =>
    projectId ? cache.get(projectId)?.files ?? [] : [],
  )
  const [error, setError] = useState<string | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(
    async (force = false) => {
      if (!projectId) return
      const entry = cache.get(projectId)
      const fresh =
        entry && !force && Date.now() - entry.fetchedAt < TTL_MS && !entry.inflight
      if (fresh) {
        setFiles(entry.files)
        setStatus("ready")
        return
      }
      setStatus((s) => (s === "ready" ? "ready" : "loading"))
      try {
        const list = await loadInto(projectId)
        if (!mountedRef.current) return
        setFiles(list)
        setStatus("ready")
        setError(undefined)
      } catch (err: any) {
        if (!mountedRef.current) return
        setStatus("error")
        setError(err?.message || "Failed to load files")
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!enabled || !projectId) {
      setStatus(projectId ? "idle" : "no-project")
      return
    }
    // Subscribe so other hook instances see our refreshes.
    const set = subscribers.get(projectId) ?? new Set()
    const cb = (entry: CacheEntry) => {
      if (!mountedRef.current) return
      setFiles(entry.files)
      setStatus("ready")
    }
    set.add(cb)
    subscribers.set(projectId, set)

    void load()

    return () => {
      set.delete(cb)
      if (set.size === 0) subscribers.delete(projectId)
    }
  }, [enabled, projectId, load])

  // Refresh on foreground.
  useEffect(() => {
    if (!enabled) return
    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "active") void load(true)
    })
    return () => sub.remove()
  }, [enabled, load])

  const refresh = useCallback(async () => {
    if (!projectId) return
    invalidateProjectFiles(projectId)
    await load(true)
  }, [projectId, load])

  return { status, files, error, refresh }
}
