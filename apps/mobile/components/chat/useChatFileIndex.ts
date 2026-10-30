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
  // Projects whose list is already being fetched, so a chip check that runs on
  // every render asks each project at most once.
  const requestedRef = useRef<Set<string>>(new Set())

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

  // A finished turn may have created the files its reply mentions, in this
  // runtime or in another project, so both lists are read again.
  useEffect(() => {
    if (refreshKey === 0) return
    requestedRef.current.clear()
    setProjectFiles(EMPTY_BY_PROJECT)
  }, [refreshKey])

  const loadProjectFiles = useCallback(
    (ownerId: string) => {
      if (!projectAgentUrl) return
      const base = projectAgentUrl(ownerId)
      if (!base) return false
      const client = new AgentClient({ baseUrl: base.replace(/\/$/, ""), fetch: agentFetch })
      if (typeof client.listWorkspaceFiles !== "function") return false
      client
        .listWorkspaceFiles()
        .then((res) => {
          const next = new Set(res.files)
          setProjectFiles((current) => {
            const merged = new Map(current)
            merged.set(ownerId, next)
            return merged
          })
        })
        .catch(() => {
          // Leave the project uncached: the file simply does not chip here.
        })
      return true
    },
    [projectAgentUrl],
  )

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
