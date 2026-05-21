// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { AgentClient, getAgentClient } from './client.js'
import type {
  AgentClientConfig,
  AgentStatus,
  ChatMessage,
  VisualMode,
  FileNode,
} from './types.js'

// ---------------------------------------------------------------------------
// Shared context for client instance
// ---------------------------------------------------------------------------

function useClient(config?: AgentClientConfig): AgentClient {
  const ref = useRef<AgentClient | null>(null)
  if (!ref.current) {
    ref.current = config ? new AgentClient(config) : getAgentClient()
  }
  return ref.current
}

// ---------------------------------------------------------------------------
// useAgentStatus
// ---------------------------------------------------------------------------

export interface UseAgentStatusOptions {
  pollInterval?: number
  config?: AgentClientConfig
}

export interface UseAgentStatusResult {
  status: AgentStatus | null
  loading: boolean
  error: Error | null
  refetch: () => void
}

export function useAgentStatus(options?: UseAgentStatusOptions): UseAgentStatusResult {
  const client = useClient(options?.config)
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetch = useCallback(async () => {
    try {
      const s = await client.getStatus()
      setStatus(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    fetch()
    const interval = options?.pollInterval
    if (!interval || interval <= 0) return
    const id = setInterval(fetch, interval)
    return () => clearInterval(id)
  }, [fetch, options?.pollInterval])

  return { status, loading, error, refetch: fetch }
}

// ---------------------------------------------------------------------------
// useAgentChat
// ---------------------------------------------------------------------------

export interface UseAgentChatOptions {
  sessionId?: string
  config?: AgentClientConfig
}

export interface UseAgentChatResult {
  messages: ChatMessage[]
  send: (text: string) => void
  isStreaming: boolean
  error: Error | null
}

export function useAgentChat(options?: UseAgentChatOptions): UseAgentChatResult {
  const client = useClient(options?.config)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    client.getChatHistory(options?.sessionId).then(
      (history) => { if (history?.length) setMessages(history) },
      () => { /* history not available */ },
    )
  }, [client, options?.sessionId])

  const send = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setError(null)

    try {
      const allMessages = [...messages, userMsg].map((m) => ({
        role: m.role,
        parts: [{ type: 'text' as const, text: m.content }],
      }))

      const response = await client.chat(allMessages, {
        sessionId: options?.sessionId,
      })

      let assistantText = ''
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (!line.startsWith('0:')) continue
            try {
              const text = JSON.parse(line.slice(2))
              if (typeof text === 'string') assistantText += text
            } catch { /* skip non-JSON lines */ }
          }
        }
      }

      if (assistantText) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantText }])
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setIsStreaming(false)
    }
  }, [client, messages, options?.sessionId])

  return { messages, send, isStreaming, error }
}

// ---------------------------------------------------------------------------
// useAgentMode
// ---------------------------------------------------------------------------

export interface UseAgentModeOptions {
  config?: AgentClientConfig
}

export interface UseAgentModeResult {
  mode: VisualMode | null
  loading: boolean
  setMode: (mode: VisualMode) => Promise<void>
}

export function useAgentMode(options?: UseAgentModeOptions): UseAgentModeResult {
  const client = useClient(options?.config)
  const [mode, setModeState] = useState<VisualMode | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    client.getMode().then(
      (m) => { setModeState(m); setLoading(false) },
      () => setLoading(false),
    )
  }, [client])

  const setMode = useCallback(async (m: VisualMode) => {
    await client.setMode(m)
    setModeState(m)
  }, [client])

  return { mode, loading, setMode }
}

// ---------------------------------------------------------------------------
// useAgentFiles
// ---------------------------------------------------------------------------

export interface UseAgentFilesOptions {
  config?: AgentClientConfig
}

export interface UseAgentFilesResult {
  tree: FileNode[] | null
  loading: boolean
  error: Error | null
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  refresh: () => void
}

export function useAgentFiles(options?: UseAgentFilesOptions): UseAgentFilesResult {
  const client = useClient(options?.config)
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    try {
      const t = await client.getWorkspaceTree()
      setTree(t)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => { load() }, [load])

  const readFile = useCallback((path: string) => client.readFile(path), [client])
  const writeFile = useCallback(
    async (path: string, content: string) => {
      await client.writeFile(path, content)
      load()
    },
    [client, load],
  )

  return { tree, loading, error, readFile, writeFile, refresh: load }
}
