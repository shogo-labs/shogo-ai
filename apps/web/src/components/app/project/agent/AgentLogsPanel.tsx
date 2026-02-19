/**
 * AgentLogsPanel
 *
 * Shows agent activity logs: heartbeat results, channel messages,
 * errors, and general activity from the console-log endpoint.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ScrollText, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AgentLogsPanelProps {
  projectId: string
  visible: boolean
}

export function AgentLogsPanel({ projectId, visible }: AgentLogsPanelProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadLogs = useCallback(async () => {
    try {
      const sandboxRes = await fetch(`/api/projects/${projectId}/sandbox/url`)
      if (!sandboxRes.ok) return
      const sandboxData = await sandboxRes.json()
      const baseUrl = sandboxData.agentUrl || sandboxData.url

      const res = await fetch(`${baseUrl}/console-log`)
      if (!res.ok) return
      const data = await res.json()
      setLogs(data.logs || [])
      setError(null)
    } catch (err: any) {
      if (!error) setError(err.message)
    }
  }, [projectId, error])

  useEffect(() => {
    if (visible) {
      setIsLoading(true)
      loadLogs().finally(() => setIsLoading(false))
    }
  }, [visible, loadLogs])

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (visible && autoRefresh) {
      intervalRef.current = setInterval(loadLogs, 5000)
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [visible, autoRefresh, loadLogs])

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Agent Logs</span>
        <span className="text-xs text-muted-foreground">
          {logs.length} entries
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh
          </label>
          <button
            onClick={() => setLogs([])}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title="Clear logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={loadLogs}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-zinc-950 p-4 font-mono text-xs">
        {isLoading ? (
          <div className="text-zinc-500 text-center py-8">Loading logs...</div>
        ) : logs.length === 0 ? (
          <div className="text-zinc-500 text-center py-8">
            No logs yet. Start the agent to see activity.
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="text-zinc-300 py-0.5 whitespace-pre-wrap break-all">
              {log}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
