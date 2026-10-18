// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace file list for the chat, so file paths the agent mentions can be
 * drawn as chips only when they point at a real file.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { AgentClient } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../lib/agent-fetch"
import { fileIndexHas } from "./file-links"

const EMPTY: ReadonlySet<string> = new Set()

export function useChatFileIndex(
  agentUrl: string | null | undefined,
  projectId: string | null | undefined,
  isStreaming: boolean,
): (path: string) => boolean {
  const [files, setFiles] = useState<ReadonlySet<string>>(EMPTY)
  const [refreshKey, setRefreshKey] = useState(0)
  const wasStreamingRef = useRef(isStreaming)

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

  return useCallback(
    (path: string) => fileIndexHas(files, path, projectId ?? null),
    [files, projectId],
  )
}
