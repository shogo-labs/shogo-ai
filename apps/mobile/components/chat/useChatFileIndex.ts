// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace file list for the chat, so file paths the agent mentions can be
 * drawn as chips only when they point at a real file.
 *
 * A workspace agent also writes files in other projects, which live in that
 * project's own runtime rather than in this one — `<projectId>/<path>` is in no
 * list here, so those paths are looked up in the owning project's file list,
 * fetched once per project and refreshed when a turn ends (SHO-247).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { AgentClient } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../lib/agent-fetch"
import { fileIndexHas, resolveChatFilePath } from "./file-links"

const EMPTY: ReadonlySet<string> = new Set()
const EMPTY_BY_PROJECT: ReadonlyMap<string, ReadonlySet<string>> = new Map()

export interface ChatFileIndexOptions {
  /**
   * Agent base URL for another project of this workspace, or null when that
   * project cannot be reached from here.
   */
  projectAgentUrl?: (projectId: string) => string | null
}

export function useChatFileIndex(
  agentUrl: string | null | undefined,
  projectId: string | null | undefined,
  isStreaming: boolean,
  options: ChatFileIndexOptions = {},
): (path: string) => boolean {
  const [files, setFiles] = useState<ReadonlySet<string>>(EMPTY)
  const [projectFiles, setProjectFiles] =
    useState<ReadonlyMap<string, ReadonlySet<string>>>(EMPTY_BY_PROJECT)
  const [refreshKey, setRefreshKey] = useState(0)
  const wasStreamingRef = useRef(isStreaming)
  const projectAgentUrl = options.projectAgentUrl
  // Projects whose list has been asked for, so a chip check that runs on every
  // render asks each project at most once. Never blanked: the lists are
  // refreshed in place, so a path that chips now must not un-chip because a
  // turn ended before the new list arrived (SHO-280).
  const requestedRef = useRef<Set<string>>(new Set())
  // A project read that has not settled yet, so a refresh does not stack a
  // second read on top of it.
  const inFlightRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // A finished turn may have created the files its reply mentions.
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) setRefreshKey((k) => k + 1)
    wasStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    if (!agentUrl) {
      setFiles(EMPTY)
      return
    }
    let cancelled = false
    const client = new AgentClient({ baseUrl: agentUrl.replace(/\/$/, ""), fetch: agentFetch })
    // File chips are optional; an out-of-date SDK build must not crash chat.
    if (typeof client.listWorkspaceFiles !== "function") return
    client
      .listWorkspaceFiles()
      .then((res) => {
        if (!cancelled) setFiles(new Set(res.files))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agentUrl, refreshKey])

  const loadProjectFiles = useCallback(
    (ownerId: string): boolean => {
      if (!projectAgentUrl) return false
      const base = projectAgentUrl(ownerId)
      if (!base) return false
      if (inFlightRef.current.has(ownerId)) return true
      const client = new AgentClient({ baseUrl: base.replace(/\/$/, ""), fetch: agentFetch })
      if (typeof client.listWorkspaceFiles !== "function") return false
      inFlightRef.current.add(ownerId)
      client
        .listWorkspaceFiles()
        .then((res) => {
          if (!mountedRef.current) return
          const next = new Set(res.files)
          // Replaced in place: the list that is already cached stays readable
          // until the new one arrives.
          setProjectFiles((current) => {
            const merged = new Map(current)
            merged.set(ownerId, next)
            return merged
          })
        })
        .catch(() => {
          // Leave the project's cached list as it was: the file simply does not
          // chip here until a later read succeeds.
        })
        .finally(() => {
          inFlightRef.current.delete(ownerId)
        })
      return true
    },
    [projectAgentUrl],
  )

  // A finished turn may have created files in any project already read, so
  // every one of them is read again — in place. Serially blanking the cache
  // instead made whether a chip appears depend on which of two requests won.
  useEffect(() => {
    if (refreshKey === 0) return
    for (const ownerId of Array.from(requestedRef.current)) loadProjectFiles(ownerId)
  }, [refreshKey, loadProjectFiles])

  return useCallback(
    (path: string) => {
      const fallback = projectId ?? null
      if (fileIndexHas(files, path, fallback)) return true
      const resolved = resolveChatFilePath(path, fallback)
      if (!resolved?.projectId) return false
      // A mounted project is in the workspace list already; one that is not is
      // in its own runtime, and its list is fetched the first time it is asked
      // about (always, on a runtime that never mounts projects).
      const cached = projectFiles.get(resolved.projectId)
      if (cached) return fileIndexHas(cached, resolved.relPath, null)
      if (!requestedRef.current.has(resolved.projectId) && loadProjectFiles(resolved.projectId)) {
        requestedRef.current.add(resolved.projectId)
      }
      return false
    },
    [files, projectFiles, projectId, loadProjectFiles],
  )
}
